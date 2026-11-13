import { describe, expect, it } from 'vitest';
import { flattenOnWhite } from '../../src/images/whiteBackground.js';

const image = (pixels: number[][]) => ({ width: pixels.length, height: 1, rgba: new Uint8ClampedArray(pixels.flat()) });

describe('flattenOnWhite', () => {
  it('returns an opaque image as it is, anti-aliased edges included', () => {
    const opaque = image([
      [10, 20, 30, 255],
      [10, 20, 30, 250],
    ]);
    expect(flattenOnWhite(opaque)).toBe(opaque);
  });

  it('puts white under every pixel that is not fully opaque and leaves the source untouched', () => {
    const source = image([
      [10, 20, 30, 255],
      [0, 0, 0, 0],
      [0, 100, 200, 128],
      [50, 50, 50, 252],
    ]);
    const flat = flattenOnWhite(source);
    expect(flat).not.toBe(source);
    expect([...flat.rgba]).toEqual([10, 20, 30, 255, 255, 255, 255, 255, 127, 177, 227, 255, 52, 52, 52, 255]);
    expect(source.rgba[7]).toBe(0);
  });
});
