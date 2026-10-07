import { describe, expect, it } from 'vitest';
import { removeBackground, DEFAULT_REMOVE_BACKGROUND } from '../../src/images/removeBackground.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A flat, uniform canvas of the given RGB color (alpha=255 everywhere). */
function solidCanvas(width: number, height: number, r: number, g: number, b: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Paints the rectangle [x,y,w,h] on `image` (in place) with the given color. */
function paintRect(image: DecodedImage, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const idx = (row * image.width + col) * 4;
      image.rgba[idx] = r;
      image.rgba[idx + 1] = g;
      image.rgba[idx + 2] = b;
    }
  }
}

function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}
function rgbAt(image: DecodedImage, x: number, y: number): [number, number, number] {
  const idx = (y * image.width + x) * 4;
  return [image.rgba[idx]!, image.rgba[idx + 1]!, image.rgba[idx + 2]!];
}

describe('removeBackground', () => {
  it('a uniform background (the whole canvas one color, no content) -> exceeds the area limit, ABORTS and returns the original unchanged', () => {
    const image = solidCanvas(30, 30, 220, 210, 190);
    const result = removeBackground(image, { tolerance: 20, featherPx: 1, maxAreaFraction: 0.6 });
    expect(result.aborted).toBe(true);
    expect(result.removedFraction).toBeCloseTo(1, 5);
    expect(Array.from(result.image.rgba)).toEqual(Array.from(image.rgba));
  });

  it('a background + a content island NOT TOUCHING any corner -> the background removed (alpha 0), the content preserved (alpha 255), the content\'s RGB unchanged', () => {
    const image = solidCanvas(60, 60, 230, 225, 210);
    paintRect(image, 20, 20, 20, 20, 40, 60, 90); // the content is 400/3600=11% of the area, the background ~89% — MORE than the default 60% limit, `maxAreaFraction` raised in this test deliberately, to test the removal MECHANICS in isolation from the safeguard (which has its own dedicated test above)
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95 });
    expect(result.aborted).toBe(false);
    expect(result.removedFraction).toBeGreaterThan(0.85);
    expect(result.removedFraction).toBeLessThan(0.9);

    // Corners (the background) -> transparent.
    expect(alphaAt(result.image, 0, 0)).toBe(0);
    expect(alphaAt(result.image, 59, 59)).toBe(0);
    // The middle of the content island -> still opaque, color unchanged.
    expect(alphaAt(result.image, 30, 30)).toBe(255);
    expect(rgbAt(result.image, 30, 30)).toEqual([40, 60, 90]);
  });

  it('chained tolerance lets the flood spread through a GENTLE background gradient (each step small), but stops at a SHARP content edge', () => {
    const width = 50;
    const height = 50;
    const image = solidCanvas(width, height, 200, 200, 200);
    // A gentle horizontal gradient of the background: +1 per column, from 200 to 249 — every single
    // step (1) is MUCH smaller than the tolerance (10), but the sum across the whole width (49)
    // exceeds it by a wide margin — checks that the chained comparison (not against a fixed corner)
    // does NOT stop on it.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const shade = 200 + x;
        image.rgba[idx] = shade;
        image.rgba[idx + 1] = shade;
        image.rgba[idx + 2] = shade;
      }
    }
    // Real content: a sharp, high-contrast square in the middle (a SHARP edge, >> tolerance).
    paintRect(image, 20, 20, 10, 10, 10, 10, 10);

    const result = removeBackground(image, { tolerance: 10, featherPx: 0, maxAreaFraction: 0.98 });
    expect(result.aborted).toBe(false);
    // The whole gradient background strip removed all the way to the right edge (the x=49 corner is background too).
    expect(alphaAt(result.image, width - 1, 0)).toBe(0);
    // The content in the middle preserved.
    expect(alphaAt(result.image, 25, 25)).toBe(255);
  });

  it('featherPx > 0 gives an INTERMEDIATE (not 0/255) alpha value right at the boundary of the removed background', () => {
    const image = solidCanvas(40, 40, 230, 225, 210);
    paintRect(image, 15, 15, 10, 10, 20, 30, 40);
    const result = removeBackground(image, { tolerance: 15, featherPx: 3, maxAreaFraction: 0.95 });
    const boundaryAlpha = alphaAt(result.image, 15, 20); // left edge of the content island
    expect(boundaryAlpha).toBeGreaterThan(0);
    expect(boundaryAlpha).toBeLessThan(255);
  });

  it('doesn\'t mutate the input', () => {
    const image = solidCanvas(20, 20, 230, 225, 210);
    paintRect(image, 5, 5, 5, 5, 10, 10, 10);
    const snapshot = image.rgba.slice();
    removeBackground(image, DEFAULT_REMOVE_BACKGROUND);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });

  it('an empty image (0x0) doesn\'t blow up, returns without removing', () => {
    const image: DecodedImage = { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
    const result = removeBackground(image, DEFAULT_REMOVE_BACKGROUND);
    expect(result.aborted).toBe(false);
    expect(result.removedFraction).toBe(0);
  });

  /** A square "ring" of content (a contrasting color) on a uniform-colored background — it surrounds a pocket in the MIDDLE with the BACKGROUND color, completely cut off from the image edge (the same shape of problem as "a hat brim merging with the shoulder" from the report). */
  function ringWithEnclosedPocket(): DecodedImage {
    const image = solidCanvas(40, 40, 230, 225, 210);
    for (let y = 10; y <= 29; y++) {
      for (let x = 10; x <= 29; x++) {
        const isRing = x < 12 || x > 27 || y < 12 || y > 27;
        if (isRing) {
          const idx = (y * image.width + x) * 4;
          image.rgba[idx] = 10;
          image.rgba[idx + 1] = 10;
          image.rgba[idx + 2] = 10;
        }
      }
    }
    return image;
  }

  it('[click-to-add-background] a background pocket cut off from the edge by a closed ring of content is NOT removed by the flood from the corners alone', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95 });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 0, 0)).toBe(0); // the outer background removed
    expect(alphaAt(result.image, 20, 20)).toBe(255); // the pocket in the middle UNREACHABLE from any corner — untouched
    expect(rgbAt(result.image, 10, 20)).toEqual([10, 10, 10]); // the ring (content) preserved
  });

  it('[click-to-add-background] `extraSeeds` inside the pocket removes it without touching the surrounding ring of content', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95, extraSeeds: [{ x: 20, y: 20 }] });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 0, 0)).toBe(0); // the outer background still removed
    expect(alphaAt(result.image, 20, 20)).toBe(0); // the pocket NOW removed thanks to the extra click
    expect(rgbAt(result.image, 10, 20)).toEqual([10, 10, 10]); // the ring untouched in color
    expect(alphaAt(result.image, 10, 20)).toBe(255); // ...and opaque — the flood from inside the pocket stopped at the SHARP color jump of the ring
  });

  it('[click-to-add-background] the area limit is computed CUMULATIVELY — the corners + `extraSeeds` together exceed the limit, even though the flood from the corners ALONE would fit in it', () => {
    const image = ringWithEnclosedPocket();
    // Without the extra click: the outer background is (1600 - 400)/1600 = 75% of the area — already above 60% on its own, so we raise the limit so that the flood from the corners ALONE fits in it, but the sum with the pocket (another ~256/1600=16%) does not.
    const onlyCorners = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.99 });
    expect(onlyCorners.aborted).toBe(false);
    const tightLimit = onlyCorners.removedFraction + 0.05; // slightly above the flood from the corners ALONE — doesn't fit the additional pocket
    const withPocket = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: tightLimit, extraSeeds: [{ x: 20, y: 20 }] });
    expect(withPocket.aborted).toBe(true);
    expect(withPocket.removedFraction).toBeGreaterThan(onlyCorners.removedFraction);
    expect(Array.from(withPocket.image.rgba)).toEqual(Array.from(image.rgba)); // ABORTED -> the original unchanged
  });

  it('`extraSeeds` outside the image bounds are safely skipped (no error, no effect)', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95, extraSeeds: [{ x: -5, y: 500 }] });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 20, 20)).toBe(255); // the pocket untouched — the point outside the image had no effect
  });
});
