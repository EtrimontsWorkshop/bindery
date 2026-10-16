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
export function applyClipToImage(image: DecodedImage, clip: Pick<ClipInfo, 'paths' | 'ctm'>): DecodedImage {
  const { width, height } = image;
  if (width <= 0 || height <= 0 || clip.paths.length === 0) return image;
  let combined: Uint8Array | null = null;
  for (const path of clip.paths) {
    const polygons = toPixelPolygons(path, clip.ctm, width, height);
    if (polygons === null) return image;
    const mask = fillPolygons(polygons, width, height);
    if (combined === null) combined = mask;
    else for (let i = 0; i < combined.length; i++) combined[i] = combined[i]! & mask[i]!;
  }
  if (combined === null) return image;

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

  const outW = maxX - minX + 1;
  const outH = maxY - minY + 1;
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const src = (minY + y) * width + (minX + x);
      const dst = (y * outW + x) * 4;
      if (!combined[src]) continue;
      rgba[dst] = image.rgba[src * 4]!;
      rgba[dst + 1] = image.rgba[src * 4 + 1]!;
      rgba[dst + 2] = image.rgba[src * 4 + 2]!;
      rgba[dst + 3] = image.rgba[src * 4 + 3]!;
    }
  }
  return { width: outW, height: outH, rgba };
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

/** Share of the window that may lie outside the picture (interpolation at the edge) for the window to count as inside it. */
const MAX_OUTSIDE_SHARE = 0.02;

/** How far (relative) the CTM's axes may stray from the page's axes for the picture to count as upright. */
const UPRIGHT_TOLERANCE = 0.02;

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
  if (det < 0) return null;

  let window: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const path of clip.paths) {
    const rect = axisAlignedRectOf(path);
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
