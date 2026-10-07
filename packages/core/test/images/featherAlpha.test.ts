import { describe, expect, it } from 'vitest';
import { featherAlpha } from '../../src/images/featherAlpha.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A flat `width x height` image, constant RGB, alpha according to `alphaAt(x,y)`. */
function buildImage(width: number, height: number, alphaAt: (x: number, y: number) => number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 10;
      rgba[idx + 1] = 20;
      rgba[idx + 2] = 30;
      rgba[idx + 3] = alphaAt(x, y);
    }
  }
  return { width, height, rgba };
}

function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}

describe('featherAlpha', () => {
  it('radius=0 -> an unchanged copy', () => {
    const image = buildImage(4, 4, () => 128);
    const result = featherAlpha(image, 0);
    expect(Array.from(result.rgba)).toEqual(Array.from(image.rgba));
    expect(result.rgba).not.toBe(image.rgba);
  });

  it('uniform alpha (all 0 or all 255) stays unchanged — blurring a uniform area gives the same area', () => {
    const opaque = buildImage(20, 20, () => 255);
    const blurredOpaque = featherAlpha(opaque, 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(blurredOpaque, x, y)).toBe(255);

    const transparent = buildImage(20, 20, () => 0);
    const blurredTransparent = featherAlpha(transparent, 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(blurredTransparent, x, y)).toBe(0);
  });

  it('the RGB channels are never touched, only alpha', () => {
    const image = buildImage(10, 10, (x) => (x < 5 ? 0 : 255));
    const result = featherAlpha(image, 2);
    for (let i = 0; i < result.rgba.length; i += 4) {
      expect(result.rgba[i]).toBe(10);
      expect(result.rgba[i + 1]).toBe(20);
      expect(result.rgba[i + 2]).toBe(30);
    }
  });

  it('a sharp edge (a 0->255 jump) gets a symmetric, smooth transition of a width of ~2*radius around the boundary, staying hard far from it', () => {
    const width = 40;
    const image = buildImage(width, 1, (x) => (x < 20 ? 0 : 255));
    const radius = 3;
    const result = featherAlpha(image, radius);

    // Far from the boundary (outside the radius band) — unchanged.
    expect(alphaAt(result, 0, 0)).toBe(0);
    expect(alphaAt(result, width - 1, 0)).toBe(255);

    // Exactly at the boundary (x=20, the first "255" pixel) — a window of width 2*radius+1 centered on
    // x=20 covers x=17..23: 3 "0" pixels (17,18,19) and 4 "255" pixels (20,21,22,23) -> mean = 4/7*255.
    const expectedAtBoundary = Math.round((4 / 7) * 255);
    expect(alphaAt(result, 20, 0)).toBe(expectedAtBoundary);

    // Symmetry: the pixel RIGHT BEFORE the boundary (x=19, the last "0") has the complementary share
    // (3/7 instead of 4/7) — the window 16..22 contains 4 "0" (16,17,18,19) and 3 "255" (20,21,22) ->
    // 3/7*255.
    const expectedJustBefore = Math.round((3 / 7) * 255);
    expect(alphaAt(result, 19, 0)).toBe(expectedJustBefore);

    // The transition is MONOTONICALLY increasing across the boundary band.
    const band = [17, 18, 19, 20, 21, 22, 23].map((x) => alphaAt(result, x, 0));
    for (let i = 1; i < band.length; i++) expect(band[i]!).toBeGreaterThanOrEqual(band[i - 1]!);
  });

  it('doesn\'t mutate the input', () => {
    const image = buildImage(6, 6, (x) => (x < 3 ? 0 : 255));
    const snapshot = image.rgba.slice();
    featherAlpha(image, 2);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});
