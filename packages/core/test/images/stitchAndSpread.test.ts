import { describe, expect, it } from 'vitest';
import { findSpreadPairs } from '../../src/images/spreadPairs.js';
import { dropLeftColumns, stitchHorizontally } from '../../src/images/stitchHorizontally.js';

const PAGE = { minX: 0, minY: 0, maxX: 612, maxY: 792 };
const boxes = new Map([[1, PAGE], [2, PAGE], [3, PAGE]]);
const half = (page: number, minX: number, maxX: number, minY = 70, maxY = 694) => ({ page, bbox: { minX, minY, maxX, maxY } });

describe('findSpreadPairs', () => {
  it('pairs two pictures that meet side by side on one page with the same top and bottom', () => {
    const left = half(1, 62, 310);
    const right = half(1, 308, 547);
    expect(findSpreadPairs([right, left], boxes).get(left)).toBe(right);
    expect(findSpreadPairs([left, half(1, 330, 547)], boxes).size).toBe(0);
    // A row of portraits with a few points between them is not one picture.
    expect(findSpreadPairs([half(1, 41, 212), half(1, 216, 388)], boxes).size).toBe(0);
    expect(findSpreadPairs([left, half(1, 308, 547, 70, 500)], boxes).size).toBe(0);
  });

  it('pairs the two halves of a picture cut with a margin, which overlap by some points on the page, only when they were cut from one raster', () => {
    const left = half(1, 29, 316, 211, 727);
    const right = half(1, 305, 588, 211, 727);
    const sizes = new Map([[left, { width: 597, height: 1074 }], [right, { width: 590, height: 1074 }]]);
    expect(findSpreadPairs([right, left], boxes, (c) => sizes.get(c)).get(left)).toBe(right);
    // Without the sizes, or with rasters of other heights or too small ones, an overlap of 11 points is not a seam.
    expect(findSpreadPairs([right, left], boxes).size).toBe(0);
    expect(findSpreadPairs([right, left], boxes, (c) => (c === left ? { width: 597, height: 1074 } : { width: 590, height: 900 })).size).toBe(0);
    expect(findSpreadPairs([right, left], boxes, () => ({ width: 40, height: 60 })).size).toBe(0);
    // A deep overlap is two pictures.
    const deep = half(1, 280, 588, 211, 727);
    expect(findSpreadPairs([left, deep], boxes, () => ({ width: 597, height: 1074 })).size).toBe(0);
  });

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

describe('dropLeftColumns', () => {
  it('removes the first columns of an image and keeps the rest', () => {
    const out = dropLeftColumns(image(4, 2, 10), 1);
    expect([out.width, out.height]).toEqual([3, 2]);
  });

  it('leaves the image as it is for no columns and keeps at least one column', () => {
    const picture = image(4, 2, 10);
    expect(dropLeftColumns(picture, 0)).toBe(picture);
    expect(dropLeftColumns(picture, 9).width).toBe(1);
  });
});
