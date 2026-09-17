import type { DecodedImage } from './normalizeDecodedImage.js';
import { isInsideShape, type TokenMaskShape } from './tokenMask.js';

/**
 * [Step 42 Z3, "frames"] Two paths: a built-in solid ring (a few thickness
 * options, configurable color — "don't build a library of decorative
 * frames, that's graphic-design work" per the brief), and compositing with
 * the user's own uploaded frame (a transparent PNG/WebP the same size as
 * the token).
 */

export interface BuiltInFrameOptions {
  shape: TokenMaskShape;
  /** Ring thickness as a share of the canvas's radius/half-side (0-1). */
  thicknessNorm: number;
  color: readonly [number, number, number];
}

/**
 * A ring drawn JUST INSIDE the `shape`'s boundary — the band between the
 * shape's outer boundary (scale 1) and its INNER copy (scale
 * `1-thicknessNorm`). Testing "is the point inside the shrunken shape"
 * without separate geometry per shape: scaling the POINT by
 * `1/(1-thicknessNorm)` before the `isInsideShape` test is mathematically
 * equivalent to scaling the SHAPE ITSELF down (uniform scaling) — works
 * identically for all four shapes in `tokenMask.ts` with no extra algebra.
 * Overwrites RGB EXCLUSIVELY within the band (alpha untouched — the ring
 * only appears where the mask has already made a pixel visible).
 */
export function applyBuiltInFrame(image: DecodedImage, opts: BuiltInFrameOptions): DecodedImage {
  const { width, height, rgba } = image;
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const halfW = width / 2;
  const halfH = height / 2;
  const innerScale = 1 - opts.thicknessNorm;
  const [r, g, b] = opts.color;
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5 - halfH) / halfH;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - halfW) / halfW;
      if (!isInsideShape(opts.shape, nx, ny)) continue;
      const insideInner = innerScale > 0 && isInsideShape(opts.shape, nx / innerScale, ny / innerScale);
      if (insideInner) continue;
      const idx = (y * width + x) * 4;
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
    }
  }
  return { width, height, rgba: out };
}

/**
 * Standard Porter-Duff "source over destination" compositing: `frame` (the
 * user's own uploaded frame, a transparent PNG/WebP) OVER `image` (the
 * already-finished token) — BOTH MUST be the same size (the caller scales
 * the frame to the token's size BEFORE calling this, this function doesn't
 * do that — single responsibility).
 */
export function compositeCustomFrame(image: DecodedImage, frame: DecodedImage): DecodedImage {
  if (frame.width !== image.width || frame.height !== image.height) {
    throw new Error(`compositeCustomFrame: frame size (${frame.width}x${frame.height}) must match token size (${image.width}x${image.height})`);
  }
  const out = new Uint8ClampedArray(image.rgba.length);
  for (let i = 0; i < image.rgba.length; i += 4) {
    const srcA = frame.rgba[i + 3]! / 255;
    const dstA = image.rgba[i + 3]! / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round((frame.rgba[i + c]! * srcA + image.rgba[i + c]! * dstA * (1 - srcA)) / outA);
    }
    out[i + 3] = Math.round(outA * 255);
  }
  return { width: image.width, height: image.height, rgba: out };
}
