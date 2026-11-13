import { describe, expect, it } from 'vitest';
import { isFormOrTable, isPartOfSheet, looksLikeDocument, looksLikeDocumentOnDark, looksLikeFormOrTable, looksLikeCoveredDocument, looksLikeHandwrittenNote, looksLikeLargePrintNote, looksLikePageOfDocuments, looksLikeSlantedDocuments, measureRasterText, type RasterTextMeasure } from '../../src/images/rasterText.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function blank(width: number, height: number, level = 240): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(level);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width, height, rgba };
}

function fillRect(image: DecodedImage, x: number, y: number, w: number, h: number, level = 20): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) for (let c = 0; c < 3; c++) image.rgba[(yy * image.width + xx) * 4 + c] = level;
}

/** Lines of small marks (letters) on light paper. */
function pageOfSmallPrint(lines: number): DecodedImage {
  const image = blank(900, 700);
  for (let line = 0; line < lines; line++) for (let k = 0; k < 40; k++) fillRect(image, 40 + k * 20, 40 + line * 40, 6, 12);
  return image;
}

describe('measureRasterText', () => {
  it('counts the lines of letter-sized marks', () => {
    expect(measureRasterText(pageOfSmallPrint(12)).lines).toBe(12);
  });

  it('finds no line in an empty raster or in a few big shapes', () => {
    const shapes = blank(900, 700);
    fillRect(shapes, 100, 100, 300, 200);
    fillRect(shapes, 500, 300, 250, 250);
    expect(measureRasterText(blank(900, 700)).lines).toBe(0);
    expect(measureRasterText(shapes).lines).toBe(0);
  });
});

describe('looksLikeFormOrTable', () => {
  it('is true for many lines of small print on light paper ruled along the axes', () => {
    expect(looksLikeFormOrTable(pageOfSmallPrint(12))).toBe(true);
  });

  it('is false for a few lines of labels (a plan), for a dark raster, and for a tiny one', () => {
    expect(looksLikeFormOrTable(pageOfSmallPrint(3))).toBe(false);
    const dark = blank(900, 700, 30);
    for (let line = 0; line < 12; line++) for (let k = 0; k < 40; k++) fillRect(dark, 40 + k * 20, 40 + line * 40, 6, 12, 230);
    expect(looksLikeFormOrTable(dark)).toBe(false);
    expect(looksLikeFormOrTable(blank(4, 4))).toBe(false);
  });
});

describe('isPartOfSheet', () => {
  it('takes a few lines of print on light paper ruled along the axes for a part of a sheet, though it is not a form by itself', () => {
    const m = measureRasterText(pageOfSmallPrint(4));
    expect(isFormOrTable(m)).toBe(false);
    expect(isPartOfSheet(m)).toBe(true);
  });

  it('does not take a raster with hardly any print, or a dark one', () => {
    expect(isPartOfSheet(measureRasterText(pageOfSmallPrint(1)))).toBe(false);
    const dark = blank(900, 700, 30);
    for (let line = 0; line < 4; line++) for (let k = 0; k < 40; k++) fillRect(dark, 40 + k * 20, 40 + line * 40, 6, 12, 230);
    expect(isPartOfSheet(measureRasterText(dark))).toBe(false);
  });
});

describe('looksLikeDocument', () => {
  /** Lines of letters across most of the width, `rows` of them from the top to the foot, on paper. */
  function typedPage(rows: number, wide = true): DecodedImage {
    const image = blank(900, 700);
    for (let line = 0; line < rows; line++) for (let k = 0; k < (wide ? 40 : 6); k++) fillRect(image, 40 + k * 20, 30 + line * Math.floor(620 / rows), 6, 12);
    return image;
  }

  it('is true for many long lines of letters from the top of the raster to its foot', () => {
    expect(looksLikeDocument(measureRasterText(typedPage(14)))).toBe(true);
  });

  it('is false for a few long lines, for short lines only (labels), and for lines that all sit in one band', () => {
    expect(looksLikeDocument(measureRasterText(typedPage(3)))).toBe(false);
    expect(looksLikeDocument(measureRasterText(typedPage(14, false)))).toBe(false);
    const band = blank(900, 700);
    for (let line = 0; line < 8; line++) for (let k = 0; k < 40; k++) fillRect(band, 40 + k * 20, 30 + line * 16, 6, 12);
    expect(looksLikeDocument(measureRasterText(band))).toBe(false);
  });

  it('is false for a strongly coloured raster (a cover) however many lines it has', () => {
    const page = typedPage(14);
    for (let i = 0; i < page.rgba.length; i += 4) {
      page.rgba[i] = 20;
      page.rgba[i + 1] = 40;
      page.rgba[i + 2] = 200;
    }
    expect(measureRasterText(page).colourShare).toBeGreaterThan(0.9);
    expect(looksLikeDocument(measureRasterText(page))).toBe(false);
  });
});

describe('looksLikeLargePrintNote', () => {
  /** `rows` lines of 25 letters across two thirds of the width, on paper of `level`. */
  function note(rows: number, level = 240): DecodedImage {
    const image = blank(900, 700, level);
    for (let line = 0; line < rows; line++) for (let k = 0; k < 25; k++) fillRect(image, 40 + k * 24, 60 + line * 70, 10, 20);
    return image;
  }

  it('is true for a handful of long lines on light paper, and false for two lines, for twelve lines, and for dark paper', () => {
    expect(looksLikeLargePrintNote(measureRasterText(note(5)))).toBe(true);
    expect(looksLikeLargePrintNote(measureRasterText(note(2)))).toBe(false);
    expect(looksLikeLargePrintNote(measureRasterText(note(5, 90)))).toBe(false);
  });
});

describe('looksLikeDocumentOnDark', () => {
  /** `rows` lines of dark letters across half the width, on a mid-grey ground that has no light pixels. */
  function certificate(rows: number): DecodedImage {
    const image = blank(900, 700, 150);
    for (let line = 0; line < rows; line++) for (let k = 0; k < 19; k++) fillRect(image, 40 + k * 22, 30 + line * 30, 8, 14, 20);
    return image;
  }

  it('is true for about twenty lines on a grey ground, and false for few lines and for the same page on light paper', () => {
    expect(looksLikeDocumentOnDark(measureRasterText(certificate(20)))).toBe(true);
    expect(looksLikeDocumentOnDark(measureRasterText(certificate(6)))).toBe(false);
    const light = certificate(20);
    for (let i = 0; i < light.rgba.length; i += 4) if (light.rgba[i] === 150) light.rgba.fill(240, i, i + 3);
    expect(looksLikeDocumentOnDark(measureRasterText(light))).toBe(false);
  });
});

describe('letterHeightVariation and looksLikePageOfDocuments', () => {
  it('is low for lines of letters of one height and high for marks of many heights', () => {
    const even = measureRasterText(pageOfSmallPrint(12));
    expect(even.letterHeightVariation).toBeLessThan(0.05);
    const uneven = blank(900, 700);
    // Marks lying on the same levels, their heights from 7 to 16 px (a hatching, the labels of a map).
    for (let line = 0; line < 12; line++) for (let k = 0; k < 40; k++) { const h = 7 + ((k * 7 + line * 3) % 10); fillRect(uneven, 40 + k * 20, 40 + line * 40 + (16 - h) / 2, 6, h); }
    expect(measureRasterText(uneven).letterHeightVariation).toBeGreaterThan(0.2);
  });

  const page: RasterTextMeasure = { lines: 60, longLines: 4, longLineSpread: 0.3, wideLines: 30, colourShare: 0, axisShare: 0.6, lightShare: 0.88, letterHeightVariation: 0.15 };

  it('takes many lines of letters of one size on light paper for a page of documents', () => {
    expect(looksLikePageOfDocuments(page)).toBe(true);
  });

  it('does not take a hatching or a map with as many lines but letters of many sizes, a coloured page, or few lines for one', () => {
    expect(looksLikePageOfDocuments({ ...page, letterHeightVariation: 0.31 })).toBe(false);
    expect(looksLikePageOfDocuments({ ...page, colourShare: 0.3 })).toBe(false);
    expect(looksLikePageOfDocuments({ ...page, lines: 20, wideLines: 10 })).toBe(false);
    expect(looksLikePageOfDocuments({ ...page, lightShare: 0.5 })).toBe(false);
  });
});

describe('looksLikeCoveredDocument', () => {
  const memo: RasterTextMeasure = { lines: 15, longLines: 4, longLineSpread: 0.36, wideLines: 9, colourShare: 0, axisShare: 0.67, lightShare: 0.75, letterHeightVariation: 0.15 };

  it('takes what shows of a document under a picture (a good many lines of letters of one size, light paper) for a document', () => {
    expect(looksLikeCoveredDocument(memo)).toBe(true);
  });

  it('does not take a few labels, letters of many sizes, a dark or a coloured raster for one', () => {
    expect(looksLikeCoveredDocument({ ...memo, lines: 6 })).toBe(false);
    expect(looksLikeCoveredDocument({ ...memo, letterHeightVariation: 0.32 })).toBe(false);
    expect(looksLikeCoveredDocument({ ...memo, lightShare: 0.4 })).toBe(false);
    expect(looksLikeCoveredDocument({ ...memo, colourShare: 0.3 })).toBe(false);
  });
});

describe('looksLikeSlantedDocuments', () => {
  const stack: RasterTextMeasure = { lines: 23, longLines: 1, longLineSpread: 0, wideLines: 2, colourShare: 0, axisShare: 0.53, lightShare: 0.96, letterHeightVariation: 0.2 };

  it('takes many lines of letters of one size on paper that is almost all light for sheets of documents, though few lines run its width', () => {
    expect(looksLikeSlantedDocuments(stack)).toBe(true);
  });

  it('does not take a map or a plan (less light), letters of many sizes, a few lines or a coloured raster for them', () => {
    expect(looksLikeSlantedDocuments({ ...stack, lightShare: 0.92 })).toBe(false);
    expect(looksLikeSlantedDocuments({ ...stack, letterHeightVariation: 0.3 })).toBe(false);
    expect(looksLikeSlantedDocuments({ ...stack, lines: 12 })).toBe(false);
    expect(looksLikeSlantedDocuments({ ...stack, colourShare: 0.2 })).toBe(false);
  });
});

describe('looksLikeHandwrittenNote', () => {
  /** Rows of words in large writing: each word a run of joined strokes `height` px high; with `drawing`, a hatched drawing below them. */
  function note(rows: number, height: (row: number, word: number) => number, drawing = false): DecodedImage {
    const image = blank(900, 120 + rows * 90 + (drawing ? 300 : 0));
    if (drawing) for (let y = 0; y < 240; y += 6) fillRect(image, 40, 120 + rows * 90 + y, 820, 2);
    for (let row = 0; row < rows; row++) {
      let x = 40;
      for (let word = 0; word < 6; word++) {
        const h = height(row, word);
        const w = 70 + ((row * 3 + word * 5) % 4) * 15;
        const foot = 60 + row * 90 + 40;
        fillRect(image, x, foot - 3, w, 3);
        for (let s = 0; s < w; s += 12) fillRect(image, x + s, foot - h, 3, h);
        x += w + 40;
      }
    }
    return image;
  }

  it('takes a few evenly spaced rows of large words for a handwritten note', () => {
    expect(looksLikeHandwrittenNote(note(5, () => 44))).toBe(true);
    expect(looksLikeHandwrittenNote(note(5, () => 44, true))).toBe(true);
  });

  it('takes rows of smaller words for one when they are all the ink of the raster', () => {
    expect(looksLikeHandwrittenNote(note(5, () => 30))).toBe(true);
  });

  it('does not take a page of small print, too few rows, smaller words beside a drawing, or marks of many sizes (numbers on a plan, a logo) for one', () => {
    expect(looksLikeHandwrittenNote(pageOfSmallPrint(15))).toBe(false);
    expect(looksLikeHandwrittenNote(note(2, () => 44))).toBe(false);
    expect(looksLikeHandwrittenNote(note(5, () => 30, true))).toBe(false);
    expect(looksLikeHandwrittenNote(note(5, (row, word) => (word % 2 === 0 ? 20 : 80)))).toBe(false);
  });
});
