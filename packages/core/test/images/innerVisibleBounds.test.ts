import { describe, expect, it } from 'vitest';
import { innerVisibleBounds } from '../../src/images/opaqueBounds.js';

/** A mask of `size` by `size` pixels that shows (white) where `inside(x, y)` holds, and hides (black) elsewhere. */
function mask(size: number, inside: (x: number, y: number) => boolean) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba.set(inside(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * size + x) * 4);
  return { width: size, height: size, rgba };
}

describe('innerVisibleBounds', () => {
  it('finds the upright box of a sheet laid upright within its margin', () => {
    const b = innerVisibleBounds(mask(100, (x, y) => x >= 10 && x < 90 && y >= 20 && y < 80))!;
    expect(b).toEqual({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 });
  });

  it('keeps within the tilted sides of a sheet laid askew, leaving out the wedges of the page', () => {
    // Its left and right sides lean: 10 to 14 on the left, 86 to 90 on the right, from top to bottom.
    const b = innerVisibleBounds(mask(100, (x, y) => y >= 10 && y < 90 && x >= 10 + (y - 10) / 20 && x < 86 + (y - 10) / 20))!;
    expect(b.x0).toBeGreaterThanOrEqual(0.13);
    expect(b.x1).toBeLessThanOrEqual(0.87);
    expect(b.y0).toBeCloseTo(0.1, 2);
    expect(b.y1).toBeCloseTo(0.9, 2);
  });

  it('is null when nothing shows', () => {
    expect(innerVisibleBounds(mask(10, () => false))).toBeNull();
  });
});
