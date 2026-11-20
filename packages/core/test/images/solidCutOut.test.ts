import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';
import { isSolidCutOut } from '../../src/images/solidCutOut.js';

const SIZE = 200;

/** A transparent raster with the pixels for which `shows` holds painted (in a luminance that varies with the place). */
function cutOut(shows: (x: number, y: number) => boolean, shade: (x: number, y: number) => number = (x, y) => (x * 3 + y * 5) % 200): DecodedImage {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!shows(x, y)) continue;
      const at = (y * SIZE + x) * 4;
      const l = shade(x, y);
      rgba[at] = l;
      rgba[at + 1] = l;
      rgba[at + 2] = l;
      rgba[at + 3] = 255;
    }
  }
  return { width: SIZE, height: SIZE, rgba };
}

describe('isSolidCutOut', () => {
  it('takes a figure standing in a tall box (one piece, much of what shows) for one', () => {
    // A body with a head: a third of the box, one piece.
    const figure = cutOut((x, y) => (Math.abs(x - 100) < 30 && y > 40 && y < 190) || Math.hypot(x - 100, y - 25) < 15);
    expect(isSolidCutOut(figure)).toBe(true);
  });

  it('does not take a splatter (a blot with drops thrown round it) for one', () => {
    const splatter = cutOut((x, y) => Math.hypot(x - 100, y - 100) < 25 || (x % 23 < 3 && y % 19 < 3));
    expect(isSolidCutOut(splatter)).toBe(false);
  });

  it('does not take a sparse spray, nor an even shadow, for one', () => {
    expect(isSolidCutOut(cutOut((x, y) => (x + y) % 9 === 0 && x % 4 === 0))).toBe(false);
    expect(isSolidCutOut(cutOut((x, y) => Math.hypot(x - 100, y - 100) < 60, () => 90))).toBe(false);
  });
});
