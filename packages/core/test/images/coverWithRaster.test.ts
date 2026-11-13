import { describe, expect, it } from 'vitest';
import { coverWithRaster } from '../../src/images/coverWithRaster.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solid(width: number, height: number, rgba: [number, number, number, number]): DecodedImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, rgba: data };
}
const pixel = (img: DecodedImage, x: number, y: number) => [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('coverWithRaster', () => {
  it('paints the source only inside the region, mapping page space onto both images (y up, row 0 at the top)', () => {
    // A 100x100pt box rendered at 10x10 px; the source covers the same box.
    const target = solid(10, 10, [0, 0, 0, 255]);
    const source = solid(5, 5, [200, 180, 160, 255]);
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    // The top-right quarter of the box.
    coverWithRaster(target, box, source, box, { minX: 50, minY: 50, maxX: 100, maxY: 100 });
    expect(pixel(target, 9, 0)).toEqual([200, 180, 160, 255]); // top right
    expect(pixel(target, 5, 4)).toEqual([200, 180, 160, 255]);
    expect(pixel(target, 0, 9)).toEqual([0, 0, 0, 255]); // bottom left untouched
    expect(pixel(target, 4, 0)).toEqual([0, 0, 0, 255]); // top left untouched
  });

  it('leaves the part of the region outside the source as it is', () => {
    const target = solid(10, 10, [0, 0, 0, 255]);
    const source = solid(5, 5, [255, 255, 255, 255]);
    coverWithRaster(target, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, source, { minX: 0, minY: 0, maxX: 50, maxY: 100 }, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(pixel(target, 2, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(target, 8, 5)).toEqual([0, 0, 0, 255]);
  });
});
