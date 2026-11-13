import { describe, expect, it } from 'vitest';
import { blankGroundShare, offPageShare, paperGroundShare } from '../../src/images/buildImageExtraction.js';

const page = { minX: 0, minY: 0, maxX: 600, maxY: 840 };

describe('offPageShare', () => {
  it('measures how much of a box lies past the page', () => {
    expect(offPageShare({ minX: 100, minY: 100, maxX: 200, maxY: 200 }, page)).toBe(0);
    expect(offPageShare({ minX: 550, minY: 100, maxX: 650, maxY: 200 }, page)).toBeCloseTo(0.5);
    expect(offPageShare({ minX: 700, minY: 100, maxX: 800, maxY: 200 }, page)).toBe(1);
  });
});

describe('blankGroundShare', () => {
  it('counts transparent and near-white pixels as the ground', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) rgba.set(i < 4 ? [200, 20, 20, 255] : i < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0], i * 4);
    expect(blankGroundShare({ width: 4, height: 4, rgba })).toBeCloseTo(0.75);
  });
});

describe('paperGroundShare', () => {
  it('counts off-white grey paper as the ground, but not a tinted or dark pixel', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) rgba.set(i < 4 ? [235, 232, 226, 255] : i < 8 ? [240, 200, 160, 255] : i < 12 ? [40, 30, 60, 255] : [0, 0, 0, 0], i * 4);
    expect(paperGroundShare({ width: 4, height: 4, rgba })).toBeCloseTo(0.5);
    expect(blankGroundShare({ width: 4, height: 4, rgba })).toBeCloseTo(0.25);
  });
});
