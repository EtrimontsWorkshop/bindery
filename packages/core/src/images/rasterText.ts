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
  if (image.width < 8 || image.height < 8) return { lines: 0, longLines: 0, longLineSpread: 0, wideLines: 0, colourShare: 0, axisShare: 0, lightShare: 0 };
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
  const lines: { cy: number; height: number; count: number; minX: number; maxX: number }[] = [];
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
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ cy: glyph.cy, height: glyph.height, count: 1, minX: glyph.minX, maxX: glyph.maxX });
  }
  const textLines = lines.filter((l) => l.count >= LINE_MIN_GLYPHS && l.maxX - l.minX >= LINE_MIN_SPAN).length;

  const long = lines.filter((l) => l.count >= LONG_LINE_MIN_GLYPHS && l.maxX - l.minX >= LONG_LINE_MIN_SPAN_SHARE * W).map((l) => l.cy).sort((a, b) => a - b);
  const longLineSpread = long.length > 0 ? (long[long.length - 1]! - long[0]!) / H : 0;
  const wideLines = lines.filter((l) => l.count >= WIDE_LINE_MIN_GLYPHS && l.maxX - l.minX >= LONG_LINE_MIN_SPAN_SHARE * W).length;

  const pixels = (W - 2) * (H - 2);
  return { lines: textLines, longLines: long.length, longLineSpread, wideLines, colourShare: strongColourShare(image), axisShare: strong > 0 ? axis / strong : 0, lightShare: light / pixels };
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
