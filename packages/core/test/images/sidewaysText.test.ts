import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';
import { rotateQuarterTurns } from '../../src/images/rotateQuarterTurns.js';
import { sidewaysLettering, standUpLettering } from '../../src/images/sidewaysText.js';

const WIDTH = 600;
const HEIGHT = 400;

function paper(width = WIDTH, height = HEIGHT): DecodedImage {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(235) };
}

function ink(image: DecodedImage, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const at = (y * image.width + x) * 4;
      image.rgba[at] = 30;
      image.rgba[at + 1] = 30;
      image.rgba[at + 2] = 30;
    }
  }
}

/** A letter: a hollow box 9 wide, 13 tall, its strokes 2 pixels thick. */
function letter(image: DecodedImage, x: number, y: number): void {
  ink(image, x, y, 9, 2);
  ink(image, x, y + 11, 9, 2);
  ink(image, x, y, 2, 13);
  ink(image, x + 7, y, 2, 13);
}

/** An initial capital: a hollow box 9 wide, 19 tall, standing on the foot of the line (its top 6 above the line's). */
function capital(image: DecodedImage, x: number, y: number): void {
  ink(image, x, y - 6, 9, 2);
  ink(image, x, y + 11, 9, 2);
  ink(image, x, y - 6, 2, 19);
  ink(image, x + 7, y - 6, 2, 19);
}

/**
 * Lines of lettering running across: `lines` lines of `perLine` letters, scattered over the picture like a map's names,
 * each opened by an initial capital when `initials` is set.
 */
function lettered(lines = 8, perLine = 8, initials = false): DecodedImage {
  const image = paper();
  for (let line = 0; line < lines; line++) {
    const x = 32 + ((line * 137) % 400);
    const y = 20 + line * 45;
    if (initials) capital(image, x - 12, y);
    for (let n = 0; n < perLine; n++) letter(image, x + n * 12, y);
  }
  return image;
}

describe('sidewaysLettering', () => {
  it('leaves a picture whose lettering runs across', () => {
    const result = sidewaysLettering(lettered());
    expect(result.across).toBeGreaterThanOrEqual(60);
    expect(result.turns).toBe(0);
  });

  it('finds a picture lying on its side by its lettering running up and down, and stands it up clockwise', () => {
    const lying = rotateQuarterTurns(lettered(), 3);
    const result = sidewaysLettering(lying);
    expect(result.upDown).toBeGreaterThanOrEqual(60);
    expect(result.turns).toBe(1);
    const stoodUp = standUpLettering(lying);
    expect(stoodUp && [stoodUp.width, stoodUp.height]).toEqual([WIDTH, HEIGHT]);
    expect(stoodUp!.rgba).toEqual(lettered().rgba);
  });

  it('tells by initial capitals which way lettering on its side reads', () => {
    const upright = lettered(8, 8, true);
    expect(sidewaysLettering(upright).turns).toBe(0);
    // Turned counterclockwise, the lettering reads upwards: stood up clockwise.
    const readsUpwards = rotateQuarterTurns(upright, 3);
    expect(sidewaysLettering(readsUpwards).turns).toBe(1);
    expect(standUpLettering(readsUpwards)!.rgba).toEqual(upright.rgba);
    // Turned clockwise, it reads downwards: stood up counterclockwise.
    const readsDownwards = rotateQuarterTurns(upright, 1);
    expect(sidewaysLettering(readsDownwards).turns).toBe(3);
    expect(standUpLettering(readsDownwards)!.rgba).toEqual(upright.rgba);
  });

  it('takes lettering on its side without initials to read upwards, the way books turn a picture', () => {
    expect(sidewaysLettering(rotateQuarterTurns(lettered(), 1)).turns).toBe(1);
  });

  it('leaves a picture with too little lettering to tell', () => {
    expect(sidewaysLettering(rotateQuarterTurns(lettered(3, 6), 3)).turns).toBe(0);
  });

  it('leaves a picture whose lettering runs both ways about as much', () => {
    const image = lettered(8, 8);
    // Lines running down the right part of the picture: fewer letters than across, but enough to count.
    for (let line = 0; line < 12; line++) for (let n = 0; n < 4; n++) letter(image, 520 + (line % 4) * 18, 20 + Math.floor(line / 4) * 130 + n * 16);
    const result = sidewaysLettering(image);
    expect(result.upDown).toBeGreaterThanOrEqual(40);
    expect(result.turns).toBe(0);
  });

  it('leaves blank paper and a picture without lettering', () => {
    expect(standUpLettering(paper())).toBeNull();
    const blocks = paper();
    for (let n = 0; n < 6; n++) ink(blocks, 40 + n * 90, 60, 60, 260);
    expect(standUpLettering(blocks)).toBeNull();
  });

  it('does not stand up a landscape picture, whatever runs up and down it (the border of a cover)', () => {
    // Lettering running up and down, set on a canvas wider than tall: a picture on its side on a portrait page would be tall.
    const lying = rotateQuarterTurns(lettered(), 3);
    const wide = paper(lying.width + 500, lying.height);
    for (let y = 0; y < lying.height; y++) wide.rgba.set(lying.rgba.subarray(y * lying.width * 4, (y + 1) * lying.width * 4), y * wide.width * 4);
    expect(sidewaysLettering(wide).turns).toBe(1);
    expect(standUpLettering(wide)).toBeNull();
    expect(standUpLettering(lying)).not.toBeNull();
  });
});
