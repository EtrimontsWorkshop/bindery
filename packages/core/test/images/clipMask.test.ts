import { describe, expect, it } from 'vitest';
import { applyClipToImage } from '../../src/images/clipMask.js';
import { flattenPath } from '../../src/inventory/clipPaths.js';

const M = 0;
const L = 1;
const Z = 4;
const rect = (x0: number, y0: number, x1: number, y1: number) => [M, x0, y0, L, x1, y0, L, x1, y1, L, x0, y1, Z];
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/** A w x h image whose pixel (x, y) has red = x and green = y, fully opaque. */
function gradient(w: number, h: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x, y, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

// The image is painted so that its 100x100 pixels cover the page square [0,100]x[0,100] (y up): the top row of
// pixels lies at page y = 100.
const CTM = [100, 0, 0, 100, 0, 0] as const;

describe('applyClipToImage', () => {
  it('crops to the visible part and keeps its pixels', () => {
    // the left half of the page square = the left 50 columns of the image
    const clip = { paths: [flattenPath(rect(0, 0, 50, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.width).toBe(50);
    expect(out.height).toBe(100);
    expect(out.rgba[0]).toBe(0);
    expect(out.rgba[(0 * 50 + 49) * 4]).toBe(49);
    expect(out.rgba[3]).toBe(255);
  });

  it('maps page y (up) to image rows (down)', () => {
    // the top quarter of the page square = the first 25 rows of the image
    const clip = { paths: [flattenPath(rect(0, 75, 100, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.height).toBe(25);
    expect(out.rgba[1]).toBe(0);
    expect(out.rgba[((24 * 100) + 0) * 4 + 1]).toBe(24);
  });

  it('makes what the clip hides inside the crop transparent (a diagonal clip)', () => {
    const triangle = flattenPath([M, 0, 0, L, 100, 0, L, 0, 100, Z], IDENTITY);
    const out = applyClipToImage(gradient(100, 100), { paths: [triangle], ctm: CTM });
    expect(out.width).toBe(100);
    // the upper-right corner pixel of the image lies outside the triangle
    expect(out.rgba[(0 * 100 + 99) * 4 + 3]).toBe(0);
    // the lower-left corner lies inside
    expect(out.rgba[(99 * 100 + 0) * 4 + 3]).toBe(255);
  });

  it('intersects several clips', () => {
    const clip = { paths: [flattenPath(rect(0, 0, 60, 100), IDENTITY), flattenPath(rect(40, 0, 100, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.width).toBe(20);
    expect(out.rgba[0]).toBe(40);
  });

  it('returns the image itself when the clip leaves nothing or the CTM is singular', () => {
    const img = gradient(10, 10);
    expect(applyClipToImage(img, { paths: [flattenPath(rect(500, 500, 600, 600), IDENTITY)], ctm: CTM })).toBe(img);
    expect(applyClipToImage(img, { paths: [flattenPath(rect(0, 0, 50, 50), IDENTITY)], ctm: [0, 0, 0, 0, 0, 0] })).toBe(img);
    expect(applyClipToImage(img, { paths: [], ctm: CTM })).toBe(img);
  });

  it('keeps a pixel that was already transparent transparent', () => {
    const img = gradient(10, 10);
    img.rgba[3] = 0;
    const out = applyClipToImage(img, { paths: [flattenPath(rect(0, 0, 100, 100), IDENTITY)], ctm: [10, 0, 0, 10, 0, 0] });
    expect(out.rgba[3]).toBe(0);
  });
});
