import { describe, expect, it } from 'vitest';
import { computeCentreDetail } from '../../src/images/finalize.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function picture(luminance: (x: number, y: number) => number): DecodedImage {
  const width = 400;
  const height = 520;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const l = luminance(x, y);
      rgba[at] = l;
      rgba[at + 1] = l;
      rgba[at + 2] = l;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

describe('computeCentreDetail', () => {
  it('is high for a subject in the middle (a lit building in the dark)', () => {
    expect(computeCentreDetail(picture((x, y) => (x > 150 && x < 250 && y > 150 && y < 380 ? 60 : 8)))).toBeGreaterThan(10);
  });

  it('is low for a dark vignette (light edges round an even middle) and for fine stars', () => {
    expect(computeCentreDetail(picture((x, y) => 10 + Math.max(0, 40 - Math.min(x, y, 399 - x, 519 - y))))).toBeLessThan(1);
    expect(computeCentreDetail(picture((x, y) => ((x * 7 + y * 13) % 97 === 0 ? 200 : 10)))).toBeLessThan(3);
  });
});
