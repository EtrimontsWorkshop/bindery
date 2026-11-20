import { describe, expect, it } from 'vitest';
import { trimDarkSurround } from '../../src/images/cropUniformMargins.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const WIDTH = 600;
const HEIGHT = 800;

function filled(value: number): DecodedImage {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(value);
  for (let at = 3; at < rgba.length; at += 4) rgba[at] = 255;
  return { width: WIDTH, height: HEIGHT, rgba };
}

function paint(image: DecodedImage, x0: number, y0: number, w: number, h: number, value: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const at = (y * WIDTH + x) * 4;
      // A little texture, as leather has.
      const v = value + ((x * 7 + y * 13) % 20) - 10;
      image.rgba[at] = v;
      image.rgba[at + 1] = v;
      image.rgba[at + 2] = v;
    }
  }
}

/** A light sheet on a dark ground showing `top`, `bottom`, `left` and `right` pixels of it along the sides. */
function sheetOnDarkGround(top: number, bottom: number, left: number, right: number): DecodedImage {
  const image = filled(0);
  paint(image, 0, 0, WIDTH, HEIGHT, 40);
  paint(image, left, top, WIDTH - left - right, HEIGHT - top - bottom, 210);
  return image;
}

describe('trimDarkSurround', () => {
  it('takes the sheet off the dark ground round it', () => {
    const trimmed = trimDarkSurround(sheetOnDarkGround(20, 30, 25, 0));
    expect(trimmed && [trimmed.width, trimmed.height]).toEqual([WIDTH - 25, HEIGHT - 50]);
  });

  it('cuts a side where the picture on the sheet runs dark to its edge, once the ground shows along two others', () => {
    const image = sheetOnDarkGround(20, 30, 25, 0);
    // The bottom of the picture is dark to the sheet's edge, though less than the ground.
    paint(image, 25, HEIGHT - 30 - 120, WIDTH - 25, 120, 100);
    const trimmed = trimDarkSurround(image);
    expect(trimmed && [trimmed.width, trimmed.height]).toEqual([WIDTH - 25, HEIGHT - 50]);
  });

  it('passes over a hairline of white past the page before the ground (a render of the page)', () => {
    const image = sheetOnDarkGround(20, 30, 0, 30);
    paint(image, WIDTH - 4, 0, 4, HEIGHT, 255);
    paint(image, 0, 0, WIDTH, 3, 255);
    const trimmed = trimDarkSurround(image);
    expect(trimmed && [trimmed.width, trimmed.height]).toEqual([WIDTH - 30, HEIGHT - 50]);
  });

  it('leaves a picture with one dark band only, and one with a dark band too deep to be a ground (a night sky)', () => {
    expect(trimDarkSurround(sheetOnDarkGround(20, 0, 0, 0))).toBeNull();
    expect(trimDarkSurround(sheetOnDarkGround(120, 0, 60, 0))).toBeNull();
  });

  it('leaves a picture growing lighter from a dark edge rather than ending at a sheet', () => {
    const image = filled(210);
    for (let band = 0; band < 60; band++) {
      paint(image, 0, band, WIDTH, 1, 40 + band * 3);
      paint(image, band, 0, 1, HEIGHT, 40 + band * 3);
    }
    expect(trimDarkSurround(image)).toBeNull();
  });

  it('leaves a picture without a dark ground', () => {
    expect(trimDarkSurround(filled(200))).toBeNull();
  });
});
