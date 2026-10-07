import { describe, expect, it } from 'vitest';
import { rotateAndCropImage } from '../../src/images/rotateCrop.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * A 20x20 black image with a white 3x3 block centered on (markerX,markerY) — deliberately a
 * BLOCK, not a single pixel: the center of a SYMMETRIC block stays exactly at the block's
 * geometric center REGARDLESS of the bilinear blur when sampling at an angle (unlike a single
 * pixel, whose "center" after blurring can shift by a fraction of a pixel depending on how the
 * sampling grid happens to fall relative to pixel boundaries — measured directly by the first
 * version of this test).
 */
function markerImage(markerX: number, markerY: number): DecodedImage {
  const width = 20;
  const height = 20;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = 255; // black, but opaque
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const idx = ((markerY + dy) * width + (markerX + dx)) * 4;
      rgba[idx] = 255;
      rgba[idx + 1] = 255;
      rgba[idx + 2] = 255;
      rgba[idx + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * The brightness-weighted MEAN position (centroid), in THE SAME convention as
 * `rotateAndCropImage`/`sampleBilinear` (an integer coordinate = the CENTER of the given pixel,
 * no "+0.5" — bilinear interpolation treats an integer coordinate as "exactly that pixel, no
 * blending"). The centroid (not a single brightest pixel) is robust to the blur from bilinear
 * interpolation at an angle/with a fractional shift.
 */
function findMarker(image: DecodedImage): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (y * image.width + x) * 4;
      const brightness = image.rgba[idx]! + image.rgba[idx + 1]! + image.rgba[idx + 2]!;
      sumX += x * brightness;
      sumY += y * brightness;
      sumWeight += brightness;
    }
  }
  return { x: sumX / sumWeight, y: sumY / sumWeight };
}

const CENTER = 10; // the center of the 20x20 source (geometrically at the continuous coordinate 10.0)

describe('rotateAndCropImage', () => {
  it('rotationRad=0, the same center and size -> reproduces the source 1:1 (identity)', () => {
    const source = markerImage(14, CENTER); // 4px to the right of the center
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0 });
    const marker = findMarker(result);
    expect(marker.x).toBeCloseTo(14, 1);
    expect(marker.y).toBeCloseTo(10, 1);
  });

  it('a 180° rotation -> the marker lands EXACTLY on the opposite side of the center (unambiguous regardless of the rotation direction)', () => {
    const source = markerImage(14, CENTER); // offset (+4, 0) from the center
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI });
    const marker = findMarker(result);
    // Expected offset: (-4, 0) from the output center (the same size).
    expect(marker.x).toBeCloseTo(6, 1);
    expect(marker.y).toBeCloseTo(10, 1);
  });

  it('a 90° rotation moves the marker by a quarter turn around the center, preserving the radius (the distance from the center)', () => {
    const source = markerImage(15, CENTER); // offset (+5, 0) from the center
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI / 2 });
    const marker = findMarker(result);
    const dx = marker.x - CENTER;
    const dy = marker.y - CENTER;
    // Radius preserved (rotation doesn't move the point closer to/farther from the center).
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 1);
    // [The convention of this function, verified directly by this test] `rotationRad=+90°` moves the
    // marker from "to the right of the center" to "above the center" (negative dy, dx ~0) — NOT
    // below. If integration with the UI (the drag direction of the rotation handle) turns out to be
    // reversed, the only fix is negating the angle in ONE place at the call site
    // (`renderRotatedRegion.ts`), not here.
    expect(dx).toBeCloseTo(0, 0);
    expect(dy).toBeLessThan(-4);
  });

  it('pixels outside the source sampled as transparent/black (no exception, no "wrapping")', () => {
    const source = markerImage(1, 1);
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 60, outputHeight: 60, rotationRad: 0.3 });
    expect(result.width).toBe(60);
    expect(result.height).toBe(60);
    // Corners far outside the original 20x20 source must be empty (alpha=0).
    const cornerIdx = (0 * 60 + 0) * 4;
    expect(result.rgba[cornerIdx + 3]).toBe(0);
  });

  it('the output size is rounded to integers and at least 1x1', () => {
    const source = markerImage(CENTER, CENTER);
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 0.4, outputHeight: 12.6, rotationRad: 0 });
    expect(result.width).toBe(1);
    expect(result.height).toBe(13);
  });

  describe('the scale parameter', () => {
    it('scale=1 given explicitly -> identical to omitting the field (the default behavior, a regression)', () => {
      const source = markerImage(15, CENTER);
      const withDefault = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0 });
      const withExplicit1 = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0, scale: 1 });
      expect(Array.from(withExplicit1.rgba)).toEqual(Array.from(withDefault.rgba));
    });

    it('scale=2 ZOOMS OUT (each output pixel = 2 source pixels) — the marker\'s offset in the output is HALF the offset in the source', () => {
      const source = markerImage(15, CENTER); // offset +5 from the center in the source
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0, scale: 2 });
      const marker = findMarker(result);
      expect(marker.x - CENTER).toBeCloseTo(2.5, 1);
      expect(marker.y - CENTER).toBeCloseTo(0, 1);
    });

    it('scale=0.5 ZOOMS IN (each output pixel = half a source pixel) — the marker\'s offset in the output is DOUBLED', () => {
      const source = markerImage(15, CENTER); // offset +5 from the center in the source
      const outCenter = 20; // output 40x40, its own center at 20
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 40, outputHeight: 40, rotationRad: 0, scale: 0.5 });
      const marker = findMarker(result);
      expect(marker.x - outCenter).toBeCloseTo(10, 1);
      expect(marker.y - outCenter).toBeCloseTo(0, 1);
    });

    it('scale and rotation commute (a uniform scaling) — combining 90° + scale=2 gives a SCALED radius, not only a rotated one', () => {
      const source = markerImage(15, CENTER); // offset +5 from the center in the source (radius 5)
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI / 2, scale: 2 });
      const marker = findMarker(result);
      const dx = marker.x - CENTER;
      const dy = marker.y - CENTER;
      // Radius 5/scale(2) = 2.5 — the same geometry as the "rotation by 90°" test above (there
      // scale=1, radius 5 unchanged), just scaled.
      expect(Math.hypot(dx, dy)).toBeCloseTo(2.5, 1);
      expect(dx).toBeCloseTo(0, 0);
      expect(dy).toBeLessThan(-2);
    });
  });
});
