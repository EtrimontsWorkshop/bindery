import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [Step 42 Z1/Z2, "smooth the edges so there's no jagged silhouette"] Blurs
 * ONLY the alpha channel (RGB unchanged) — a separable box blur (a
 * horizontal pass, then a vertical pass on the first pass's result) instead
 * of a full square kernel: O(width*height*radius) instead of
 * O(width*height*radius^2), safe for images with millions of pixels.
 *
 * Shared by TWO places that would otherwise duplicate the SAME box blur:
 * `removeBackground.ts` (Z1, smooths the boundary between removed
 * background and preserved content) and `tokenMask.ts` (Z2, smooths the
 * hard geometric edge of a circle/rounded-square/hex mask).
 *
 * Far from any boundary, alpha is already uniform (0 or 255) — blurring a
 * uniform area doesn't change its value on its own (the average of all
 * zeros is zero, the average of all 255s is 255), so the effect is ONLY
 * visible in a narrow band around actual edges, with no need to separately
 * detect "where the boundary is".
 */
export function featherAlpha(image: DecodedImage, radiusPx: number): DecodedImage {
  const r = Math.round(radiusPx);
  if (r <= 0) return { width: image.width, height: image.height, rgba: image.rgba.slice() };
  const { width, height, rgba } = image;

  const alpha = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = rgba[i * 4 + 3]!;

  const horizontal = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xi = x + dx;
        if (xi < 0 || xi >= width) continue;
        sum += alpha[rowStart + xi]!;
        count++;
      }
      horizontal[rowStart + x] = sum / count;
    }
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yi = y + dy;
        if (yi < 0 || yi >= height) continue;
        sum += horizontal[yi * width + x]!;
        count++;
      }
      const idx = (y * width + x) * 4 + 3;
      out[idx] = Math.round(sum / count);
    }
  }

  return { width, height, rgba: out };
}
