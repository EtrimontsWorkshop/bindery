import { describe, expect, it } from 'vitest';
import { maskLetsMostThrough } from '../../src/images/buildImageExtraction.js';
import { maskRectangularity } from '../../src/images/maskShape.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A grayscale mask raster: white where `inside(x, y)` holds, black elsewhere. */
function mask(width: number, height: number, inside: (x: number, y: number) => boolean): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = inside(x, y) ? 255 : 0;
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba } as DecodedImage;
}

function tiltedRect(width: number, height: number, w: number, h: number, degrees: number) {
  const rad = (degrees * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  return (x: number, y: number): boolean => {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * Math.cos(rad) + dy * Math.sin(rad);
    const v = -dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(u) <= w / 2 && Math.abs(v) <= h / 2;
  };
}

describe('maskRectangularity', () => {
  it('an axis-aligned rectangle fills its enclosing rectangle', () => {
    expect(maskRectangularity(mask(200, 200, (x, y) => x >= 20 && x < 180 && y >= 30 && y < 170))).toBeGreaterThan(0.98);
  });

  it('a rectangle rotated by 12 degrees still does, although it is white over only about 0.7 of its raster', () => {
    const img = mask(400, 400, tiltedRect(400, 400, 260, 260, 12));
    let white = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i]! > 127) white++;
    expect(white / (400 * 400)).toBeLessThan(0.5);
    expect(maskRectangularity(img)).toBeGreaterThan(0.95);
  });

  it('an ellipse does not (about 0.785)', () => {
    const r = maskRectangularity(mask(300, 300, (x, y) => ((x - 150) / 140) ** 2 + ((y - 150) / 140) ** 2 <= 1));
    expect(r).toBeGreaterThan(0.74);
    expect(r).toBeLessThan(0.83);
  });

  it('an L-shaped silhouette does not', () => {
    expect(maskRectangularity(mask(200, 200, (x, y) => (x < 80 && y >= 20 && y < 180) || (y >= 120 && y < 180 && x < 180)))).toBeLessThan(0.8);
  });

  it('an all-black mask has no white area', () => {
    expect(maskRectangularity(mask(50, 50, () => false))).toBe(0);
  });
});

describe('maskLetsMostThrough', () => {
  it('a mask white over 0.8 or more lets most through whatever its shape', () => {
    expect(maskLetsMostThrough(0.86, null)).toBe(true);
    expect(maskLetsMostThrough(0.8, 0.2)).toBe(true);
  });

  it('a tilted-rectangle mask (white 0.72, rectangularity 0.98) lets most through', () => {
    expect(maskLetsMostThrough(0.72, 0.98)).toBe(true);
  });

  it('a mask below 0.8 whose shape is not a rectangle does not (an oval, a silhouette)', () => {
    expect(maskLetsMostThrough(0.78, 0.785)).toBe(false);
    expect(maskLetsMostThrough(0.55, 0.3)).toBe(false);
  });

  it('a rectangular window that hides most of the picture does not', () => {
    expect(maskLetsMostThrough(0.4, 0.99)).toBe(false);
  });

  it('an unknown shape does not rescue a mask below 0.8', () => {
    expect(maskLetsMostThrough(0.72, null)).toBe(false);
  });
});
