import { describe, expect, it } from 'vitest';
import { halvesContinueAcrossSeam } from '../../src/images/spreadSeam.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

type Pixel = [number, number, number, number];
const WHITE: Pixel = [255, 255, 255, 255];
const CLEAR: Pixel = [255, 255, 255, 0];

/** An image `width` x `height` made of `background`, with `paint(x, y)` allowed to replace a pixel. */
function image(width: number, height: number, background: Pixel, paint?: (x: number, y: number) => Pixel | null): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(paint?.(x, y) ?? background, (y * width + x) * 4);
  }
  return { width, height, rgba };
}

describe('halvesContinueAcrossSeam', () => {
  const BLUE: Pixel = [20, 40, 160, 255];
  const ORANGE: Pixel = [220, 120, 20, 255];
  // A band of color that crosses the seam between rows 40 and 80.
  const band = (color: Pixel) => (_x: number, y: number) => (y >= 40 && y < 80 ? color : null);

  it('joins two halves whose drawing goes on across the seam in the same rows and colors', () => {
    expect(halvesContinueAcrossSeam(image(100, 200, CLEAR, band(BLUE)), image(60, 200, CLEAR, band(BLUE)))).toBe(true);
  });

  it('joins halves of different resolution (the right one is scaled to the left one\'s height)', () => {
    const halfHeightBand = (_x: number, y: number) => (y >= 20 && y < 40 ? BLUE : null);
    expect(halvesContinueAcrossSeam(image(100, 200, WHITE, band(BLUE)), image(30, 100, WHITE, halfHeightBand))).toBe(true);
  });

  it('does not join pictures whose colors do not match at the seam', () => {
    expect(halvesContinueAcrossSeam(image(100, 200, CLEAR, band(BLUE)), image(60, 200, CLEAR, band(ORANGE)))).toBe(false);
  });

  it('does not join when the drawing meets the seam on one side only, or on neither', () => {
    expect(halvesContinueAcrossSeam(image(100, 200, CLEAR, band(BLUE)), image(60, 200, CLEAR))).toBe(false);
    expect(halvesContinueAcrossSeam(image(100, 200, WHITE), image(60, 200, WHITE))).toBe(false);
  });

  it('does not join when the drawings meet the seam in different rows', () => {
    const lowBand = (_x: number, y: number) => (y >= 140 && y < 180 ? BLUE : null);
    expect(halvesContinueAcrossSeam(image(100, 200, CLEAR, band(BLUE)), image(60, 200, CLEAR, lowBand))).toBe(false);
  });

  it('joins a picture that changes smoothly across the gutter, and refuses two pictures that jump at it (two portraits on dark grounds)', () => {
    // A gradient that goes on from the left half into the right one.
    const leftGradient = (x: number): Pixel => [60 + x, 60 + x, 60 + x, 255];
    const rightGradient = (x: number): Pixel => [160 + x, 160 + x, 160 + x, 255];
    const flat = (value: number): Pixel => [value, value, value, 255];
    const left = image(100, 100, WHITE, (x) => leftGradient(x));
    expect(halvesContinueAcrossSeam(left, image(60, 100, WHITE, (x) => rightGradient(x)))).toBe(true);
    expect(halvesContinueAcrossSeam(left, image(60, 100, WHITE, () => flat(30)))).toBe(false);
  });
});
