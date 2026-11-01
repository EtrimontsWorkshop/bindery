import { describe, expect, it } from 'vitest';
import { looksLikeInkSplatter } from '../../src/images/inkSplatter.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function paper(width: number, height: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, rgba };
}

function dot(image: DecodedImage, x: number, y: number, size: number, rgb: [number, number, number]): void {
  for (let yy = y; yy < y + size; yy++) for (let xx = x; xx < x + size; xx++) for (let c = 0; c < 3; c++) image.rgba[(yy * image.width + xx) * 4 + c] = rgb[c]!;
}

const RED: [number, number, number] = [200, 50, 20];

/** A big blot with many droplets round it. */
function splatter(rgb: [number, number, number]): DecodedImage {
  const image = paper(512, 512);
  dot(image, 150, 150, 120, rgb);
  for (let i = 0; i < 120; i++) dot(image, 14 + (i % 12) * 40, 14 + Math.floor(i / 12) * 40, 6, rgb);
  return image;
}

describe('looksLikeInkSplatter', () => {
  it('is true for one saturated colour thrown on paper as a blot with many droplets', () => {
    expect(looksLikeInkSplatter(splatter(RED))).toBe(true);
  });

  it('is true for black ink thrown as a blot with many droplets on white paper or on a transparent ground', () => {
    expect(looksLikeInkSplatter(splatter([20, 20, 20]))).toBe(true);
    const clear = splatter([20, 20, 20]);
    for (let i = 0; i < clear.rgba.length; i += 4) if (clear.rgba[i] === 255) clear.rgba[i + 3] = 0;
    expect(looksLikeInkSplatter(clear)).toBe(true);
  });

  it('is true for a few specks of black ink on a clear ground, and false for a line drawing with as many small marks', () => {
    const specks = paper(512, 512);
    for (let i = 0; i < 12; i++) dot(specks, 30 + i * 37, 40 + (i % 5) * 80, 6, [10, 10, 10]);
    expect(looksLikeInkSplatter(specks)).toBe(true);
    const drawing = paper(512, 512);
    for (let i = 0; i < 12; i++) dot(drawing, 30 + i * 37, 40 + (i % 5) * 80, 6, [10, 10, 10]);
    // a thick frame of one stroke: a tenth of the raster is ink and nearly all of it lies in one piece
    dot(drawing, 100, 100, 300, [10, 10, 10]);
    dot(drawing, 120, 120, 260, [255, 255, 255]);
    expect(looksLikeInkSplatter(drawing)).toBe(false);
  });

  it('is true for a raster that is all paper but a few specks of dust, and for a blot of black ink whose edges fade into grey', () => {
    const dust = paper(1000, 1000);
    for (let i = 0; i < 4; i++) dot(dust, 100 + i * 200, 300 + (i % 2) * 300, 12, [10, 10, 10]);
    expect(looksLikeInkSplatter(dust)).toBe(true);
    const blot = paper(512, 512);
    dot(blot, 180, 180, 90, [10, 10, 10]);
    for (let i = 0; i < 240; i++) dot(blot, 10 + (i % 20) * 25, 10 + Math.floor(i / 20) * 40, 6, i % 4 === 0 ? [140, 140, 140] : [10, 10, 10]);
    expect(looksLikeInkSplatter(blot)).toBe(true);
  });

  it('is false for a dense pattern of black dots that fills much of the raster (a code), and for one black shape', () => {
    const code = paper(512, 512);
    for (let i = 0; i < 400; i++) dot(code, 10 + (i % 20) * 24, 10 + Math.floor(i / 20) * 24, 14, [20, 20, 20]);
    expect(looksLikeInkSplatter(code)).toBe(false);
    const shape = paper(512, 512);
    dot(shape, 100, 100, 250, [20, 20, 20]);
    expect(looksLikeInkSplatter(shape)).toBe(false);
  });

  it('is false for one flat shape, and for droplets of different colours', () => {
    const icon = paper(512, 512);
    dot(icon, 100, 100, 250, RED);
    expect(looksLikeInkSplatter(icon)).toBe(false);
    const mixed = paper(512, 512);
    dot(mixed, 150, 150, 120, RED);
    const hues: [number, number, number][] = [[200, 50, 20], [20, 160, 40], [30, 50, 200], [200, 180, 20]];
    for (let i = 0; i < 120; i++) dot(mixed, 14 + (i % 12) * 40, 14 + Math.floor(i / 12) * 40, 6, hues[i % 4]!);
    expect(looksLikeInkSplatter(mixed)).toBe(false);
  });

  it('is false for a picture that fills the raster, and for a tiny one', () => {
    const filled = paper(512, 512);
    dot(filled, 0, 0, 512, RED);
    expect(looksLikeInkSplatter(filled)).toBe(false);
    expect(looksLikeInkSplatter(paper(8, 8))).toBe(false);
  });
});
