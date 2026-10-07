import { describe, expect, it } from 'vitest';
import { brightenCroppedImage, type BrightenOptions } from '../../src/images/brightenImage.js';

/** Builds a single-color image (all pixels identical) — the lower percentile = that value, regardless of the percentile. */
function solidImage(gray: number, count = 100): { width: number; height: number; rgba: Uint8ClampedArray } {
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return { width: count, height: 1, rgba };
}

/** `contrastFactor: 1` = the contrast step has no effect, so the level/gamma tests don't have to care about the third step. */
const NEUTRAL_CONTRAST: Pick<BrightenOptions, 'contrastFactor' | 'contrastPivot'> = { contrastFactor: 1, contrastPivot: 128 };

describe('brightenCroppedImage', () => {
  it('brightens the middle values', () => {
    const image = solidImage(150);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThan(150);
    expect(out.rgba[3]!).toBe(255); // alpha unchanged
  });

  it('[a problem measured live, "the brightening doesn\'t work" on a portrait with a near-black vignette] lifts a TRUE black (0) to around targetFloor', () => {
    const image = solidImage(0);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThan(60); // gamma<1 lifts it slightly higher than targetFloor alone
  });

  it('white stays white (the stretch and gamma no longer blow out the bright parts)', () => {
    const image = solidImage(255);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBe(255);
    expect(out.rgba[3]!).toBe(255);
  });

  it('[the core of the fix] an image with a VERY dark bottom (a percentile close to 0) gets a LARGER brightening than an image whose bottom is already moderately bright — one `targetFloor` doesn\'t mean the same shift for both', () => {
    const nearBlackFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([5, 5, 5, 255, 200, 200, 200, 255]) };
    const moderateFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([21, 21, 21, 255, 200, 200, 200, 255]) };
    const opts = { targetFloor: 75, floorPercentile: 0.5, gamma: 0.95, ...NEUTRAL_CONTRAST };
    const outNearBlack = brightenCroppedImage(nearBlackFloor, opts);
    const outModerate = brightenCroppedImage(moderateFloor, opts);
    // Both start from the same "high" pixel (200) — we compare the SHIFT of their own lower percentile.
    const shiftNearBlack = outNearBlack.rgba[0]! - 5;
    const shiftModerate = outModerate.rgba[0]! - 21;
    expect(shiftNearBlack).toBeGreaterThan(shiftModerate);
  });

  it('when targetFloor equals the image\'s OWN lower percentile, gamma=1 and contrast neutral, the transformation is an identity', () => {
    const image = solidImage(100); // uniform image -> lower percentile = 100 for any threshold
    const out = brightenCroppedImage(image, { targetFloor: 100, floorPercentile: 0.5, gamma: 1, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBe(100);
  });

  it('[safeguard] an image whose own lower percentile is ALREADY brighter than targetFloor is not darkened (e.g. a bright scene without deep shadows)', () => {
    const brightFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([120, 120, 120, 255, 220, 220, 220, 255]) };
    const out = brightenCroppedImage(brightFloor, { targetFloor: 75, floorPercentile: 0.5, gamma: 1, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThanOrEqual(120); // never darker than the original
  });

  it('[user report, "it is quite bright now, but it lost some contrast"] contrastFactor>1 pushes values BELOW the pivot further apart than contrastFactor=1 (a growing spread of the shadows, not a flat result of the stretch)', () => {
    const shadow = { width: 1, height: 1, rgba: new Uint8ClampedArray([60, 60, 60, 255]) };
    const darkerShadow = { width: 1, height: 1, rgba: new Uint8ClampedArray([40, 40, 40, 255]) };
    const flat = { targetFloor: 0, floorPercentile: 0, gamma: 1, contrastFactor: 1, contrastPivot: 150 };
    const punchy = { targetFloor: 0, floorPercentile: 0, gamma: 1, contrastFactor: 1.25, contrastPivot: 150 };
    const gapFlat = brightenCroppedImage(shadow, flat).rgba[0]! - brightenCroppedImage(darkerShadow, flat).rgba[0]!;
    const gapPunchy = brightenCroppedImage(shadow, punchy).rgba[0]! - brightenCroppedImage(darkerShadow, punchy).rgba[0]!;
    expect(gapPunchy).toBeGreaterThan(gapFlat);
  });

  it('preserves the image dimensions and doesn\'t modify the input in place', () => {
    const image = { width: 3, height: 2, rgba: new Uint8ClampedArray(3 * 2 * 4).fill(50) };
    const original = Array.from(image.rgba);
    const out = brightenCroppedImage(image);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(Array.from(image.rgba)).toEqual(original);
  });
});
