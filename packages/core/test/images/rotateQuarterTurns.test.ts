import { describe, expect, it } from 'vitest';
import { rotateQuarterTurns } from '../../src/images/rotateQuarterTurns.js';

// A 3x2 image whose pixels are numbered 1..6 in the red channel, row by row:
//   1 2 3
//   4 5 6
function sample() {
  const rgba = new Uint8ClampedArray(3 * 2 * 4);
  for (let i = 0; i < 6; i++) rgba.set([i + 1, 0, 0, 255], i * 4);
  return { width: 3, height: 2, rgba };
}
const reds = (image: { rgba: Uint8ClampedArray }) => Array.from({ length: image.rgba.length / 4 }, (_, i) => image.rgba[i * 4]);

describe('rotateQuarterTurns', () => {
  it('turns a quarter clockwise', () => {
    const out = rotateQuarterTurns(sample(), 1);
    expect([out.width, out.height]).toEqual([2, 3]);
    expect(reds(out)).toEqual([4, 1, 5, 2, 6, 3]);
  });

  it('turns a half', () => {
    const out = rotateQuarterTurns(sample(), 2);
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(reds(out)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('turns three quarters clockwise (one counterclockwise)', () => {
    const out = rotateQuarterTurns(sample(), 3);
    expect([out.width, out.height]).toEqual([2, 3]);
    expect(reds(out)).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it('does not change its input', () => {
    const input = sample();
    rotateQuarterTurns(input, 1);
    expect(reds(input)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
