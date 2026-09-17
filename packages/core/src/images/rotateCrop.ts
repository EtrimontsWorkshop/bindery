import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [user report, "Select and Crop" — the ability to rotate the selected
 * area] A pure, testable PIXEL function (zero canvas — works identically in
 * Node/tests and the browser, the same reason as
 * `normalizeDecodedImage.ts`/`brightenImage.ts`): for every OUTPUT pixel it
 * computes WHERE in the SOURCE image to take it from (INVERSE mapping —
 * "where in the source does this output pixel lie", not "where in the
 * output does this source pixel land" — the only way for EVERY output pixel
 * to be filled, with no holes, regardless of angle).
 *
 * `rotationRad` is the angle of the selection's OWN "width" axis (local
 * +X), measured in SOURCE IMAGE PIXEL space (Y down, as everywhere in
 * DOM/canvas) — the CALLER (see `renderRotatedRegion.ts`) computes it from
 * the REAL, already-transformed rectangle corners, never from a separate,
 * manually-inverted angle sign (the same reason as `pageOverlayGeometry.ts`:
 * "write ONE conversion function, use ONLY it" — here the equivalent is
 * "derive the angle from REAL points, never guess the sign").
 *
 * Bilinear interpolation (not nearest-neighbor) — any angle other than a
 * multiple of 90° would otherwise give visibly jagged edges on the final
 * image used as a scene/token.
 */
export interface RotateAndCropOptions {
  /** Center of the area being cut out, in SOURCE image PIXEL coordinates. */
  centerX: number;
  centerY: number;
  /** Target result dimensions in pixels (the selection size AFTER any scaling to the target resolution, BEFORE rotation). */
  outputWidth: number;
  outputHeight: number;
  /** Radians — see the comment on the function. */
  rotationRad: number;
  /**
   * [Step 42 Z2, "crop and zoom inside the token mask"] How many SOURCE
   * pixels correspond to ONE OUTPUT pixel — >1 ZOOMS OUT (more of the
   * source is visible, less detail per output pixel), <1 ZOOMS IN. Defaults
   * to 1 (no scale change) — FULL backward compatibility with prior
   * behavior (`renderRotatedRegion.ts` and all existing tests never zoom,
   * only crop+rotate at a 1:1 scale). Uniform scaling COMMUTES with
   * rotation (the same factor on both axes), so the order "scale then
   * rotate" and "rotate then scale" give identical results — applied BEFORE
   * the rotation below, zero extra algebra on the angle itself.
   */
  scale?: number;
}

function sampleBilinear(source: DecodedImage, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  const get = (xi: number, yi: number): [number, number, number, number] => {
    if (xi < 0 || yi < 0 || xi >= source.width || yi >= source.height) return [0, 0, 0, 0];
    const idx = (yi * source.width + xi) * 4;
    return [source.rgba[idx]!, source.rgba[idx + 1]!, source.rgba[idx + 2]!, source.rgba[idx + 3]!];
  };
  const c00 = get(x0, y0);
  const c10 = get(x1, y0);
  const c01 = get(x0, y1);
  const c11 = get(x1, y1);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const top = lerp(c00[i]!, c10[i]!, fx);
    const bottom = lerp(c01[i]!, c11[i]!, fx);
    out[i] = lerp(top, bottom, fy);
  }
  return out;
}

export function rotateAndCropImage(source: DecodedImage, opts: RotateAndCropOptions): DecodedImage {
  const outW = Math.max(1, Math.round(opts.outputWidth));
  const outH = Math.max(1, Math.round(opts.outputHeight));
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  const cos = Math.cos(opts.rotationRad);
  const sin = Math.sin(opts.rotationRad);
  const scale = opts.scale ?? 1;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      // [a live-measured bug in the first version] The output point relative
      // to the OUTPUT'S CENTER, in the selection's OWN ("unrotated") axes —
      // WITHOUT an extra "+0.5" (the old version mixed up the convention:
      // `sampleBilinear` (below) treats an INTEGER coordinate as "exactly
      // this pixel, zero blending" — adding an own "+0.5" here shifted EVERY
      // sample by half a pixel, which at `rotationRad=0` broke even the
      // simplest case, "same center and size" — instead of a clean identity
      // it produced a systematic, repeatable 0.5px offset, caught directly
      // by a unit test (`rotateCrop.test.ts`).
      const lx = (ox - outW / 2) * scale;
      const ly = (oy - outH / 2) * scale;
      // INVERSE mapping: rotate the local point by `rotationRad` to find its POSITION in the source image (this is EXACTLY the angle at which the selection's local "width" axis lies in the source).
      const sx = opts.centerX + lx * cos - ly * sin;
      const sy = opts.centerY + lx * sin + ly * cos;
      const [r, g, b, a] = sampleBilinear(source, sx, sy);
      const outIdx = (oy * outW + ox) * 4;
      rgba[outIdx] = r;
      rgba[outIdx + 1] = g;
      rgba[outIdx + 2] = b;
      rgba[outIdx + 3] = a;
    }
  }

  return { width: outW, height: outH, rgba };
}
