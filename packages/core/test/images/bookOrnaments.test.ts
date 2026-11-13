import { describe, expect, it } from 'vitest';
import { findBookOrnaments, isFrameStrip, isOneColourOrnament, measureInkStyle } from '../../src/images/bookOrnaments.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A white picture with `share` of its rows inked in `[r, g, b]`. */
function picture(width: number, height: number, ink: [number, number, number], share: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const inked = Math.round(height * share);
  for (let y = 0; y < inked; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = ink[0];
      rgba[i + 1] = ink[1];
      rgba[i + 2] = ink[2];
    }
  }
  return { width, height, rgba };
}

const RED: [number, number, number] = [200, 40, 40];
const SEPIA: [number, number, number] = [120, 100, 90];

describe('measureInkStyle', () => {
  it('measures how much of a picture is ink, how saturated and of which hue', () => {
    const style = measureInkStyle(picture(100, 100, RED, 0.2))!;
    expect(style.inkShare).toBeCloseTo(0.2, 1);
    expect(style.saturation).toBeCloseTo(0.8, 1);
    expect(Math.min(style.hue, 360 - style.hue)).toBeLessThan(2);
    expect(style.concentration).toBeCloseTo(1, 2);
  });

  it('is null for a blank picture', () => {
    expect(measureInkStyle(picture(10, 10, RED, 0))).toBeNull();
  });
});

describe('isOneColourOrnament / isFrameStrip', () => {
  it('takes a sparse saturated red drawing for an ornament, not a sepia one or one filled with colour', () => {
    expect(isOneColourOrnament(measureInkStyle(picture(100, 100, RED, 0.2))!)).toBe(true);
    expect(isOneColourOrnament(measureInkStyle(picture(100, 100, SEPIA, 0.2))!)).toBe(false);
    expect(isOneColourOrnament(measureInkStyle(picture(100, 100, RED, 0.8))!)).toBe(false);
  });

  it('takes a long sparsely inked strip in one colour for a strip of a frame', () => {
    expect(isFrameStrip(measureInkStyle(picture(30, 120, SEPIA, 0.1))!, 30, 120)).toBe(true);
    expect(isFrameStrip(measureInkStyle(picture(60, 150, SEPIA, 0.1))!, 60, 150)).toBe(false); // a tall picture, 2.5 times as tall
  });
});

describe('findBookOrnaments', () => {
  const of = (image: DecodedImage) => ({ style: measureInkStyle(image), width: image.width, height: image.height });

  it('hides the ornaments in the colour that six of the book share, and the strips of its frames with them', () => {
    const book = [...Array.from({ length: 6 }, () => of(picture(100, 80, RED, 0.2))), of(picture(100, 100, SEPIA, 0.4)), of(picture(30, 120, SEPIA, 0.1))];
    expect([...findBookOrnaments(book)].sort()).toEqual([0, 1, 2, 3, 4, 5, 7]);
  });

  it('leaves a book with a few red pictures (a seal, a logo) as it is, and its strips too', () => {
    const book = [...Array.from({ length: 3 }, () => of(picture(100, 80, RED, 0.2))), of(picture(30, 120, SEPIA, 0.1))];
    expect(findBookOrnaments(book).size).toBe(0);
  });
});
