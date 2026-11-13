import type { DecodedImage } from './normalizeDecodedImage.js';

/** Width every raster is measured at: small print of a scanned form is about as tall as a letter of a page at this size. */
const MEASURE_WIDTH = 900;
/** A pixel is ink when it is this much darker than the mean of its neighbourhood (radius `LOCAL_RADIUS`). */
const INK_CONTRAST = 45;
const LOCAL_RADIUS = 12;
/** Size (at `MEASURE_WIDTH`) of a component that can be a letter. */
const GLYPH_MIN_HEIGHT = 6;
const GLYPH_MAX_HEIGHT = 34;
const GLYPH_MIN_WIDTH = 2;
const GLYPH_MAX_WIDTH = 40;
const GLYPH_MIN_AREA = 8;
/** A line of text: at least this many letters of one height on one level, spanning at least this many pixels. */
const LINE_MIN_GLYPHS = 8;
const LINE_MIN_SPAN = 80;
/** A long line: at least this many letters, across this share of the width. */
const LONG_LINE_MIN_GLYPHS = 20;
const LONG_LINE_MIN_SPAN_SHARE = 0.4;
/** A wide line: at least this many letters (large print has fewer to a line), across the same share of the width. */
const WIDE_LINE_MIN_GLYPHS = 12;
/** An edge is strong from this gradient, and axis-aligned when one component is this many times the other. */
const STRONG_EDGE = 70;
const AXIS_RATIO = 2.5;
const LIGHT_LUMINANCE = 190;

export interface RasterTextMeasure {
  /** Lines of letter-sized marks (see `LINE_MIN_GLYPHS`). */
  lines: number;
  /** Lines of at least `LONG_LINE_MIN_GLYPHS` letters that span at least `LONG_LINE_MIN_SPAN_SHARE` of the width: typed or printed text, not marks that happen to lie on a level. */
  longLines: number;
  /** The share of the raster's height between the first and the last long line. */
  longLineSpread: number;
  /** Lines of at least `WIDE_LINE_MIN_GLYPHS` letters across at least `LONG_LINE_MIN_SPAN_SHARE` of the width: the lines of a document whose letters are larger or whose lines are shorter than a typed page's. */
  wideLines: number;
  /** The share of the raster's pixels that are strongly coloured: a cover or a map is, a typed page on tinted paper hardly is. */
  colourShare: number;
  /** The share of strong edges that run along the raster's axes: a form's rules and boxes, not a drawing's curves. */
  axisShare: number;
  /** The share of the pixels that are light (paper). */
  lightShare: number;
  /** The mean, over the lines of letters, of how much the heights of their letters vary (deviation over mean): letters of one size, or marks of any. */
  letterHeightVariation: number;
}

/** A raster this size or more is a form or a table, not a drawing with some labels. Measured on a rulebook's character sheets (9-15 lines, axis 0.79-0.88, light 0.61-0.85); floor plans have at most 4 lines and a map on parchment is darker (0.51). */
const FORM_MIN_LINES = 8;
const FORM_MIN_AXIS_SHARE = 0.75;
const FORM_MIN_LIGHT_SHARE = 0.58;

/** Luminance of the raster scaled (bilinear) to `MEASURE_WIDTH`, transparent pixels as white. */
function scaledLuminance(image: DecodedImage): { luminance: Float32Array; width: number; height: number } {
  const width = MEASURE_WIDTH;
  const height = Math.max(8, Math.round((image.height * width) / image.width));
  const luminance = new Float32Array(width * height);
  const { rgba } = image;
  const at = (x: number, y: number): number => {
    const i = (y * image.width + x) * 4;
    const a = rgba[i + 3]! / 255;
    return (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * a + 255 * (1 - a);
  };
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, ((y + 0.5) * image.height) / height - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, ((x + 0.5) * image.width) / width - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      luminance[y * width + x] = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
    }
  }
  return { luminance, width, height };
}

/** A pixel is strongly coloured when its saturation is at least this and it is not nearly black. */
const STRONG_COLOUR_SATURATION = 0.45;
const STRONG_COLOUR_MIN_VALUE = 40;
/** Sampled on a grid of at most ~65k points. */
function strongColourShare(image: DecodedImage): number {
  const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / 65_536)));
  let n = 0;
  let strong = 0;
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const i = (y * image.width + x) * 4;
      const r = image.rgba[i]!;
      const g = image.rgba[i + 1]!;
      const b = image.rgba[i + 2]!;
      const max = Math.max(r, g, b);
      n++;
      if (max >= STRONG_COLOUR_MIN_VALUE && (max - Math.min(r, g, b)) / max >= STRONG_COLOUR_SATURATION) strong++;
    }
  }
  return n > 0 ? strong / n : 0;
}

export function measureRasterText(image: DecodedImage): RasterTextMeasure {
  if (image.width < 8 || image.height < 8) return { lines: 0, longLines: 0, longLineSpread: 0, wideLines: 0, colourShare: 0, axisShare: 0, lightShare: 0, letterHeightVariation: 0 };
  const { luminance: L, width: W, height: H } = scaledLuminance(image);

  let light = 0;
  let strong = 0;
  let axis = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (L[i]! >= LIGHT_LUMINANCE) light++;
      const gx = L[i + 1]! - L[i - 1]!;
      const gy = L[i + W]! - L[i - W]!;
      if (Math.hypot(gx, gy) > STRONG_EDGE) {
        strong++;
        if (Math.abs(gx) > AXIS_RATIO * Math.abs(gy) || Math.abs(gy) > AXIS_RATIO * Math.abs(gx)) axis++;
      }
    }
  }

  // Ink: darker than the local mean (integral image).
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += L[y * W + x]!;
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1]! + row;
    }
  }
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - LOCAL_RADIUS);
      const x1 = Math.min(W, x + LOCAL_RADIUS + 1);
      const y0 = Math.max(0, y - LOCAL_RADIUS);
      const y1 = Math.min(H, y + LOCAL_RADIUS + 1);
      const sum = integral[y1 * (W + 1) + x1]! - integral[y0 * (W + 1) + x1]! - integral[y1 * (W + 1) + x0]! + integral[y0 * (W + 1) + x0]!;
      if (L[y * W + x]! < sum / ((x1 - x0) * (y1 - y0)) - INK_CONTRAST) ink[y * W + x] = 1;
    }
  }

  // Connected components of ink that are the size of a letter.
  const seen = new Uint8Array(W * H);
  const glyphs: { cy: number; height: number; minX: number; maxX: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!ink[start] || seen[start]) continue;
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const height = maxY - minY + 1;
    const width = maxX - minX + 1;
    if (height >= GLYPH_MIN_HEIGHT && height <= GLYPH_MAX_HEIGHT && width >= GLYPH_MIN_WIDTH && width <= GLYPH_MAX_WIDTH && area >= GLYPH_MIN_AREA) glyphs.push({ cy: (minY + maxY) / 2, height, minX, maxX });
  }

  // Lines: letters of one height whose centres lie on one level.
  glyphs.sort((a, b) => a.cy - b.cy);
  const lines: { cy: number; height: number; count: number; minX: number; maxX: number; heightSum: number; heightSqSum: number }[] = [];
  for (const glyph of glyphs) {
    let placed = false;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
      const line = lines[k]!;
      const taller = Math.max(line.height, glyph.height);
      if (Math.abs(line.cy - glyph.cy) <= 0.4 * taller && Math.abs(line.height - glyph.height) <= 0.6 * taller) {
        line.count++;
        line.cy += (glyph.cy - line.cy) / line.count;
        line.minX = Math.min(line.minX, glyph.minX);
        line.maxX = Math.max(line.maxX, glyph.maxX);
        line.heightSum += glyph.height;
        line.heightSqSum += glyph.height * glyph.height;
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ cy: glyph.cy, height: glyph.height, count: 1, minX: glyph.minX, maxX: glyph.maxX, heightSum: glyph.height, heightSqSum: glyph.height * glyph.height });
  }
  const letterLines = lines.filter((l) => l.count >= LINE_MIN_GLYPHS && l.maxX - l.minX >= LINE_MIN_SPAN);
  const textLines = letterLines.length;
  const letterHeightVariation =
    letterLines.length > 0
      ? letterLines.reduce((sum, l) => {
          const mean = l.heightSum / l.count;
          return sum + Math.sqrt(Math.max(0, l.heightSqSum / l.count - mean * mean)) / mean;
        }, 0) / letterLines.length
      : 0;

  const long = lines.filter((l) => l.count >= LONG_LINE_MIN_GLYPHS && l.maxX - l.minX >= LONG_LINE_MIN_SPAN_SHARE * W).map((l) => l.cy).sort((a, b) => a - b);
  const longLineSpread = long.length > 0 ? (long[long.length - 1]! - long[0]!) / H : 0;
  const wideLines = lines.filter((l) => l.count >= WIDE_LINE_MIN_GLYPHS && l.maxX - l.minX >= LONG_LINE_MIN_SPAN_SHARE * W).length;

  const pixels = (W - 2) * (H - 2);
  return { lines: textLines, longLines: long.length, longLineSpread, wideLines, colourShare: strongColourShare(image), axisShare: strong > 0 ? axis / strong : 0, lightShare: light / pixels, letterHeightVariation };
}

/** Whether the raster is a form or a table whose text is part of the picture: many lines of small print on light paper ruled along the axes (the page has no text of it to find). */
export function looksLikeFormOrTable(image: DecodedImage): boolean {
  return isFormOrTable(measureRasterText(image));
}

export function isFormOrTable(m: RasterTextMeasure): boolean {
  return m.lines >= FORM_MIN_LINES && m.axisShare >= FORM_MIN_AXIS_SHARE && m.lightShare >= FORM_MIN_LIGHT_SHARE;
}

/**
 * A raster that is ruled along the axes on very light paper but has too little print to be a form by itself (a second page of a character sheet,
 * written in a handwriting that is hard to read as letters). Floor plans have the same measures, so it counts only beside a form of its own page.
 * Measured on the sheet of one rulebook: 4 lines, axis 0.81, light 0.91.
 */
const SHEET_PART_MIN_LINES = 3;
const SHEET_PART_MIN_LIGHT_SHARE = 0.85;
export function isPartOfSheet(m: RasterTextMeasure): boolean {
  return m.lines >= SHEET_PART_MIN_LINES && m.axisShare >= FORM_MIN_AXIS_SHARE && m.lightShare >= SHEET_PART_MIN_LIGHT_SHARE;
}

/**
 * A raster that is a document: many long lines of letters of one height, from near the top to near the bottom (a telegram, a letter, a typed page). A drawing in hatching has lines of marks too, but at most
 * a few of them are long, and a plate with a map has long lines among many short ones (labels). Measured on 526 rasters from nine rulebooks that have 6 or more long lines spread over 0.4 of the height: the documents
 * (telegrams, letters, typed reports, pages of text) have a fifth to nine tenths of their lines long (0.32 and more among the telegrams); the plates with a map 0.13-0.22; a cover is strongly coloured over 0.42 of it.
 */
const DOCUMENT_MIN_LONG_LINES = 6;
const DOCUMENT_MIN_SPREAD = 0.4;
const DOCUMENT_MIN_LONG_SHARE = 0.3;
const DOCUMENT_MAX_COLOUR_SHARE = 0.3;
export function looksLikeDocument(m: RasterTextMeasure): boolean {
  return m.longLines >= DOCUMENT_MIN_LONG_LINES && m.longLineSpread >= DOCUMENT_MIN_SPREAD && m.longLines >= DOCUMENT_MIN_LONG_SHARE * m.lines && m.colourShare <= DOCUMENT_MAX_COLOUR_SHARE;
}

/**
 * A note in large print on paper: a handful of lines of letters (4-14), at least half of them long, on light paper that is hardly coloured (a handout with a logo under its text). Measured on the two
 * notes of one box (5 and 6 lines, 4 and 5 of them long, 0.80 light, 0.02 colour), with room to spare because a browser measures the same raster a line or two differently than node does, and on 302 rasters from nine rulebooks that are offered as pictures and have 3 or more lines of letters: no other one is like it.
 */
const LARGE_PRINT_MIN_LINES = 4;
const LARGE_PRINT_MAX_LINES = 14;
const LARGE_PRINT_MIN_LONG_LINES = 3;
const LARGE_PRINT_MIN_LONG_SHARE = 0.5;
const LARGE_PRINT_MIN_LIGHT_SHARE = 0.6;
const LARGE_PRINT_MAX_COLOUR_SHARE = 0.15;
export function looksLikeLargePrintNote(m: RasterTextMeasure): boolean {
  return m.lines >= LARGE_PRINT_MIN_LINES && m.lines <= LARGE_PRINT_MAX_LINES && m.longLines >= LARGE_PRINT_MIN_LONG_LINES && m.longLines >= LARGE_PRINT_MIN_LONG_SHARE * m.lines && m.lightShare >= LARGE_PRINT_MIN_LIGHT_SHARE && m.colourShare <= LARGE_PRINT_MAX_COLOUR_SHARE;
}

/**
 * A document on a dark or mid-grey ground (a certificate, a form printed on grey): 15-30 lines of letters, at least 5 of them wide (12 letters across 40% of the width), few light pixels, edges that run
 * along the axes as a typed page's do. Measured on one certificate (22 lines, 6 wide, 0.09 light, 0.74 along the axes) and on the same 302 rasters: no other one is like it.
 */
const ON_DARK_MIN_LINES = 15;
const ON_DARK_MAX_LINES = 30;
const ON_DARK_MIN_WIDE_LINES = 5;
const ON_DARK_MAX_LIGHT_SHARE = 0.2;
const ON_DARK_MIN_AXIS_SHARE = 0.7;
export function looksLikeDocumentOnDark(m: RasterTextMeasure): boolean {
  return m.lines >= ON_DARK_MIN_LINES && m.lines <= ON_DARK_MAX_LINES && m.wideLines >= ON_DARK_MIN_WIDE_LINES && m.lightShare <= ON_DARK_MAX_LIGHT_SHARE && m.axisShare >= ON_DARK_MIN_AXIS_SHARE;
}

/**
 * A page of documents: sheets of typed or handwritten text, laid over one another or askew (a letter on a report, a
 * page of a diary), so that few of their lines run across the whole raster as `looksLikeDocument` asks. Many lines of
 * letters, a good part of them wide, on light paper with hardly any colour, whose letters are of one size: the marks of
 * a hatching and the labels of a map that lie on as many levels vary far more. Measured on 288 rasters of 23 books with
 * 20 or more lines of letters, of which 14 have the lines, the paper and the colour of this rule: the pages of documents
 * of two books (typed, handwritten, a record of names) at a letter height variation of 0.09-0.26, four scanned pages of
 * text of a third at 0.17-0.20, the engraved portraits, hand-drawn maps and a town plan at 0.30-0.34.
 */
const DOCUMENT_PAGE_MIN_LINES = 30;
const DOCUMENT_PAGE_MIN_WIDE_LINES = 15;
const DOCUMENT_PAGE_MIN_LIGHT_SHARE = 0.75;
const DOCUMENT_PAGE_MAX_COLOUR_SHARE = 0.1;
const DOCUMENT_PAGE_MAX_HEIGHT_VARIATION = 0.27;
export function looksLikePageOfDocuments(m: RasterTextMeasure): boolean {
  return (
    m.lines >= DOCUMENT_PAGE_MIN_LINES &&
    m.wideLines >= DOCUMENT_PAGE_MIN_WIDE_LINES &&
    m.lightShare >= DOCUMENT_PAGE_MIN_LIGHT_SHARE &&
    m.colourShare <= DOCUMENT_PAGE_MAX_COLOUR_SHARE &&
    m.letterHeightVariation <= DOCUMENT_PAGE_MAX_HEIGHT_VARIATION
  );
}

/**
 * What shows of a document that a picture lies over (a memo under a photograph): fewer lines of letters than a page of
 * documents has, but still a good many, of one size, on light paper with hardly any colour. Taken for a document only
 * together with the picture painted over it (see `buildImageExtraction.ts`). Measured on one memo under a photograph:
 * 15 lines, a letter height variation of 0.15, 0.75 light; the engravings and maps that have as many lines vary 0.30 and
 * more.
 */
const COVERED_DOCUMENT_MIN_LINES = 10;
const COVERED_DOCUMENT_MIN_LIGHT_SHARE = 0.7;
export function looksLikeCoveredDocument(m: RasterTextMeasure): boolean {
  return m.lines >= COVERED_DOCUMENT_MIN_LINES && m.lightShare >= COVERED_DOCUMENT_MIN_LIGHT_SHARE && m.colourShare <= DOCUMENT_PAGE_MAX_COLOUR_SHARE && m.letterHeightVariation <= DOCUMENT_PAGE_MAX_HEIGHT_VARIATION;
}

/**
 * Sheets of documents laid askew (a stack of papers fanned on the page): their lines run slanted, so few of them run
 * the raster's width, as `looksLikePageOfDocuments` asks; but the raster is still many lines of letters of one size on
 * paper that is almost all light. Measured on 1064 pictures offered from 23 books: such a stack had 23 lines, 0.96
 * light, a letter height variation of 0.20; the maps, plans and scanned pages with as many even lines were 0.92 light at
 * most.
 */
const SLANTED_DOCUMENTS_MIN_LINES = 20;
const SLANTED_DOCUMENTS_MIN_LIGHT_SHARE = 0.94;
const SLANTED_DOCUMENTS_MAX_HEIGHT_VARIATION = 0.22;
const SLANTED_DOCUMENTS_MAX_COLOUR_SHARE = 0.05;
export function looksLikeSlantedDocuments(m: RasterTextMeasure): boolean {
  return m.lines >= SLANTED_DOCUMENTS_MIN_LINES && m.lightShare >= SLANTED_DOCUMENTS_MIN_LIGHT_SHARE && m.letterHeightVariation <= SLANTED_DOCUMENTS_MAX_HEIGHT_VARIATION && m.colourShare <= SLANTED_DOCUMENTS_MAX_COLOUR_SHARE;
}

/**
 * A note in large handwriting (a sticky note, a scribble on a card): its words are joined letters, bigger than the
 * letters `measureRasterText` looks for once the raster is scaled to its width, so it finds no line in it. The raster is
 * measured again at `NOTE_WIDTH`: marks the size of a word (joined letters), on rows of at least three that run across a
 * good part of the raster, the rows at one spacing. A note has a few such rows of large writing; a page of print, a map
 * or a scan of a book has rows of small marks. Measured on 1064 pictures offered from 23 books: the eight notes of one
 * book had 4-11 rows, their marks 19.4-24.4 px high, varying 0.27-0.37 within a row, at a spacing regularity of
 * 0.75-1; the floor plans and posters with numbers or letters as large had marks of 16-17 px, and the few other
 * pictures with marks of 19 px and more varied 0.41 and more (a logo, a plan) or had rows at no one spacing (the brush
 * strokes of a painting, four rows with one gap of three off: 0.67).
 *
 * A note in smaller writing on a wide sheet (a few lines in a circle drawn round them) is told by its ink instead: almost
 * all of it lies in the rows of words (the circle round them is a thin line). The notes had 0.72-0.97 of their ink in
 * their rows (one with black bars of a redaction over it, 0.41, is large writing); every other picture with rows as
 * regular had 0.63 at most.
 */
const NOTE_WIDTH = 450;
const NOTE_INK_RADIUS = 10;
const NOTE_INK_CONTRAST = 40;
const NOTE_MARK_MIN_HEIGHT = 6;
const NOTE_MARK_MAX_HEIGHT = 45;
const NOTE_MARK_MIN_WIDTH = 3;
const NOTE_MARK_MAX_WIDTH = 200;
const NOTE_MARK_MIN_AREA = 12;
const NOTE_MARK_MAX_ASPECT = 14;
const NOTE_ROW_MIN_MARKS = 3;
const NOTE_ROW_MIN_SPAN_SHARE = 0.35;
const NOTE_MIN_ROWS = 4;
const NOTE_MIN_MARK_HEIGHT = 19;
const NOTE_MAX_HEIGHT_VARIATION = 0.38;
const NOTE_MIN_ROW_INK_SHARE = 0.68;
const NOTE_ONLY_WRITING_MIN_MARK_HEIGHT = 13;
const NOTE_MAX_ROBUST_VARIATION = 0.35;
const NOTE_MIN_SPACING_REGULARITY = 0.7;
const NOTE_SPACING_TOLERANCE = 0.3;
const NOTE_MIN_LIGHT_SHARE = 0.75;
const NOTE_MAX_COLOUR_SHARE = 0.1;

/** What `looksLikeHandwrittenNote` measures. */
export interface HandwritingMeasure {
  /** Rows of word-size marks. */
  rows: number;
  /** Mean height of the marks of a row (px at `NOTE_WIDTH`), averaged over the rows. */
  meanHeight: number;
  /** Spread of the marks' heights within a row, to their mean (standard deviation) and to their median (median deviation), averaged over the rows. */
  variation: number;
  robustVariation: number;
  /** Share of the gaps between the rows that are the median gap. */
  regularity: number;
  /** Share of the raster's ink that lies in the marks of the rows. */
  rowInkShare: number;
}

export function looksLikeHandwrittenNote(image: DecodedImage): boolean {
  const m = measureHandwriting(image);
  if (m === null || m.rows < NOTE_MIN_ROWS || m.regularity < NOTE_MIN_SPACING_REGULARITY) return false;
  const largeWriting = m.meanHeight >= NOTE_MIN_MARK_HEIGHT && m.variation <= NOTE_MAX_HEIGHT_VARIATION;
  const onlyWriting = m.rowInkShare >= NOTE_MIN_ROW_INK_SHARE && m.meanHeight >= NOTE_ONLY_WRITING_MIN_MARK_HEIGHT && m.robustVariation <= NOTE_MAX_ROBUST_VARIATION;
  return largeWriting || onlyWriting;
}

/** The handwriting measure of a light, colourless raster (see `looksLikeHandwrittenNote`); `null` when it is too small, dark or coloured, or has fewer than two rows. */
export function measureHandwriting(image: DecodedImage): HandwritingMeasure | null {
  if (image.width < 8 || image.height < 8) return null;
  const W = NOTE_WIDTH;
  const H = Math.max(8, Math.round((image.height * W) / image.width));
  // Nearest pixel of the raster for every cell, transparent pixels as white paper.
  const L = new Float32Array(W * H);
  let light = 0;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / W));
      const i = (sy * image.width + sx) * 4;
      const a = image.rgba[i + 3]! / 255;
      const v = (0.299 * image.rgba[i]! + 0.587 * image.rgba[i + 1]! + 0.114 * image.rgba[i + 2]!) * a + 255 * (1 - a);
      L[y * W + x] = v;
      if (v >= LIGHT_LUMINANCE) light++;
    }
  }
  if (light < NOTE_MIN_LIGHT_SHARE * W * H || strongColourShare(image) > NOTE_MAX_COLOUR_SHARE) return null;

  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += L[y * W + x]!;
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1]! + row;
    }
  }
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - NOTE_INK_RADIUS);
      const x1 = Math.min(W, x + NOTE_INK_RADIUS + 1);
      const y0 = Math.max(0, y - NOTE_INK_RADIUS);
      const y1 = Math.min(H, y + NOTE_INK_RADIUS + 1);
      const sum = integral[y1 * (W + 1) + x1]! - integral[y0 * (W + 1) + x1]! - integral[y1 * (W + 1) + x0]! + integral[y0 * (W + 1) + x0]!;
      if (L[y * W + x]! < sum / ((x1 - x0) * (y1 - y0)) - NOTE_INK_CONTRAST) ink[y * W + x] = 1;
    }
  }

  // Marks the size of a word.
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const marks: { cy: number; height: number; width: number; minX: number; maxX: number; area: number }[] = [];
  let inkArea = 0;
  for (let start = 0; start < W * H; start++) {
    if (!ink[start] || seen[start]) continue;
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    inkArea += area;
    const height = maxY - minY + 1;
    const width = maxX - minX + 1;
    if (height >= NOTE_MARK_MIN_HEIGHT && height <= NOTE_MARK_MAX_HEIGHT && width >= NOTE_MARK_MIN_WIDTH && width <= NOTE_MARK_MAX_WIDTH && area >= NOTE_MARK_MIN_AREA && width / height <= NOTE_MARK_MAX_ASPECT) {
      marks.push({ cy: (minY + maxY) / 2, height, width, minX, maxX, area });
    }
  }

  // Rows: marks whose centres lie within half a mark's height of the row's.
  marks.sort((a, b) => a.cy - b.cy);
  const rows: { cy: number; count: number; minX: number; maxX: number; heightSum: number; heightSqSum: number; heights: number[]; area: number }[] = [];
  for (const mark of marks) {
    let placed = false;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      const row = rows[k]!;
      if (Math.abs(row.cy - mark.cy) <= 0.5 * Math.max(row.heightSum / row.count, mark.height)) {
        row.count++;
        row.cy += (mark.cy - row.cy) / row.count;
        row.minX = Math.min(row.minX, mark.minX);
        row.maxX = Math.max(row.maxX, mark.maxX);
        row.heightSum += mark.height;
        row.heightSqSum += mark.height * mark.height;
        row.heights.push(mark.height);
        row.area += mark.area;
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ cy: mark.cy, count: 1, minX: mark.minX, maxX: mark.maxX, heightSum: mark.height, heightSqSum: mark.height * mark.height, heights: [mark.height], area: mark.area });
  }
  const written = rows.filter((r) => r.count >= NOTE_ROW_MIN_MARKS && r.maxX - r.minX >= NOTE_ROW_MIN_SPAN_SHARE * W);
  if (written.length < 2) return null;
  const meanHeight = written.reduce((sum, r) => sum + r.heightSum / r.count, 0) / written.length;
  const variation =
    written.reduce((sum, r) => {
      const mean = r.heightSum / r.count;
      return sum + Math.sqrt(Math.max(0, r.heightSqSum / r.count - mean * mean)) / mean;
    }, 0) / written.length;
  const gaps = written
    .slice(1)
    .map((r, i) => r.cy - written[i]!.cy)
    .sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)]!;
  const regularity = gaps.filter((g) => Math.abs(g - medianGap) <= NOTE_SPACING_TOLERANCE * medianGap).length / gaps.length;
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const robustVariation = written.reduce((sum, r) => {
    const m = median(r.heights);
    return sum + median(r.heights.map((h) => Math.abs(h - m))) / m;
  }, 0) / written.length;
  return { rows: written.length, meanHeight, variation, robustVariation, regularity, rowInkShare: written.reduce((sum, r) => sum + r.area, 0) / Math.max(1, inkArea) };
}
