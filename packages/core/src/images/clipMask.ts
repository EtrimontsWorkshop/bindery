import type { Matrix } from '../geometry.js';
import type { ClipInfo, ClipPath } from '../inventory/clipPaths.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Applies the clipping paths a picture was painted under to its raw pixels: what the clips hide becomes transparent
 * and the result is cropped to what is left. The raw resource of a picture painted under a clip is the whole
 * sheet — with the neighbor of the figure that the page cuts away — and the clip is the only record of what the
 * page shows.
 */

/** Polygons of a clip path in pixel coordinates of an image of `width` x `height` painted with `ctm`; null when the CTM is singular. */
function toPixelPolygons(path: ClipPath, ctm: Matrix, width: number, height: number): number[][] | null {
  const [a, b, c, d, e, f] = ctm;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return path.map((polygon) => {
    const out: number[] = [];
    for (let i = 0; i < polygon.length; i += 2) {
      const dx = polygon[i]! - e;
      const dy = polygon[i + 1]! - f;
      const u = (d * dx - c * dy) / det;
      const v = (-b * dx + a * dy) / det;
      out.push(u * width, (1 - v) * height);
    }
    return out;
  });
}

/** Marks in `mask` (1 = inside) the pixels whose centers lie inside the polygons, even-odd, scanline by scanline. */
function fillPolygons(polygons: readonly number[][], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (const polygon of polygons) {
      const n = polygon.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = polygon[2 * i + 1]!;
        const yj = polygon[2 * j + 1]!;
        if (yi > yc !== yj > yc) {
          const xi = polygon[2 * i]!;
          const xj = polygon[2 * j]!;
          xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/**
 * `image` with everything outside the clips made transparent, cropped to the visible part. Returns `image` itself
 * when the clips cannot be applied (singular CTM) or leave nothing.
 */
/** A picture is a drawing on white paper when at least this share of its pixels is near white. */
const PAPER_DRAWING_MIN_WHITE_SHARE = 0.5;
const PAPER_MIN_CHANNEL = 225;

/** Whether most of `image` is white paper (a sketch or a drawing on a white sheet). Sampled on a grid of at most ~250k points. */
function isDrawingOnPaper(image: DecodedImage): boolean {
  const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / 250_000)));
  let n = 0;
  let white = 0;
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const i = (y * image.width + x) * 4;
      n++;
      if (image.rgba[i + 3]! >= 16 && Math.min(image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!) >= PAPER_MIN_CHANNEL) white++;
    }
  }
  return n > 0 && white >= PAPER_DRAWING_MIN_WHITE_SHARE * n;
}

/** Pixels (1 = inside) that all the paths of `clip` let through, or null when the CTM is singular or there is no path. */
function maskOfClip(clip: Pick<ClipInfo, 'paths' | 'ctm'>, width: number, height: number): Uint8Array | null {
  let combined: Uint8Array | null = null;
  for (const path of clip.paths) {
    const polygons = toPixelPolygons(path, clip.ctm, width, height);
    if (polygons === null) return null;
    const mask = fillPolygons(polygons, width, height);
    if (combined === null) combined = mask;
    else for (let i = 0; i < combined.length; i++) combined[i] = combined[i]! & mask[i]!;
  }
  return combined;
}

/** Clears every piece of `mask` (4-connected) but the largest one. */
function keepLargestPiece(mask: Uint8Array, width: number, height: number): void {
  const label = new Int32Array(width * height);
  const stack: number[] = [];
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let size = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack.push(p - 1); }
      if (x < width - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack.push(p + 1); }
      if (p >= width && mask[p - width] && !label[p - width]) { label[p - width] = next; stack.push(p - width); }
      if (p < width * (height - 1) && mask[p + width] && !label[p + width]) { label[p + width] = next; stack.push(p + width); }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  for (let i = 0; i < mask.length; i++) if (mask[i] && label[i] !== best) mask[i] = 0;
}

export function applyClipToImage(image: DecodedImage, clip: Pick<ClipInfo, 'paths' | 'ctm'>, options: { hiddenBecomesPaper?: boolean; holes?: readonly Pick<ClipInfo, 'paths' | 'ctm'>[] } = {}): DecodedImage {
  const { width, height } = image;
  if (width <= 0 || height <= 0 || clip.paths.length === 0) return image;
  const combined = maskOfClip(clip, width, height);
  if (combined === null) return image;
  // What other pictures painted over this one cover is not shown of it either.
  for (const hole of options.holes ?? []) {
    const covered = maskOfClip(hole, width, height);
    if (covered !== null) for (let i = 0; i < combined.length; i++) if (covered[i]) combined[i] = 0;
  }
  // Cutting other pictures out can leave slivers of the picture that stick out from behind them: only the largest piece is its visible part.
  if ((options.holes?.length ?? 0) > 0) keepLargestPiece(combined, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (combined[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return image;

  let outW = maxX - minX + 1;
  let outH = maxY - minY + 1;
  // A photo pinned to the page at a slight angle is cut by a tilted quadrilateral; the largest upright rectangle inside it is the picture without
  // the skewed edge and the transparent corners. A silhouette (a figure, a torn shape) has no rectangle of that size inside it and keeps its cut.
  let visible = 0;
  let seeThrough = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!combined[y * width + x]) continue;
      visible++;
      if (image.rgba[(y * width + x) * 4 + 3]! < OPAQUE_MIN_ALPHA) seeThrough++;
    }
  }
  // Only a picture that fills its frame (a photo) is trimmed: a figure cut out on a transparent ground has parts of itself in the corners of the frame.
  if (visible < NEAR_SOLID_MIN_FILL * outW * outH && seeThrough <= MAX_SEE_THROUGH_SHARE * visible) {
    const inner = largestRectangleIn(combined, width, minX, minY, maxX, maxY);
    if (inner !== null && (inner.maxX - inner.minX + 1) * (inner.maxY - inner.minY + 1) >= INSCRIBED_MIN_SHARE * visible) {
      minX = inner.minX;
      minY = inner.minY;
      maxX = inner.maxX;
      maxY = inner.maxY;
      outW = maxX - minX + 1;
      outH = maxY - minY + 1;
    }
  }
  const hiddenBecomesPaper = options.hiddenBecomesPaper === true && isDrawingOnPaper(image);
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const src = (minY + y) * width + (minX + x);
      const dst = (y * outW + x) * 4;
      if (!combined[src]) {
        // A drawing on white paper that the page multiplies over its background shows nothing where white lies, so what the clip hides can be white paper: a
        // transparent polygon with a hard edge in its place means nothing off the page.
        if (hiddenBecomesPaper) rgba.fill(255, dst, dst + 4);
        continue;
      }
      rgba[dst] = image.rgba[src * 4]!;
      rgba[dst + 1] = image.rgba[src * 4 + 1]!;
      rgba[dst + 2] = image.rgba[src * 4 + 2]!;
      rgba[dst + 3] = image.rgba[src * 4 + 3]!;
    }
  }
  return { width: outW, height: outH, rgba };
}

/** Share of its bounding box that the visible part must fill for the cut to count as already (nearly) a rectangle and be left as it is. */
const NEAR_SOLID_MIN_FILL = 0.97;
/** Share of the visible area that the largest upright rectangle inside it must take for the picture to be cut to that rectangle. */
const INSCRIBED_MIN_SHARE = 0.9;
/** A pixel with at least this alpha counts as opaque; a picture with more than this share of see-through pixels in its frame is a cut-out figure. */
const OPAQUE_MIN_ALPHA = 250;
const MAX_SEE_THROUGH_SHARE = 0.02;

/** The largest axis-aligned rectangle that lies wholly in `mask` (1 = inside) within the given bounds, or null when there is none. */
function largestRectangleIn(mask: Uint8Array, stride: number, minX: number, minY: number, maxX: number, maxY: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const w = maxX - minX + 1;
  const heights = new Int32Array(w);
  let best = 0;
  let found: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  const stack: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = 0; x < w; x++) heights[x] = mask[y * stride + minX + x] ? heights[x]! + 1 : 0;
    stack.length = 0;
    for (let x = 0; x <= w; x++) {
      const h = x === w ? 0 : heights[x]!;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! >= h) {
        const height = heights[stack.pop()!]!;
        const left = stack.length === 0 ? 0 : stack[stack.length - 1]! + 1;
        const area = height * (x - left);
        if (area > best) {
          best = area;
          found = { minX: minX + left, minY: y - height + 1, maxX: minX + x - 1, maxY: y };
        }
      }
      stack.push(x);
    }
  }
  return found;
}

/** Rectangle (page space) that a clip path is exactly, or null when it is anything else. */
function axisAlignedRectOf(path: ClipPath): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (path.length !== 1) return null;
  const polygon = path[0]!;
  const pointCount = polygon.length / 2;
  if (pointCount < 4 || pointCount > 5) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < polygon.length; i += 2) {
    xs.push(polygon[i]!);
    ys.push(polygon[i + 1]!);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const tolerance = 0.5;
  const onEdge = xs.every((x, i) => (Math.abs(x - minX) <= tolerance || Math.abs(x - maxX) <= tolerance) && (Math.abs(ys[i]! - minY) <= tolerance || Math.abs(ys[i]! - maxY) <= tolerance));
  return onEdge && maxX - minX > tolerance && maxY - minY > tolerance ? { minX, minY, maxX, maxY } : null;
}

/** Share of its bounding box that a clip polygon must fill (a frame tilted by a degree or two, or with rounded corners) to count as a rectangle. */
const NEAR_RECTANGLE_MIN_FILL = 0.9;

/** The bounding box of a clip that is one polygon filling nearly all of it (a slightly tilted or rounded window), or null. */
function nearRectangleOf(path: ClipPath): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (path.length !== 1) return null;
  const polygon = path[0]!;
  const n = polygon.length / 2;
  if (n < 4) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let twiceArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x = polygon[2 * i]!;
    const y = polygon[2 * i + 1]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    twiceArea += polygon[2 * j]! * y - x * polygon[2 * j + 1]!;
  }
  const boxArea = (maxX - minX) * (maxY - minY);
  return boxArea > 0 && Math.abs(twiceArea) / 2 >= NEAR_RECTANGLE_MIN_FILL * boxArea ? { minX, minY, maxX, maxY } : null;
}

/** Share of the window that may lie outside the picture (interpolation at the edge) for the window to count as inside it. */
const MAX_OUTSIDE_SHARE = 0.02;

/** How far (relative) the CTM's axes may stray from the page's axes for the picture to count as upright. */
const UPRIGHT_TOLERANCE = 0.02;

/** Share of a turned picture's footprint on the page that a clip must cover for the page to show the whole picture (the clip is the picture's own outline or the page, not a frame cut out of it). */
const WHOLE_PICTURE_MIN_COVERAGE = 0.9;
/** How far (degrees) a picture may be turned from upright to count as askew rather than turned by a quarter or half turn. */
const MAX_ASKEW_DEG = 15;

/**
 * Whether the page shows the whole of a picture that it paints turned (a scan laid slightly askew, its outline or the page's edge as the clip): one
 * clip polygon that covers most of the picture's footprint is not a frame cut out of the picture. The raw pixels are then the picture as it was
 * drawn (straight), and cutting them to the clip would only trim their edge and leave transparent corners.
 */
export function clipShowsWholePicture(clip: Pick<ClipInfo, 'paths' | 'ctm'>): boolean {
  const [a, b, c, d] = clip.ctm;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12 || clip.paths.length !== 1 || clip.paths[0]!.length !== 1) return false;
  const scale = Math.max(Math.abs(a), Math.abs(d), 1e-9);
  if (Math.abs(b) <= UPRIGHT_TOLERANCE * scale && Math.abs(c) <= UPRIGHT_TOLERANCE * scale) return false;
  // Only a picture that is slightly askew: one that is turned by a quarter or half turn is turned upright by its raw pixels' own rotation.
  if (Math.abs((Math.atan2(b, a) * 180) / Math.PI) > MAX_ASKEW_DEG) return false;
  const polygon = clip.paths[0]![0]!;
  const n = polygon.length / 2;
  let twiceArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) twiceArea += polygon[2 * j]! * polygon[2 * i + 1]! - polygon[2 * i]! * polygon[2 * j + 1]!;
  return Math.abs(twiceArea) / 2 >= WHOLE_PICTURE_MIN_COVERAGE * Math.abs(det);
}

/**
 * A picture that the page turns (any angle) and shows through a window that is a plain rectangle: the page's own look of it
 * is the window, upright, with the picture turned inside. The raw pixels are in the picture's own orientation, so cutting
 * the window out of them gives a tilted frame with transparent corners. This samples the raw pixels through the window
 * instead, at the raw resolution, as the page shows them. Returns null when it does not apply: the picture is not turned, the
 * clip is not one rectangle, or the CTM is singular — the caller then uses `applyClipToImage`.
 */
export function renderThroughRectangularClip(image: DecodedImage, clip: Pick<ClipInfo, 'paths' | 'ctm'>): DecodedImage | null {
  const { width, height } = image;
  const [a, b, c, d, e, f] = clip.ctm;
  const det = a * d - b * c;
  if (width <= 0 || height <= 0 || clip.paths.length === 0 || !Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const scale = Math.max(Math.abs(a), Math.abs(d), 1e-9);
  if (Math.abs(b) <= UPRIGHT_TOLERANCE * scale && Math.abs(c) <= UPRIGHT_TOLERANCE * scale) return null;
  if (det < 0 || clipShowsWholePicture(clip)) return null;

  let window: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const path of clip.paths) {
    const rect = axisAlignedRectOf(path) ?? nearRectangleOf(path);
    if (rect === null) return null;
    window = window === null ? rect : { minX: Math.max(window.minX, rect.minX), minY: Math.max(window.minY, rect.minY), maxX: Math.min(window.maxX, rect.maxX), maxY: Math.min(window.maxY, rect.maxY) };
  }
  if (window === null || window.maxX - window.minX < 1 || window.maxY - window.minY < 1) return null;

  // Raw pixels per page point along the picture's own width.
  const pxPerPt = width / Math.hypot(a, b);
  const outW = Math.round((window.maxX - window.minX) * pxPerPt);
  const outH = Math.round((window.maxY - window.minY) * pxPerPt);
  if (outW < 1 || outH < 1 || outW * outH > 64_000_000) return null;

  const rgba = new Uint8ClampedArray(outW * outH * 4);
  let outside = 0;
  for (let oy = 0; oy < outH; oy++) {
    const py = window.maxY - (oy + 0.5) / pxPerPt;
    for (let ox = 0; ox < outW; ox++) {
      const px = window.minX + (ox + 0.5) / pxPerPt;
      const dx = px - e;
      const dy = py - f;
      const u = ((d * dx - c * dy) / det) * width - 0.5;
      const v = (1 - (-b * dx + a * dy) / det) * height - 0.5;
      if (u < -0.5 || v < -0.5 || u > width - 0.5 || v > height - 0.5) {
        outside++;
        continue;
      }
      // Bilinear sample, edge pixels repeated.
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(u)));
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(v)));
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, u - x0));
      const fy = Math.min(1, Math.max(0, v - y0));
      const dst = (oy * outW + ox) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = image.rgba[(y0 * width + x0) * 4 + ch]! * (1 - fx) + image.rgba[(y0 * width + x1) * 4 + ch]! * fx;
        const bottom = image.rgba[(y1 * width + x0) * 4 + ch]! * (1 - fx) + image.rgba[(y1 * width + x1) * 4 + ch]! * fx;
        rgba[dst + ch] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  // The window must lie inside the picture: where it reaches past it, the page shows a tilted picture on a page, not a cut of a picture, and the raw upright picture is the better import.
  if (outside > MAX_OUTSIDE_SHARE * outW * outH) return null;
  return { width: outW, height: outH, rgba };
}
