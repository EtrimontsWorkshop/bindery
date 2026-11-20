import { describe, expect, it } from 'vitest';
import { isTextPageBesidePicture, plainGroundShare } from '../../src/images/extractionJoins.js';

function image(width: number, height: number, colourAt: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([...colourAt(x, y), 255], (y * width + x) * 4);
  return { width, height, rgba };
}

const paper = image(100, 100, (x, y) => (x < 4 || y < 4 ? [40, 30, 20] : [235, 215, 190]));
const picture = image(100, 100, (x, y) => [(x * 5) % 256, (y * 7) % 256, ((x + y) * 3) % 256]);

describe('plainGroundShare', () => {
  it('is high for a sheet of tinted paper with a dark edge, low for a picture', () => {
    expect(plainGroundShare(paper)).toBeGreaterThan(0.9);
    expect(plainGroundShare(picture)).toBeLessThan(0.2);
  });
});

describe('isTextPageBesidePicture', () => {
  it('a plain page the book writes on, beside a page with no text', () => {
    expect(isTextPageBesidePicture(0.3, 0.001, paper)).toBe(true);
  });

  it('not when the other page has text too, when this page has little, or when its pixels are a picture', () => {
    expect(isTextPageBesidePicture(0.3, 0.1, paper)).toBe(false);
    expect(isTextPageBesidePicture(0.05, 0.001, paper)).toBe(false);
    expect(isTextPageBesidePicture(0.3, 0.001, picture)).toBe(false);
  });
});
