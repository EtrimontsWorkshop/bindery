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
