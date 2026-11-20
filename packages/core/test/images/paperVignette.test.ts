import { describe, expect, it } from 'vitest';
import { isFadedPaperOverlay, isFadedPaperVignette, isLabelledPicture, labelsOnBlankCount } from '../../src/images/extractionLooks.js';

/** An image whose pixels are `light` light visible ones, `dark` mid-tone visible ones and `clear` transparent ones. */
function image(light: number, dark: number, clear: number) {
  const pixels = [...Array(light).fill([238, 232, 226, 120]), ...Array(dark).fill([110, 90, 70, 255]), ...Array(clear).fill([0, 0, 0, 0])];
  return { rgba: new Uint8ClampedArray(pixels.flat()) };
}

describe('isFadedPaperVignette', () => {
  it('takes a page-sized raster at the page edge whose visible pixels are nearly all light paper for a paper vignette', () => {
    // Most of it is cut out by its mask; what shows is faded paper with a few stains.
    expect(isFadedPaperVignette(image(18, 2, 80), 0.79)).toBe(true);
  });

  it('keeps a figure of mid tones and a light picture that is not page-sized', () => {
    expect(isFadedPaperVignette(image(6, 14, 80), 0.79)).toBe(false);
    expect(isFadedPaperVignette(image(18, 2, 80), 0.3)).toBe(false);
    expect(isFadedPaperVignette(image(0, 0, 10), 0.79)).toBe(false);
  });
});

describe('isFadedPaperOverlay', () => {
  it('takes a raster of which little shows, nearly all light, for the paper laid over a picture', () => {
    expect(isFadedPaperOverlay(image(4, 0, 96))).toBe(true);
  });

  it('keeps a figure that shows a good part of its box, or one of mid tones', () => {
    expect(isFadedPaperOverlay(image(40, 2, 58))).toBe(false);
    expect(isFadedPaperOverlay(image(2, 8, 90))).toBe(false);
  });
});

describe('isLabelledPicture', () => {
  const box = { minX: 0, minY: 0, maxX: 500, maxY: 400 };
  // Labels scattered over the picture: each row set off from the one above, so no two start at the same left edge.
  const label = (i: number) => ({ minX: 10 + (i % 6) * 80 + Math.floor(i / 6) * 9, minY: 10 + Math.floor(i / 6) * 60, maxX: 60 + (i % 6) * 80 + Math.floor(i / 6) * 9, maxY: 20 + Math.floor(i / 6) * 60 });

  it('counts the small blocks of text within a picture as its labels', () => {
    expect(isLabelledPicture(box, Array.from({ length: 24 }, (_, i) => label(i)))).toBe(true);
    expect(isLabelledPicture(box, Array.from({ length: 12 }, (_, i) => label(i)))).toBe(false);
  });

  it('does not count paragraphs, nor blocks outside the picture', () => {
    const paragraphs = Array.from({ length: 24 }, (_, i) => ({ minX: 0, minY: i * 16, maxX: 250, maxY: i * 16 + 60 }));
    expect(isLabelledPicture(box, paragraphs)).toBe(false);
    // The lines of a paragraph wrapped around a figure: small blocks, one under another from one left edge.
    const wrapped = Array.from({ length: 24 }, (_, i) => ({ minX: 300, minY: 10 + i * 14, maxX: 380, maxY: 20 + i * 14 }));
    expect(isLabelledPicture(box, wrapped)).toBe(false);
    // ...or ending at one right edge, set flush against the figure on its other side.
    const flushRight = Array.from({ length: 24 }, (_, i) => ({ minX: 300 + (i % 4) * 7, minY: 10 + i * 14, maxX: 380, maxY: 20 + i * 14 }));
    expect(isLabelledPicture(box, flushRight)).toBe(false);
    const outside = Array.from({ length: 24 }, (_, i) => ({ ...label(i), minX: label(i).minX + 600, maxX: label(i).maxX + 600 }));
    expect(isLabelledPicture(box, outside)).toBe(false);
  });
});

describe('labelsOnBlankCount', () => {
  // A picture of 10 by 10 pixels over a box of 100 by 100 points: its left half drawn (mid tones), its right half white.
  const rgba = new Uint8ClampedArray(10 * 10 * 4);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) rgba.set(x < 5 ? [120, 100, 80, 255] : [255, 255, 255, 255], (y * 10 + x) * 4);
  const picture = { width: 10, height: 10, rgba };
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('counts the labels that lie on the blank ground of the picture, not those on what it draws', () => {
    const onDrawn = { minX: 10, minY: 40, maxX: 40, maxY: 50 };
    const onBlank = { minX: 60, minY: 40, maxX: 90, maxY: 50 };
    expect(labelsOnBlankCount(picture, box, [onDrawn, onBlank, onBlank])).toBe(2);
  });

  it('takes transparent pixels for the blank ground too', () => {
    const clear = { width: 1, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 0]) };
    expect(labelsOnBlankCount(clear, box, [{ minX: 10, minY: 10, maxX: 20, maxY: 20 }])).toBe(1);
  });
});

describe('isLabelledPicture and the rows of a card', () => {
  it('does not take the entries of a card, set in rows from the same left edges, for labels', () => {
    const box = { minX: 0, minY: 0, maxX: 500, maxY: 400 };
    // Two columns of entries, each set from its column's left edge, spread over the card.
    const rows = Array.from({ length: 24 }, (_, i) => ({ minX: i % 2 === 0 ? 20 : 270, minY: 10 + Math.floor(i / 2) * 32, maxX: (i % 2 === 0 ? 20 : 270) + 40 + (i % 5) * 20, maxY: 20 + Math.floor(i / 2) * 32 }));
    expect(isLabelledPicture(box, rows)).toBe(false);
  });
});

describe('labelsOnBlankCount on paper', () => {
  it('takes the plain light paper of a card for blank ground, and light coloured land for a drawing', () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const paper = { width: 1, height: 1, rgba: new Uint8ClampedArray([228, 224, 218, 255]) };
    const land = { width: 1, height: 1, rgba: new Uint8ClampedArray([232, 205, 150, 255]) };
    const label = [{ minX: 10, minY: 10, maxX: 40, maxY: 20 }];
    expect(labelsOnBlankCount(paper, box, label)).toBe(1);
    expect(labelsOnBlankCount(land, box, label)).toBe(0);
  });
});
