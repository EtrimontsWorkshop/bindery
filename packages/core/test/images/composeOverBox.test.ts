import { describe, expect, it } from 'vitest';
import { composeOverBox } from '../../src/images/buildImageExtraction.js';

const solid = (width: number, height: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, rgba: data };
};
const pixel = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('composeOverBox', () => {
  it('lays two pieces of a half, each over part of the height, into their joined box (y up)', () => {
    // Top piece over y 50..100, bottom piece over y 0..60, both 10 pt wide, 1 px per pt.
    const top = { image: solid(10, 50, [255, 0, 0, 255]), box: { minX: 0, minY: 50, maxX: 10, maxY: 100 }, index: 1 };
    const bottom = { image: solid(10, 60, [0, 0, 255, 255]), box: { minX: 0, minY: 0, maxX: 10, maxY: 60 }, index: 2 };
    const out = composeOverBox([top, bottom], { minX: 0, minY: 0, maxX: 10, maxY: 100 })!;
    expect([out.width, out.height]).toEqual([10, 100]);
    expect(pixel(out, 5, 10)).toEqual([255, 0, 0, 255]);
    // Where they overlap, the one painted later lies over the other.
    expect(pixel(out, 5, 45)).toEqual([0, 0, 255, 255]);
    expect(pixel(out, 5, 95)).toEqual([0, 0, 255, 255]);
  });

  it('blends a soft edge over what lies under it and leaves the rest transparent', () => {
    const under = { image: solid(10, 10, [0, 0, 0, 255]), box: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 1 };
    const over = { image: solid(10, 10, [255, 255, 255, 128]), box: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 2 };
    const out = composeOverBox([over, under], { minX: 0, minY: 0, maxX: 20, maxY: 10 })!;
    expect(pixel(out, 5, 5)[0]).toBeGreaterThan(120);
    expect(pixel(out, 5, 5)[0]).toBeLessThan(135);
    expect(pixel(out, 5, 5)[3]).toBe(255);
    expect(pixel(out, 15, 5)[3]).toBe(0);
  });
});
