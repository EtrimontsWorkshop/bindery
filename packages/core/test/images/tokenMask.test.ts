import { describe, expect, it } from 'vitest';
import { isInsideShape, applyTokenMask } from '../../src/images/tokenMask.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solidSquare(size: number): DecodedImage {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 100;
    rgba[i * 4 + 2] = 50;
    rgba[i * 4 + 3] = 255;
  }
  return { width: size, height: size, rgba };
}
function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}

describe('isInsideShape', () => {
  it('square: always true, even in the corners — a deliberate absence of masking', () => {
    expect(isInsideShape('square', 0, 0)).toBe(true);
    expect(isInsideShape('square', 1, 1)).toBe(true);
    expect(isInsideShape('square', -1, -1)).toBe(true);
  });

  it('circle: the center and the boundary of the inscribed circle true, the corner of the square (distance √2) false', () => {
    expect(isInsideShape('circle', 0, 0)).toBe(true);
    expect(isInsideShape('circle', 1, 0)).toBe(true); // exactly on radius 1
    expect(isInsideShape('circle', 0.99, 0)).toBe(true);
    expect(isInsideShape('circle', 1.01, 0)).toBe(false);
    expect(isInsideShape('circle', 1, 1)).toBe(false); // a corner, distance √2 > 1
  });

  it('roundedSquare: the center and the edge midpoint true, the sharp corner of the square false, a point within the corner radius right BEFORE the rounding true', () => {
    expect(isInsideShape('roundedSquare', 0, 0)).toBe(true);
    expect(isInsideShape('roundedSquare', 1, 0)).toBe(true); // edge midpoint (not a corner) — not clipped
    expect(isInsideShape('roundedSquare', 1, 1)).toBe(false); // a sharp corner of the square is always outside the rounded shape
    expect(isInsideShape('roundedSquare', 0.7, 0.7)).toBe(true); // clearly inside, far from the corner
  });

  it('hex (flat-top): the center true, the left/right vertex (1,0) on the boundary true, a point BEYOND the flat top side (0,1) false, a point on the flat top side (0, apothem) true', () => {
    const apothem = Math.cos(Math.PI / 6);
    expect(isInsideShape('hex', 0, 0)).toBe(true);
    expect(isInsideShape('hex', 1, 0)).toBe(true);
    expect(isInsideShape('hex', 0, apothem)).toBe(true);
    expect(isInsideShape('hex', 0, 1)).toBe(false); // above the flat top edge (the hex does NOT reach y=1, unlike the circle/square)
    expect(isInsideShape('hex', 0.5, 0.3)).toBe(true); // clearly inside
  });
});

describe('applyTokenMask', () => {
  it('a circle on a uniform, opaque canvas: the center stays opaque, the corner becomes transparent (featherPx=0, a sharp boundary)', () => {
    const image = solidSquare(40);
    const result = applyTokenMask(image, 'circle', 0);
    expect(alphaAt(result, 20, 20)).toBe(255); // the center
    expect(alphaAt(result, 0, 0)).toBe(0); // a corner, far outside the circle
  });

  it('square: no alpha change EVEN in the corners (no masking by definition)', () => {
    const image = solidSquare(20);
    const result = applyTokenMask(image, 'square', 0);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(result, x, y)).toBe(255);
  });

  it('RGB is never touched by the masking', () => {
    const image = solidSquare(20);
    const result = applyTokenMask(image, 'circle', 0);
    for (let i = 0; i < result.rgba.length; i += 4) {
      expect(result.rgba[i]).toBe(200);
      expect(result.rgba[i + 1]).toBe(100);
      expect(result.rgba[i + 2]).toBe(50);
    }
  });

  it('featherPx > 0 gives an INTERMEDIATE alpha value right at the mask boundary (not a sharp 0/255 jump)', () => {
    const image = solidSquare(60);
    const hard = applyTokenMask(image, 'circle', 0);
    const soft = applyTokenMask(image, 'circle', 3);
    // Find a pixel on the hard mask that is on the boundary (adjacent to a transparent one).
    let boundaryX = -1;
    let boundaryY = -1;
    outer: for (let y = 0; y < 60; y++) {
      for (let x = 1; x < 60; x++) {
        if (alphaAt(hard, x, y) === 255 && alphaAt(hard, x - 1, y) === 0) {
          boundaryX = x;
          boundaryY = y;
          break outer;
        }
      }
    }
    expect(boundaryX).toBeGreaterThanOrEqual(0);
    const softAlpha = alphaAt(soft, boundaryX, boundaryY);
    expect(softAlpha).toBeGreaterThan(0);
    expect(softAlpha).toBeLessThan(255);
  });

  it('doesn\'t mutate the input', () => {
    const image = solidSquare(20);
    const snapshot = image.rgba.slice();
    applyTokenMask(image, 'hex', 1);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});
