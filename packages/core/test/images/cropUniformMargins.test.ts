import { describe, expect, it } from 'vitest';
import { cropDecodedImage, detectContentBounds } from '../../src/images/cropUniformMargins.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A canvas filled with a single background color — a synthetic "empty page/margin". */
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

/** Fills the rectangle [x,y,w,h] with a CHECKERBOARD of two contrasting colors — simulates a "real illustration" (high local variance, not uniform). */
function paintNoisyRect(image: DecodedImage, x: number, y: number, w: number, h: number): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = (row * image.width + col) * 4;
      const on = (row + col) % 2 === 0;
      image.rgba[i] = on ? 20 : 230;
      image.rgba[i + 1] = on ? 40 : 60;
      image.rgba[i + 2] = on ? 60 : 20;
      image.rgba[i + 3] = 255;
    }
  }
}

describe('detectContentBounds — [at the user\'s request] cropping the empty margin around a small illustration', () => {
  it('a small checkerboard "illustration" in the corner of a large uniform background -> the detected rectangle CLEARLY smaller than the whole canvas, contains the illustration', () => {
    const image = solidCanvas(400, 500, 230, 220, 200); // uniform beige "paper background"
    // [calibration] The illustration MUST occupy a large PART of the length of the row/column it
    // crosses — otherwise the "own mean" test (see the header of cropUniformMargins.ts) would dilute
    // it so that the whole row/column STILL looks "boring" relative to its own (already shifted)
    // mean. Measured directly: 100x120 in 400x500 (25%/24%) gave coverage exactly AT the threshold
    // (~0.75) and the test was unstable; 180x220 (45%/44%) gives an unambiguous separation.
    paintNoisyRect(image, 110, 90, 180, 220); // a "portrait", doesn't touch any edge
    const bounds = detectContentBounds(image);
    expect(bounds).not.toBeNull();
    const b = bounds!;
    // The detected rectangle MUST contain the whole painted illustration...
    expect(b.x).toBeLessThanOrEqual(110);
    expect(b.y).toBeLessThanOrEqual(90);
    expect(b.x + b.width).toBeGreaterThanOrEqual(290);
    expect(b.y + b.height).toBeGreaterThanOrEqual(310);
    // ...but be CLEARLY smaller than the whole canvas (400x500=200000) — the main goal of the crop.
    expect(b.width * b.height).toBeLessThan(400 * 500 * 0.6);
  });

  it('[safeguard] content filling the canvas almost to the edge (e.g. a spread for full bleed) -> null, does NOT crop', () => {
    const image = solidCanvas(400, 500, 40, 30, 20);
    paintNoisyRect(image, 2, 2, 396, 496); // an "illustration" covering almost the whole page, 2px margin
    expect(detectContentBounds(image)).toBeNull();
  });

  it('[safeguard] the whole canvas uniform (no content at all) -> null, does NOT crop down to a meaningless sliver', () => {
    const image = solidCanvas(400, 500, 230, 220, 200);
    expect(detectContentBounds(image)).toBeNull();
  });

  it('[a differently colored decorative frame] a uniform dark strip on the left + a uniform light "paper" in the middle (two DIFFERENT zones) still correctly crops to the central illustration', () => {
    // Reproduces exactly a layout reported from a real rulebook: a dark "leather" strip on the left
    // (a different color than the "paper"), with a portrait somewhere in the middle of the light
    // zone. The test exists because a reference from ONE global color (e.g. from a corner) would
    // fail here — see the rationale in cropUniformMargins.ts.
    const image = solidCanvas(400, 500, 230, 220, 200);
    for (let y = 0; y < 500; y++) {
      for (let x = 0; x < 40; x++) {
        const i = (y * 400 + x) * 4;
        image.rgba[i] = 50;
        image.rgba[i + 1] = 35;
        image.rgba[i + 2] = 25;
      }
    }
    // [calibration, see the test above] 200x220 (50%/44%), positioned away from the strip (x>=150),
    // to clearly exceed the coverage threshold.
    paintNoisyRect(image, 150, 150, 200, 220);

    const bounds = detectContentBounds(image);
    expect(bounds).not.toBeNull();
    const b = bounds!;
    expect(b.x).toBeLessThanOrEqual(150);
    expect(b.x + b.width).toBeGreaterThanOrEqual(350);
    expect(b.width * b.height).toBeLessThan(400 * 500 * 0.7);
  });
});

describe('cropDecodedImage', () => {
  it('cuts out exactly the given rectangle, pixel by pixel', () => {
    const image = solidCanvas(10, 10, 0, 0, 0);
    paintNoisyRect(image, 3, 3, 2, 2);
    const cropped = cropDecodedImage(image, { x: 3, y: 3, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    // Corner (3,3) in the original corresponds to (0,0) in the crop.
    const origIdx = (3 * 10 + 3) * 4;
    expect([cropped.rgba[0], cropped.rgba[1], cropped.rgba[2]]).toEqual([image.rgba[origIdx], image.rgba[origIdx + 1], image.rgba[origIdx + 2]]);
  });
});
