import { describe, expect, it } from 'vitest';
import { isEmptyWithin, isFlatFill, isFrameOfTextBox } from '../../src/images/buildImageExtraction.js';

const image = (width: number, height: number, visible: (x: number, y: number) => boolean) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (visible(x, y)) rgba.set([40, 40, 40, 255], (y * width + x) * 4);
  return { width, height, rgba };
};

describe('isFrameOfTextBox', () => {
  it('takes a header bar with thin sides, transparent within, for the frame of a box of text', () => {
    expect(isFrameOfTextBox(image(100, 80, (x, y) => y < 12 || x < 2 || x >= 98))).toBe(true);
  });

  it('takes a box with a tall header bar and white paper within for one', () => {
    const rgba = new Uint8ClampedArray(300 * 100 * 4);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) rgba.set(y >= 10 && y < 45 ? [60, 60, 60, 255] : x < 3 || x >= 297 ? [60, 60, 60, 255] : [255, 255, 255, 255], (y * 300 + x) * 4);
    expect(isFrameOfTextBox({ width: 300, height: 100, rgba })).toBe(true);
  });

  it('does not take a splash of ink or a figure, visible in the middle, for one', () => {
    expect(isFrameOfTextBox(image(100, 80, (x, y) => (x - 50) ** 2 + (y - 40) ** 2 < 600))).toBe(false);
  });

  it('does not take an opaque picture for one', () => {
    expect(isFrameOfTextBox(image(100, 80, () => true))).toBe(false);
  });
});

describe('isFlatFill', () => {
  it('finds a raster of one flat colour, not a drawn one', () => {

    const flat = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < 100; i++) flat.set(i < 60 ? [40, 38, 42, 255] : [0, 0, 0, 0], i * 4);
    expect(isFlatFill({ width: 10, height: 10, rgba: flat })).toBe(true);
    const drawn = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < 100; i++) drawn.set(i % 2 ? [40, 38, 42, 255] : [200, 190, 180, 255], i * 4);
    expect(isFlatFill({ width: 10, height: 10, rgba: drawn })).toBe(false);
  });
});

describe('isEmptyWithin', () => {
  it('finds a frame transparent within, not a picture with a transparent margin only', () => {
    const size = 20;
    const frame = new Uint8ClampedArray(size * size * 4);
    const picture = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const border = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
        frame.set(border ? [40, 60, 160, 255] : [0, 0, 0, 0], (y * size + x) * 4);
        picture.set(border ? [0, 0, 0, 0] : [120, 90, 60, 255], (y * size + x) * 4);
      }
    }
    expect(isEmptyWithin({ width: size, height: size, rgba: frame })).toBe(true);
    expect(isEmptyWithin({ width: size, height: size, rgba: picture })).toBe(false);
  });
});
