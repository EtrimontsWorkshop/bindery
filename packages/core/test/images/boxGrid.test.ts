import { describe, expect, it } from 'vitest';
import { looksLikeTrackOfBoxes } from '../../src/images/boxGrid.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function paper(width: number, height: number): DecodedImage {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function fill(image: DecodedImage, x: number, y: number, w: number, h: number, v: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) for (let c = 0; c < 3; c++) image.rgba[(yy * image.width + xx) * 4 + c] = v;
}

/** Boxes of one size, each an outline round a light or a dark inside, in `rows` rows. */
function boxes(columns: number, rows: number, size: number, gap: number, width = 800, height = 300): DecodedImage {
  const image = paper(width, height);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = 20 + c * (size + gap);
      const y = 20 + r * (size + gap);
      fill(image, x, y, size, size, 60);
      fill(image, x + 4, y + 4, size - 8, size - 8, r === 0 ? 250 : 120);
    }
  }
  return image;
}

describe('looksLikeTrackOfBoxes', () => {
  it('is true for two rows of ten boxes of one size', () => {
    expect(looksLikeTrackOfBoxes(boxes(10, 2, 70, 10))).toBe(true);
  });

  it('is false for a few boxes, for a picture with no boxes, and for a battle map made of a great many cells', () => {
    expect(looksLikeTrackOfBoxes(boxes(3, 1, 70, 10))).toBe(false);
    const flat = paper(800, 300);
    fill(flat, 100, 50, 500, 200, 90);
    expect(looksLikeTrackOfBoxes(flat)).toBe(false);
    expect(looksLikeTrackOfBoxes(boxes(40, 16, 18, 2, 820, 420))).toBe(false);
  });
});
