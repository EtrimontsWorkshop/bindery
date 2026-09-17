import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [Step 42 Z4, "sharpening — cheap, thrown in along the way"] A standard
 * unsharp mask: blur the image (box blur, small radius — catches ONLY high
 * frequencies/detail, not the overall composition), subtract the blurred
 * version from the original (what the blur "lost" = detail), add it back to
 * the original weighted by `amount`. Operates EXCLUSIVELY on R/G/B — alpha
 * (transparency from a mask/removed background) is untouched, just like
 * `brightenImage.ts`.
 *
 * [calibration, see RAPORT-KROK-42.md] Most noticeable on bitmap maps
 * scaled up (per the brief) — parameters tuned on portraits/illustrations
 * from `sample/ZewCthulhu-WRAK.pdf`.
 */

export interface SharpenOptions {
  /** Radius of the box blur used to detect detail (px). Larger = "coarser" sharpened detail. */
  radiusPx: number;
  /** Boost strength — 0 no change, typically 0.3-1.0. Higher = stronger effect, but also stronger halo/noise. */
  amount: number;
}

export const DEFAULT_SHARPEN: SharpenOptions = { radiusPx: 1, amount: 0.5 };

/** Separable box blur (horizontal pass, then vertical) ON THE R/G/B CHANNELS — alpha skipped. */
function boxBlurRgb(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Float64Array {
  const channels = 3;
  const src = new Float64Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    src[i * channels] = rgba[i * 4]!;
    src[i * channels + 1] = rgba[i * 4 + 1]!;
    src[i * channels + 2] = rgba[i * 4 + 2]!;
  }

  const horizontal = new Float64Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xi = x + dx;
        if (xi < 0 || xi >= width) continue;
        const idx = (y * width + xi) * channels;
        sumR += src[idx]!;
        sumG += src[idx + 1]!;
        sumB += src[idx + 2]!;
        count++;
      }
      const outIdx = (y * width + x) * channels;
      horizontal[outIdx] = sumR / count;
      horizontal[outIdx + 1] = sumG / count;
      horizontal[outIdx + 2] = sumB / count;
    }
  }

  const out = new Float64Array(src.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yi = y + dy;
        if (yi < 0 || yi >= height) continue;
        const idx = (yi * width + x) * channels;
        sumR += horizontal[idx]!;
        sumG += horizontal[idx + 1]!;
        sumB += horizontal[idx + 2]!;
        count++;
      }
      const outIdx = (y * width + x) * channels;
      out[outIdx] = sumR / count;
      out[outIdx + 1] = sumG / count;
      out[outIdx + 2] = sumB / count;
    }
  }
  return out;
}

export function sharpenImage(image: DecodedImage, opts: SharpenOptions = DEFAULT_SHARPEN): DecodedImage {
  const { width, height, rgba } = image;
  if (opts.radiusPx <= 0 || opts.amount <= 0) return { width, height, rgba: rgba.slice() };

  const blurred = boxBlurRgb(rgba, width, height, Math.round(opts.radiusPx));
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const original = rgba[i * 4 + c]!;
      const blur = blurred[i * 3 + c]!;
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(original + opts.amount * (original - blur))));
    }
    out[i * 4 + 3] = rgba[i * 4 + 3]!;
  }
  return { width, height, rgba: out };
}
