import { describe, expect, it } from 'vitest';
import { findSpreadPairs } from '../../src/images/spreadPairs.js';
import { stitchHorizontally } from '../../src/images/stitchHorizontally.js';

const PAGE = { minX: 0, minY: 0, maxX: 612, maxY: 792 };
const boxes = new Map([[1, PAGE], [2, PAGE], [3, PAGE]]);
const half = (page: number, minX: number, maxX: number, minY = 70, maxY = 694) => ({ page, bbox: { minX, minY, maxX, maxY } });

describe('findSpreadPairs', () => {
  it('pairs a picture that runs to the right edge with one that starts at the left edge of the next page', () => {
    const left = half(1, 61, 614);
    const right = half(2, -1, 551);
    expect(findSpreadPairs([left, right], boxes).get(left)).toBe(right);
  });

  it('does not pair pictures that do not reach the gutter, differ in height, or are not on neighboring pages', () => {
    expect(findSpreadPairs([half(1, 61, 500), half(2, -1, 551)], boxes).size).toBe(0);
    expect(findSpreadPairs([half(1, 61, 614), half(2, -1, 551, 70, 600)], boxes).size).toBe(0);
    expect(findSpreadPairs([half(1, 61, 614), half(3, -1, 551)], boxes).size).toBe(0);
    expect(findSpreadPairs([half(1, 61, 614), half(2, 20, 551)], boxes).size).toBe(0);
  });

  it('uses a picture in one pair only', () => {
    const a = half(1, 61, 614);
    const b = half(2, -1, 614);
    const c = half(3, -1, 551);
    const pairs = findSpreadPairs([a, b, c], boxes);
    expect(pairs.get(a)).toBe(b);
    expect(pairs.has(b)).toBe(false);
  });
});

function image(width: number, height: number, red: number) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([red, 0, 0, 255], i * 4);
  return { width, height, rgba };
}

describe('stitchHorizontally', () => {
  it('puts the second image after the first', () => {
    const out = stitchHorizontally(image(2, 2, 10), image(3, 2, 200));
    expect([out.width, out.height]).toEqual([5, 2]);
    expect(Array.from({ length: 5 }, (_, x) => out.rgba[x * 4])).toEqual([10, 10, 200, 200, 200]);
  });

  it('scales the second image to the height of the first when they differ', () => {
    const out = stitchHorizontally(image(2, 4, 10), image(3, 2, 200));
    expect(out.height).toBe(4);
    expect(out.width).toBe(2 + 6);
    expect(out.rgba[(3 * out.width + 7) * 4]).toBe(200);
  });
});
