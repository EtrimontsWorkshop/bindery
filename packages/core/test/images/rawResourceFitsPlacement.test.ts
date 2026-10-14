import { describe, expect, it } from 'vitest';
import { rawResourceFitsPlacement } from '../../src/images/buildImageExtraction.js';

const box = (w: number, h: number) => ({ minX: 10, minY: 20, maxX: 10 + w, maxY: 20 + h });

describe('rawResourceFitsPlacement', () => {
  it('the same proportions fit', () => {
    expect(rawResourceFitsPlacement({ width: 470, height: 473 }, box(239, 240))).toBe(true);
  });

  it('a texture strip painted under a tall picture does not fit', () => {
    expect(rawResourceFitsPlacement({ width: 1601, height: 119 }, box(243, 417))).toBe(false);
  });

  it('a resource rotated by 90 degrees still fits', () => {
    expect(rawResourceFitsPlacement({ width: 300, height: 200 }, box(100, 150))).toBe(true);
  });

  it('a moderate stretch is within the tolerance, a strong one is not', () => {
    expect(rawResourceFitsPlacement({ width: 400, height: 300 }, box(120, 100))).toBe(true);
    expect(rawResourceFitsPlacement({ width: 400, height: 300 }, box(300, 100))).toBe(false);
  });

  it('degenerate sizes never fit', () => {
    expect(rawResourceFitsPlacement({ width: 0, height: 10 }, box(10, 10))).toBe(false);
    expect(rawResourceFitsPlacement({ width: 10, height: 10 }, box(0, 10))).toBe(false);
  });
});
