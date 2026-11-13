import { rectArea, rectIntersection, unionRect, type Matrix, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorShape } from '../inventory/vectorRegistry.js';
import { confidenceForReason, FLUSH_UNDECIDED_REASON, isBackdropShape, isTranslucentEverywhere, type ClassifiedImage } from './classify.js';
import { isFormOrTable, looksLikeDocument, looksLikeDocumentOnDark, looksLikeHandwrittenNote, looksLikeLargePrintNote, looksLikePageOfDocuments, looksLikeSlantedDocuments, measureRasterText } from './rasterText.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { findLineDrawings } from './vectorFigures.js';
import { CO_MEMBER_SIGNIFICANT_AREA } from './strategy.js';
import type { ExtractionUnit } from './extractionTypes.js';
import { BOXES_MAX_OVERLAP_SHARE, CLIPPED_PIECES_REASON, FRAMES_MAX_OVERLAP_SHARE, GRID_PICTURE_MIN_TILES, LAYOUT_CARD_MIN_AREA, MOSAIC_MAX_SEAM_DIFFERENCE, MOSAIC_MAX_SEAM_PT, MOSAIC_TILE_MAX_PAGE_SHARE, SLICED_PICTURE_REASON, SMALL_SLICED_PICTURE_MIN_PIECES, SPLIT_BANNER_MASKED_MIN_AREA, SPLIT_BANNER_REPRESENTATIVE_MIN_AREA, SPLIT_TEXT_CARD_MAX_PICTURE_ON_CARD, SPLIT_TEXT_CARD_MIN_COVERAGE, SPLIT_TEXT_CARD_PICTURE_MIN_AREA, TILED_RECTANGLE_MAX_FILL_ERROR, TILED_RECTANGLE_MAX_STRIPS, TILED_RECTANGLE_MIN_STRIP_ASPECT, type TileSource, areMosaicTiles, areSeamedTiles, areSlicesOfOnePicture, isPanelBehindFigure, isPieceOf, isRepaintOf, joinBrickTiles, seamDifference, visibleWindow, windowsAreApart, withoutRepaints } from './extractionPieces.js';
import { HIGH_TEXT_COVERAGE_REASON, SPLIT_OFF_MIN_AREA, SPLIT_PEER_MIN_SHARE, textCoverage } from './extractionLooks.js';

/**
 * Image extraction, JOINING and SPLITTING units: mosaics and tiled rectangles joined into one picture, pieces turned
 * or composed over a box, frames of text boxes, line drawings, and units that hold several distinct pictures.
 * Moved out of `buildImageExtraction.ts` unchanged.
 */

/**
 * The units of a page whose pictures are tiles of one picture (see `areMosaicTiles`), each offered or undecided, that
 * meet without a change of content across the seam (see `MOSAIC_MAX_SEAM_DIFFERENCE`), joined into one unit: its region
 * is the union of theirs, its representative the largest tile's.
 */
export function joinMosaicTiles(units: readonly ExtractionUnit[], leftovers: readonly ClassifiedImage[] = [], pageBoxByPage?: ReadonlyMap<number, Rect>, textBoxesByPage?: ReadonlyMap<number, readonly Rect[]>): ExtractionUnit[] {
  const isTile = (u: ExtractionUnit): boolean => u.representativeEntry !== null && (u.classification === 'content' || u.classification === 'undecided');
  // Two pictures of their own set edge to edge (two frames of a strip) differ across the seam; the tiles of one picture run on across it.
  const meetSeamlessly = (a: ExtractionUnit, b: ExtractionUnit): boolean =>
    a.memberEntries.some((ma) =>
      b.memberEntries.some((mb) => {
        const boxA = ma.occurrences.find((o) => o.page === a.page)?.bbox;
        const boxB = mb.occurrences.find((o) => o.page === b.page)?.bbox;
        if (boxA === undefined || boxB === undefined || ma.maxRelativeArea >= MOSAIC_TILE_MAX_PAGE_SHARE || mb.maxRelativeArea >= MOSAIC_TILE_MAX_PAGE_SHARE) return false;
        const difference = seamDifference({ box: boxA, fingerprint: ma.contentFingerprint }, { box: boxB, fingerprint: mb.contentFingerprint });
        return difference !== null && difference <= MOSAIC_MAX_SEAM_DIFFERENCE;
      }),
    );
  const out = [...units];
  let joined = true;
  while (joined) {
    joined = false;
    for (let i = 0; i < out.length && !joined; i++) {
      for (let j = i + 1; j < out.length && !joined; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.page !== b.page || !isTile(a) || !isTile(b) || !areMosaicTiles(a.bbox, b.bbox) || !meetSeamlessly(a, b)) continue;
        const larger = (b.representativeEntry?.maxRelativeArea ?? 0) > (a.representativeEntry?.maxRelativeArea ?? 0) ? b : a;
        out[i] = {
          ...larger,
          memberEntries: [...a.memberEntries, ...b.memberEntries],
          bbox: unionRect(a.bbox, b.bbox),
          clusterMemberCount: a.clusterMemberCount + b.clusterMemberCount,
          classification: a.classification === 'content' || b.classification === 'content' ? 'content' : 'undecided',
        };
        out.splice(j, 1);
        joined = true;
      }
    }
  }
  return joinBrickTiles(joinTiledRectangles(out, leftovers, isTile, meetSeamlessly), leftovers, isTile, pageBoxByPage, textBoxesByPage);
}

/** Whether an image reads as a form, a table or a document by its pixels (lines of text, rows, a handwritten note). */
export function readsAsDocument(measure: ReturnType<typeof measureRasterText>, image: DecodedImage): boolean {
  return isFormOrTable(measure) || looksLikeDocument(measure) || looksLikeLargePrintNote(measure) || looksLikeDocumentOnDark(measure) || looksLikePageOfDocuments(measure) || looksLikeSlantedDocuments(measure) || looksLikeHandwrittenNote(image);
}
export function looksLikeDocumentImage(image: DecodedImage): boolean {
  return readsAsDocument(measureRasterText(image), image);
}
/**
 * A raster under the page's text is a drawing (taken by itself) when its luminance spreads this much at least; blank paper or a plain card the
 * page writes on spreads less. Measured on two books: a sepia sketch under a column of text 47, the paper of notes and handouts 3-25.
 */
export const DRAWING_UNDER_PAGE_TEXT_MIN_STDDEV = 35;
/**
 * ... and when the raster is white where the page's words lie (the text set on the blank of the drawing): its mean luminance there this much
 * at least, its colour (max - min of the channels) this much at most. A newspaper or a sheet of paper the text is printed on is tinted, a panel
 * of a sidebar dark.
 */
export const DRAWING_UNDER_PAGE_TEXT_MIN_WHITE = 240;
export const DRAWING_UNDER_PAGE_TEXT_MAX_CHROMA = 12;

/** Mean luminance and colour of the opaque pixels of `image` (painted upright over `box`) that lie under the `boxes` of the page; `null` when none do. */
export function meanUnderBoxes(image: DecodedImage, box: Rect, boxes: readonly Rect[]): { luminance: number; chroma: number } | null {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (w <= 0 || h <= 0) return null;
  let sum = 0;
  let chroma = 0;
  let count = 0;
  for (const b of boxes) {
    const cut = rectIntersection(b, box);
    if (cut === null) continue;
    const x0 = Math.max(0, Math.floor(((cut.minX - box.minX) / w) * image.width));
    const x1 = Math.min(image.width, Math.ceil(((cut.maxX - box.minX) / w) * image.width));
    const y0 = Math.max(0, Math.floor(((box.maxY - cut.maxY) / h) * image.height));
    const y1 = Math.min(image.height, Math.ceil(((box.maxY - cut.minY) / h) * image.height));
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 6));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const at = (y * image.width + x) * 4;
        if (image.rgba[at + 3]! <= 16) continue;
        const r = image.rgba[at]!;
        const g = image.rgba[at + 1]!;
        const bl = image.rgba[at + 2]!;
        sum += 0.299 * r + 0.587 * g + 0.114 * bl;
        chroma += Math.max(r, g, bl) - Math.min(r, g, bl);
        count++;
      }
    }
  }
  return count === 0 ? null : { luminance: sum / count, chroma: chroma / count };
}

/**
 * The reason of a half of a picture laid aslant across a spread (a turned map cut by each page): rendered from its page, the left half over
 * what it shows up to the page's right edge, the right half from the page's left edge over the same heights.
 */
export const ASLANT_HALF_REASON = 'Z28-aslant-half-across-spread';
/**
 * The reason of a picture that was hidden (a strip at the gutter taken for an ornament, a stain, a backdrop) and that stands for the other half of
 * an offered picture across a spread: it is joined to it, and is never offered by itself.
 */
export const SPREAD_COMPANION_REASON = 'Z29-spread-companion';
/** A hidden picture this share of its page at least may be the other half of an offered one (a strip at the gutter, 175 pt wide, 0.09). */
export const SPREAD_COMPANION_MIN_AREA = 0.03;
/**
 * A picture painted turned on the page as pieces turned alike (a photograph laid aslant, stored as its left and right parts): where each piece lies
 * in the frame of the first one's pixels (y up), when all of them stand upright there, at about the first one's pixel density
 * (`TURNED_PIECES_MAX_DENSITY_DIFFERENCE`), and together fill the rectangle of their union (`TURNED_PIECES_MAX_FILL_ERROR`); `null` otherwise.
 * Laid over one another there (see `composeOverBox`), they are the picture upright, without the page round its tilted edges.
 */
export const TURNED_PIECES_MAX_SKEW = 0.01;
export const TURNED_PIECES_MAX_DENSITY_DIFFERENCE = 0.03;
export const TURNED_PIECES_MAX_FILL_ERROR = 0.05;

export function turnedPiecesFrame(pieces: readonly { ctm: Matrix; width: number; height: number }[]): Rect[] | null {
  if (pieces.length < 2) return null;
  const [a, b, c, d, e, f] = pieces[0]!.ctm;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  const toFirst = (x: number, y: number): [number, number] => {
    const px = x - e;
    const py = y - f;
    return [((d * px - c * py) / det) * pieces[0]!.width, ((-b * px + a * py) / det) * pieces[0]!.height];
  };
  const boxes: Rect[] = [];
  for (const p of pieces) {
    const [ma, mb, mc, md, me, mf] = p.ctm;
    const o = toFirst(me, mf);
    const u = toFirst(ma + me, mb + mf);
    const v = toFirst(mc + me, md + mf);
    const ux = u[0] - o[0];
    const uy = u[1] - o[1];
    const vx = v[0] - o[0];
    const vy = v[1] - o[1];
    if (ux <= 0 || vy <= 0 || Math.abs(uy) > TURNED_PIECES_MAX_SKEW * ux || Math.abs(vx) > TURNED_PIECES_MAX_SKEW * vy) return null;
    if (Math.abs(ux - p.width) > TURNED_PIECES_MAX_DENSITY_DIFFERENCE * p.width || Math.abs(vy - p.height) > TURNED_PIECES_MAX_DENSITY_DIFFERENCE * p.height) return null;
    boxes.push({ minX: o[0], minY: o[1], maxX: o[0] + ux, maxY: o[1] + vy });
  }
  const union = boxes.slice(1).reduce((r, bx) => unionRect(r, bx), boxes[0]!);
  const filled = boxes.reduce((sum, bx) => sum + rectArea(bx), 0);
  return Math.abs(filled - rectArea(union)) <= TURNED_PIECES_MAX_FILL_ERROR * rectArea(union) ? boxes : null;
}

/**
 * Rasters laid over one another (source over, in the order of `index`) in `box`, each over its own box (PDF points, y up), at the finest
 * scale of them.
 */
export function composeOverBox(pieces: readonly { image: DecodedImage; box: Rect; index: number }[], box: Rect): DecodedImage | null {
  const boxWidth = box.maxX - box.minX;
  const boxHeight = box.maxY - box.minY;
  if (pieces.length === 0 || boxWidth <= 0 || boxHeight <= 0) return null;
  const scale = Math.max(...pieces.map((p) => p.image.width / Math.max(1e-6, p.box.maxX - p.box.minX)));
  const width = Math.max(1, Math.round(boxWidth * scale));
  const height = Math.max(1, Math.round(boxHeight * scale));
  if (width * height > 64e6) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const p of [...pieces].sort((a, b) => a.index - b.index)) {
    const x0 = Math.round((p.box.minX - box.minX) * scale);
    const y0 = Math.round((box.maxY - p.box.maxY) * scale);
    const w = Math.max(1, Math.round((p.box.maxX - p.box.minX) * scale));
    const h = Math.max(1, Math.round((p.box.maxY - p.box.minY) * scale));
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      const sy = Math.min(p.image.height - 1, Math.floor(((y - y0) * p.image.height) / h));
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const sx = Math.min(p.image.width - 1, Math.floor(((x - x0) * p.image.width) / w));
        const si = (sy * p.image.width + sx) * 4;
        const di = (y * width + x) * 4;
        const a = p.image.rgba[si + 3]! / 255;
        const under = rgba[di + 3]! / 255;
        const out = a + under * (1 - a);
        if (out <= 0) continue;
        for (let c = 0; c < 3; c++) rgba[di + c] = (p.image.rgba[si + c]! * a + rgba[di + c]! * under * (1 - a)) / out;
        rgba[di + 3] = out * 255;
      }
    }
  }
  return { width, height, rgba };
}
/**
 * The reason of a picture stored in pieces side by side (an offered masked raster and masked rasters beside it that blend into it, hidden as
 * cut-outs at the page's edge): one unit over their joined box, taken from their own pixels laid over one another (see `composeOverBox`).
 */
export const PIECED_PICTURE_REASON = 'Z30-picture-in-pieces';
/** ... the pieces beside it share this share of the height of the smaller of the two at least, ... */
export const PIECE_MIN_HEIGHT_OVERLAP = 0.8;
/** ... and widen it by this share of its width at least (a frame or a mask laid over it adds nothing). */
export const PIECE_MIN_WIDTH_GAIN = 0.3;
/**
 * A raster that is the frame of a box of text: blank (transparent, or the white of its paper) over this share of it at least, and drawn only in
 * bars across its whole width (a header bar, a rule at the foot) and thin sides. Each row of it is either drawn across nearly all its width or
 * nearly blank (a few rows at the bars' rounded ends aside), and most rows are blank. Measured: the frame of a sidebar 0.82 blank, a box of a
 * list 0.96; splashes of ink and cut-out figures are drawn over part of the width of their rows. Or a frame drawn round its edges with nothing
 * within them (see `FRAME_INSET_SHARE`).
 */
export const FRAME_MIN_TRANSPARENT_SHARE = 0.6;
/** ... or, whatever its reason, when the page's text covers this share of its box at least (an empty box with a list set in it). */
export const FRAME_MIN_TEXT_COVERAGE = 0.3;
export const FRAME_FULL_ROW_SHARE = 0.85;
export const FRAME_BLANK_ROW_SHARE = 0.06;
export const FRAME_MAX_MIXED_ROW_SHARE = 0.08;
export const FRAME_MIN_BLANK_ROW_SHARE = 0.4;
export const FRAME_INSET_SHARE = 0.2;
export const FRAME_MAX_INNER_VISIBLE_SHARE = 0.02;
/**
 * A flat fill: the visible pixels of a raster are one colour, their luminance spread this much at most (a dark header bar of a box of text: 1.2;
 * the illustrations of the same book 20 and more). Under the page's text it is the box's ground, no picture.
 */
export const FLAT_FILL_MAX_STDDEV = 3;
export const FLAT_FILL_MIN_VISIBLE_SHARE = 0.2;
export function isFlatFill(image: DecodedImage): boolean {
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 20000)));
  let seen = 0;
  let visible = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      seen++;
      if (image.rgba[i + 3]! <= 32) continue;
      const l = 0.299 * image.rgba[i]! + 0.587 * image.rgba[i + 1]! + 0.114 * image.rgba[i + 2]!;
      visible++;
      sum += l;
      sumSq += l * l;
    }
  }
  if (seen === 0 || visible / seen < FLAT_FILL_MIN_VISIBLE_SHARE) return false;
  const mean = sum / visible;
  return Math.sqrt(Math.max(0, sumSq / visible - mean * mean)) <= FLAT_FILL_MAX_STDDEV;
}
/**
 * A frame drawn around a picture as a raster of its own, painted over it and transparent within (an ornamented border of a page-sized
 * illustration): the picture under it was taken for covered (see `Z17-covered-by-later-picture`), the frame offered in its stead. Transparent
 * within on this share of its middle at least (the inset is this share of each side).
 */
export const FRAME_AROUND_PICTURE_MIN_TRANSPARENT_SHARE = 0.95;
export const FRAME_AROUND_PICTURE_INSET = 0.15;
/** ... and the picture under it lies within it on this share of its box at least. */
export const FRAME_AROUND_PICTURE_MIN_INSIDE_SHARE = 0.9;
export const COVERED_BY_LATER_REASON = 'Z17-covered-by-later-picture';
export function isEmptyWithin(image: DecodedImage): boolean {
  const x0 = Math.floor(image.width * FRAME_AROUND_PICTURE_INSET);
  const x1 = Math.ceil(image.width * (1 - FRAME_AROUND_PICTURE_INSET));
  const y0 = Math.floor(image.height * FRAME_AROUND_PICTURE_INSET);
  const y1 = Math.ceil(image.height * (1 - FRAME_AROUND_PICTURE_INSET));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  let seen = 0;
  let clear = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      seen++;
      if (image.rgba[(y * image.width + x) * 4 + 3]! <= 32) clear++;
    }
  }
  return seen > 0 && clear / seen >= FRAME_AROUND_PICTURE_MIN_TRANSPARENT_SHARE;
}
export function isFrameOfTextBox(image: DecodedImage): boolean {
  if (image.width === 0 || image.height === 0) return false;
  let blank = 0;
  let mixedRows = 0;
  let blankRows = 0;
  for (let y = 0; y < image.height; y++) {
    let drawn = 0;
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      // Transparent, or the white paper of the box.
      if (image.rgba[i + 3]! > 32 && Math.min(image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!) < 240) drawn++;
      else blank++;
    }
    const share = drawn / image.width;
    if (share <= FRAME_BLANK_ROW_SHARE) blankRows++;
    else if (share < FRAME_FULL_ROW_SHARE) mixedRows++;
  }
  if (blank / (image.width * image.height) < FRAME_MIN_TRANSPARENT_SHARE) return false;
  if (mixedRows / image.height <= FRAME_MAX_MIXED_ROW_SHARE && blankRows / image.height >= FRAME_MIN_BLANK_ROW_SHARE) return true;
  // A frame drawn round its edges (thorns round a page): nothing drawn within them, inset by `FRAME_INSET_SHARE` on each side.
  let inner = 0;
  let innerDrawn = 0;
  for (let y = Math.floor(image.height * FRAME_INSET_SHARE); y < image.height * (1 - FRAME_INSET_SHARE); y++) {
    for (let x = Math.floor(image.width * FRAME_INSET_SHARE); x < image.width * (1 - FRAME_INSET_SHARE); x++) {
      const i = (y * image.width + x) * 4;
      inner++;
      if (image.rgba[i + 3]! > 32 && Math.min(image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!) < 240) innerDrawn++;
    }
  }
  return inner > 0 && innerDrawn / inner <= FRAME_MAX_INNER_VISIBLE_SHARE;
}
/**
 * A cut-out object laid over the page's edge is a prop of the page's design (see `tossedProp`) when this share of its box at least lies off the
 * page, it is this share of the page at most, and its ground (transparent, or white) is this share of what is taken of it at least.
 */
export const PROP_MIN_OFF_PAGE_SHARE = 0.2;
export const PROP_MAX_PAGE_SHARE = 0.5;
export const PROP_MIN_BLANK_GROUND_SHARE = 0.5;
/**
 * A book with this many props tossed over the page's edge at least (offered but for that, see `tossedProp`) is strewn with props: its cut-out
 * objects on a blank ground are props too, wherever they lie (dice, coins, bullet holes, a key, handcuffs, a coffee ring). Measured: 29-32 in two
 * books strewn with props, at most 9 in thirty-five others, whose cut-outs are sketches, weapons, shields, rings and the logos of patrons.
 */
export const BOOK_OF_PROPS_MIN_COUNT = 15;
/** ... counting only props this many times longer than wide at most. */
export const PROP_MAX_ASPECT = 4;
/**
 * ... a cut-out object of such a book: blank (transparent or white) over this share of its raster at least, and covering this share of the page
 * at most (its box less its ground). The illustrations of those books are opaque (blank 0-0.1); the props 0.6-0.93 blank.
 */
export const BOOK_PROP_MIN_BLANK_GROUND_SHARE = 0.55;
export const BOOK_PROP_MAX_DRAWN_SHARE = 0.35;
/** ... a render of it judged when the page's text covers this share of it at most. */
export const BOOK_PROP_MAX_TEXT_COVERAGE = 0.02;
/** ... and a render of one whose own raster is paper over this share at least: a stain of the paper (1.00), nothing drawn. */
export const BOOK_PROP_MIN_PAPER_STAIN_SHARE = 0.98;
/**
 * The share of an image's pixels that are its ground or its paper: transparent, or light and nearly grey (the off-white paper of a torn strip or
 * of a card a prop is pinned to, 225-245, is not white).
 */
export const PAPER_MIN_CHANNEL = 215;
export const PAPER_MAX_CHROMA = 25;
export function paperGroundShare(image: DecodedImage): number {
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 20000)));
  let seen = 0;
  let paper = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      seen++;
      const r = image.rgba[i]!;
      const g = image.rgba[i + 1]!;
      const b = image.rgba[i + 2]!;
      if (image.rgba[i + 3]! <= 32 || (Math.min(r, g, b) >= PAPER_MIN_CHANNEL && Math.max(r, g, b) - Math.min(r, g, b) <= PAPER_MAX_CHROMA)) paper++;
    }
  }
  return seen === 0 ? 0 : paper / seen;
}
/** The share of `box` that lies outside `pageBox`. */
export function offPageShare(box: Rect, pageBox: Rect): number {
  const area = (box.maxX - box.minX) * (box.maxY - box.minY);
  if (area <= 0) return 0;
  const inside = rectIntersection(box, pageBox);
  return 1 - (inside === null ? 0 : (inside.maxX - inside.minX) * (inside.maxY - inside.minY)) / area;
}
/** The share of an image's pixels that are its ground: transparent, or near white. */
export function blankGroundShare(image: DecodedImage): number {
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 20000)));
  let seen = 0;
  let blank = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      seen++;
      if (image.rgba[i + 3]! <= 32 || Math.min(image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!) >= 240) blank++;
    }
  }
  return seen === 0 ? 0 : blank / seen;
}
/** A half of a picture across a spread is a strip at the gutter when it is this share of its page's width at most (the strips found: 0.13-0.24). */
export const SPREAD_STRIP_MAX_WIDTH_SHARE = 0.4;
/**
 * A half of a picture across a spread shows something on this share of its pixels at least (not transparent). The halves of one raster cut at the
 * gutter are joined even when one is a white strip (the raster goes on to the page's edge); a half that is all transparent (a masked picture's empty
 * margin on a page beside a picture of the facing one) adds nothing: 0.00 there, 0.07 for the thinnest drawn strip.
 */
export const SPREAD_HALF_MIN_VISIBLE_SHARE = 0.02;
export function visibleShareOf(image: DecodedImage): number {
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 20000)));
  let seen = 0;
  let visible = 0;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      seen++;
      if (image.rgba[(y * image.width + x) * 4 + 3]! > 32) visible++;
    }
  }
  return seen === 0 ? 0 : visible / seen;
}
/** The turned raster of such a half runs past the page's edge by this much at least (pt). */
export const ASLANT_HALF_MIN_PAST_EDGE_PT = 2;
/** ... and the two halves, cut to their pages, share this share of the height of the smaller one at least. */
export const ASLANT_HALF_MIN_SHARED_HEIGHT = 0.5;
/** The page's words cover at most this share of what a half shows: a card of text laid aslant across a spread is no picture. Measured on two books: a turned map 0.01, cards of rules 0.3 and more. */
export const ASLANT_HALF_MAX_WORD_COVERAGE = 0.15;
/** How near (pt) a half's ink comes to the gutter, and how far from the page's other edge it stays. */
export const ASLANT_HALF_EDGE_TOLERANCE_PT = 6;
/** A right half is cut at the page's text only when this much of it is left (pt). */
export const ASLANT_HALF_MIN_WIDTH_PT = 10;

/** The reason of a unit that is a picture stored as a grid of small tiles (see `GRID_PICTURE_MIN_TILES`). */
export const GRID_PICTURE_REASON = 'Z27-picture-in-grid-tiles';
/** The classifier's reason for a small picture of a page crowded with them (a page laid out as a screen), which may be a strip of a tiled picture. */
export const FORM_PAGE_ELEMENT_REASON = 'Z18-form-page-element';
/** The classifier's reason for a picture too small to be offered, which may be a tile of a grid. */
export const TINY_UNDECIDED_REASON = 'Z16-tiny-undecided';

export function joinTiledRectangles(
  units: ExtractionUnit[],
  leftovers: readonly ClassifiedImage[],
  isTile: (u: ExtractionUnit) => boolean,
  meetSeamlessly: (a: ExtractionUnit, b: ExtractionUnit) => boolean,
): ExtractionUnit[] {
  const abut = (a: Rect, b: Rect): boolean => {
    const run = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);
    const seam = (x: number, y: number): boolean => Math.abs(x - y) <= MOSAIC_MAX_SEAM_PT;
    return ((seam(a.maxX, b.minX) || seam(b.maxX, a.minX)) && run(a.minY, a.maxY, b.minY, b.maxY) > MOSAIC_MAX_SEAM_PT) || ((seam(a.maxY, b.minY) || seam(b.maxY, a.minY)) && run(a.minX, a.maxX, b.minX, b.maxX) > MOSAIC_MAX_SEAM_PT);
  };
  const area = (r: Rect): number => Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
  const inUnits = new Set(units.flatMap((u) => [u.representativeEntry, ...u.memberEntries]));
  const single = leftovers.filter((c) => !inUnits.has(c.entry) && c.entry.occurrences.length === 1);
  // The tiles of a grid (a portrait stored as rows of equal rasters): pieces of one size, many of them on their page.
  const sizeKey = (c: ClassifiedImage): string => {
    const box = c.entry.occurrences[0]!.bbox;
    return `${c.entry.occurrences[0]!.page}:${Math.round(box.maxX - box.minX)}x${Math.round(box.maxY - box.minY)}`;
  };
  const sameSize = new Map<string, number>();
  for (const c of single) sameSize.set(sizeKey(c), (sameSize.get(sizeKey(c)) ?? 0) + 1);
  // A grid's last column or row is often cut narrower: a tile that has the width or the height of a grid's tiles belongs to it too.
  const gridSides = new Set<string>();
  for (const [key, count] of sameSize) {
    if (count < GRID_PICTURE_MIN_TILES) continue;
    const [page, size] = key.split(':') as [string, string];
    const [w, h] = size.split('x');
    gridSides.add(`${page}:w${w}`);
    gridSides.add(`${page}:h${h}`);
  }
  const isGridTile = (c: ClassifiedImage): boolean => {
    if ((sameSize.get(sizeKey(c)) ?? 0) >= GRID_PICTURE_MIN_TILES) return true;
    const box = c.entry.occurrences[0]!.bbox;
    const page = c.entry.occurrences[0]!.page;
    return gridSides.has(`${page}:w${Math.round(box.maxX - box.minX)}`) || gridSides.has(`${page}:h${Math.round(box.maxY - box.minY)}`);
  };
  const gridTiles = new Set<ImageEntry>();
  const strips: ExtractionUnit[] = single
    .filter((c) => {
      const box = c.entry.occurrences[0]!.bbox;
      const w = box.maxX - box.minX;
      const h = box.maxY - box.minY;
      if (isGridTile(c)) gridTiles.add(c.entry);
      return Math.min(w, h) > 0 && (isGridTile(c) || Math.max(w, h) >= TILED_RECTANGLE_MIN_STRIP_ASPECT * Math.min(w, h));
    })
    .map((c) => ({ representativeEntry: c.entry, memberEntries: [c.entry], page: c.entry.occurrences[0]!.page, bbox: c.entry.occurrences[0]!.bbox, clusterMemberCount: 1, classification: c.classification === 'content' ? ('content' as const) : ('undecided' as const), confidence: c.confidence, reason: c.reason }));
  const isStrip = new Set(strips);
  const tiles = [...units.filter(isTile), ...strips.filter(isTile)];
  const parent = new Map<ExtractionUnit, ExtractionUnit>(tiles.map((u) => [u, u]));
  const root = (u: ExtractionUnit): ExtractionUnit => (parent.get(u) === u ? u : root(parent.get(u)!));
  const seamless = new Map<ExtractionUnit, Set<ExtractionUnit>>(tiles.map((u) => [u, new Set<ExtractionUnit>()]));
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]!;
      const b = tiles[j]!;
      // Tiles of a grid set edge to edge are one picture without looking at the seam (a seam can run along the edge of a letter).
      const ofOneGrid = isStrip.has(a) && isStrip.has(b) && gridTiles.has(a.representativeEntry!) && gridTiles.has(b.representativeEntry!);
      if (a.page !== b.page || !abut(a.bbox, b.bbox) || !(ofOneGrid || meetSeamlessly(a, b))) continue;
      parent.set(root(a), root(b));
      seamless.get(a)!.add(b);
      seamless.get(b)!.add(a);
    }
  }
  const groups = new Map<ExtractionUnit, ExtractionUnit[]>();
  for (const u of tiles) groups.set(root(u), [...(groups.get(root(u)) ?? []), u]);
  const fillsRectangle = (pieces: readonly ExtractionUnit[]): boolean => {
    const bbox = pieces.slice(1).reduce((r, u) => unionRect(r, u.bbox), pieces[0]!.bbox);
    const filled = pieces.reduce((sum, u) => sum + area(u.bbox), 0);
    return Math.abs(filled - area(bbox)) <= TILED_RECTANGLE_MAX_FILL_ERROR * area(bbox);
  };
  const connected = (pieces: readonly ExtractionUnit[]): boolean => {
    const reached = new Set<ExtractionUnit>([pieces[0]!]);
    const queue = [pieces[0]!];
    while (queue.length > 0) {
      for (const next of seamless.get(queue.pop()!)!) {
        if (!pieces.includes(next) || reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    return reached.size === pieces.length;
  };
  // A strip of the page's design laid beside the picture (the end of a frame under a box of text) leaves a hole in
  // the rectangle: the strips that keep it whole are taken in, the most of them that do. The units are all kept.
  const pictures: ExtractionUnit[][] = [];
  const grids: ExtractionUnit[][] = [];
  for (const group of groups.values()) {
    const kept = group.filter((u) => !isStrip.has(u));
    const optional = group.filter((u) => isStrip.has(u));
    // A picture stored as a grid of small tiles, none of them offered by itself: the whole grid, when it fills its rectangle.
    if (kept.length === 0 && group.length >= GRID_PICTURE_MIN_TILES && group.every((u) => gridTiles.has(u.representativeEntry!)) && fillsRectangle(group)) {
      grids.push(group);
      continue;
    }
    if (kept.length === 0 || group.length < 2) continue;
    if (fillsRectangle(group)) {
      pictures.push(group);
      continue;
    }
    if (optional.length > TILED_RECTANGLE_MAX_STRIPS) continue;
    let best: ExtractionUnit[] | null = null;
    let bestArea = 0;
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const pieces = [...kept, ...optional.filter((_, i) => (mask >> i) & 1)];
      if (pieces.length < 2) continue;
      const total = pieces.reduce((sum, u) => sum + area(u.bbox), 0);
      if (total > bestArea && fillsRectangle(pieces) && connected(pieces)) {
        best = pieces;
        bestArea = total;
      }
    }
    if (best !== null) pictures.push(best);
  }
  const out = [...units];
  for (const group of pictures) {
    const bbox = group.slice(1).reduce((r, u) => unionRect(r, u.bbox), group[0]!.bbox);
    const larger = group.filter((u) => !isStrip.has(u)).reduce((best, u) => ((u.representativeEntry?.maxRelativeArea ?? 0) > (best.representativeEntry?.maxRelativeArea ?? 0) ? u : best));
    const first = group.find((u) => !isStrip.has(u))!;
    out[out.indexOf(first)] = {
      ...larger,
      memberEntries: group.flatMap((u) => u.memberEntries),
      bbox,
      clusterMemberCount: group.reduce((sum, u) => sum + u.clusterMemberCount, 0),
      classification: group.some((u) => u.classification === 'content') ? 'content' : 'undecided',
    };
    for (const u of group) if (u !== first && !isStrip.has(u)) out.splice(out.indexOf(u), 1);
  }
  for (const group of grids) {
    const bbox = group.slice(1).reduce((r, u) => unionRect(r, u.bbox), group[0]!.bbox);
    out.push({ ...group[0]!, memberEntries: group.flatMap((u) => u.memberEntries), bbox, clusterMemberCount: group.length, classification: 'undecided', confidence: confidenceForReason(GRID_PICTURE_REASON), reason: GRID_PICTURE_REASON });
  }
  return out;
}

/** The reason of a unit that is a line drawing on the pictures of the page, and of a picture's tile it left (see `withLineDrawings`). */
export const LINE_DRAWING_REASON = 'Z23-line-drawing-on-pictures';
export const LINE_DRAWING_REMAINDER_REASON = 'Z23-tile-beside-line-drawing';
/** A member of a unit is part of a line drawing when the drawing covers this share of its box; otherwise it is a picture of its own (or a bare tile). */
export const LINE_DRAWING_MIN_MEMBER_COVER = 0.5;
/** A raster is the ground of a line drawing when the drawing covers this share of its box at least, or this share of the drawing lies on it. */
export const LINE_DRAWING_MIN_GROUND_COVER = 0.25;
export const LINE_DRAWING_MIN_ON_GROUND = 0.5;
/**
 * A cluster of lines that the page's words cover for this share of its box is the rules of a table, not a drawing.
 * Measured on three books: the plans and elevations 0-0.17 (the labels of rooms and streets), a page of tables 0.42.
 */
export const LINE_DRAWING_MAX_WORD_COVERAGE = 0.25;
/** Units at least this share of the page are its background, which a drawing lies on as any other page content does: not looked at. */
export const LINE_DRAWING_MAX_UNIT_PAGE_SHARE = 0.9;

/**
 * A picture the page draws in lines over its rasters (a floor plan, the elevation of a building, drawn over tiles of a
 * dark texture): the rasters are the bare ground, the picture is the lines. The line drawings of the page (see
 * `findLineDrawings`) that lie over units of rasters replace those units, each a unit of its own, its region the
 * drawing's box within the units it lies over, rendered. A drawing over several units is one picture (a plan drawn
 * over two tiles), unless more than one of the units has a drawing of its own among the lines that lie on it (a plan
 * on one tile, a building beside it on the next, their lines touching): then each unit's drawing is a picture. Drawings
 * that lie on the same raster are parts of one picture (the shops of a street plan) and make one unit, its region
 * taking in the rasters they cover for the most part (the ground of the picture, where few lines are drawn). A member
 * of a unit that no drawing covers stays a unit of its own, hidden when it is a bare texture
 * (`LINE_DRAWING_REMAINDER_REASON`).
 */
export function withLineDrawings(units: readonly ExtractionUnit[], lines: readonly VectorShape[], pageBoxByPage: ReadonlyMap<number, Rect>, wordBoxesByPage?: ReadonlyMap<number, readonly Rect[]>): ExtractionUnit[] {
  if (lines.length === 0) return [...units];
  const linesByPage = new Map<number, VectorShape[]>();
  for (const l of lines) linesByPage.set(l.page, [...(linesByPage.get(l.page) ?? []), l]);
  const boxOf = (m: ImageEntry, page: number): Rect | undefined => m.occurrences.find((o) => o.page === page)?.bbox;
  const share = (box: Rect, by: readonly Rect[]): number => {
    const area = rectArea(box);
    return area > 0 ? Math.min(1, by.reduce((sum, d) => sum + rectArea(rectIntersection(box, d) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0) / area) : 0;
  };
  const centreIn = (b: Rect, box: Rect): boolean => {
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return cx >= box.minX && cx <= box.maxX && cy >= box.minY && cy <= box.maxY;
  };
  const replaced = new Set<ExtractionUnit>();
  const drawingUnits: ExtractionUnit[] = [];
  const regionsOf = new Map<ExtractionUnit, Rect[]>();
  const unitsByPage = new Map<number, ExtractionUnit[]>();
  for (const u of units) unitsByPage.set(u.page, [...(unitsByPage.get(u.page) ?? []), u]);
  for (const [page, pageUnits] of unitsByPage) {
    const pageBox = pageBoxByPage.get(page);
    const pageLines = linesByPage.get(page);
    if (pageBox === undefined || pageLines === undefined) continue;
    const eligible = pageUnits.filter((u) => u.representativeEntry !== null && (u.classification === 'content' || u.classification === 'undecided') && rectArea(u.bbox) < LINE_DRAWING_MAX_UNIT_PAGE_SHARE * rectArea(pageBox));
    if (eligible.length === 0) continue;
    const ownDrawings = new Map(eligible.map((u) => [u, findLineDrawings(pageLines.filter((l) => centreIn(l.bbox, u.bbox)), pageBox)] as const));
    const addDrawing = (region: Rect, over: readonly ExtractionUnit[]): void => {
      // A raster the drawing only touches (a sign beside a building) is not its ground.
      const members = [...new Set(over.flatMap((u) => u.memberEntries))].filter((m) => {
        const box = boxOf(m, page);
        return box !== undefined && (share(box, [region]) >= LINE_DRAWING_MIN_GROUND_COVER || share(region, [box]) >= LINE_DRAWING_MIN_ON_GROUND);
      });
      if (members.length === 0) return;
      const overlap = (m: ImageEntry): number => rectArea(rectIntersection(boxOf(m, page)!, region) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 });
      const representative = [...members].sort((a, b) => overlap(b) - overlap(a))[0]!;
      const base = over[0]!;
      drawingUnits.push({ ...base, representativeEntry: representative, memberEntries: members, bbox: region, clusterMemberCount: members.length, classification: 'content', reason: LINE_DRAWING_REASON });
      for (const u of over) {
        replaced.add(u);
        regionsOf.set(u, [...(regionsOf.get(u) ?? []), region]);
      }
    };
    for (const drawing of findLineDrawings(pageLines, pageBox)) {
      // The rules of a table (its cells, full of text) are no drawing.
      if (textCoverage(drawing.bbox, wordBoxesByPage?.get(page)) >= LINE_DRAWING_MAX_WORD_COVERAGE) continue;
      const over = eligible.filter((u) => drawing.lines.some((l) => centreIn(l, u.bbox)));
      const withOwn = over.filter((u) => ownDrawings.get(u)!.some((d) => rectIntersection(d.bbox, drawing.bbox) !== null));
      if (withOwn.length === 0) continue;
      if (withOwn.length === 1) {
        const region = rectIntersection(drawing.bbox, over.map((u) => u.bbox).reduce((acc, b) => unionRect(acc, b)));
        if (region !== null) addDrawing(region, over);
        continue;
      }
      for (const u of withOwn) {
        for (const d of ownDrawings.get(u)!) {
          if (rectIntersection(d.bbox, drawing.bbox) === null) continue;
          const region = rectIntersection(d.bbox, u.bbox);
          if (region !== null) addDrawing(region, [u]);
        }
      }
      for (const u of over) if (!withOwn.includes(u)) replaced.add(u);
    }
  }
  // Drawings on the same raster are parts of one picture (the shops of a street plan, drawn apart): one unit.
  const groups: { unit: ExtractionUnit; parts: Rect[] }[] = [];
  for (const d of drawingUnits) {
    const same = groups.find((g) => g.unit.page === d.page && g.unit.memberEntries.some((e) => d.memberEntries.includes(e)));
    if (same === undefined) {
      groups.push({ unit: d, parts: [d.bbox] });
      continue;
    }
    const members = [...new Set([...same.unit.memberEntries, ...d.memberEntries])];
    same.unit = { ...same.unit, memberEntries: members, bbox: unionRect(same.unit.bbox, d.bbox), clusterMemberCount: members.length };
    same.parts.push(d.bbox);
  }
  // A raster the drawings cover for the most part is the picture's ground, all of it (the streets of a plan, where few lines are drawn).
  const merged = groups.map(({ unit, parts }) => {
    let bbox = unit.bbox;
    for (const m of unit.memberEntries) {
      const box = boxOf(m, unit.page);
      if (box !== undefined && share(box, parts) >= LINE_DRAWING_MIN_MEMBER_COVER) bbox = unionRect(bbox, box);
    }
    return { ...unit, bbox };
  });
  const out: ExtractionUnit[] = [];
  for (const unit of units) {
    if (!replaced.has(unit)) {
      out.push(unit);
      continue;
    }
    const regions = regionsOf.get(unit) ?? [];
    for (const m of unit.memberEntries) {
      const box = boxOf(m, unit.page);
      if (box === undefined || m.objId === null || share(box, regions) >= LINE_DRAWING_MIN_MEMBER_COVER) continue;
      out.push({ ...unit, representativeEntry: m, memberEntries: [m], bbox: box, clusterMemberCount: 1, reason: LINE_DRAWING_REMAINDER_REASON });
    }
  }
  return [...out, ...merged];
}

/**
 * A unit of two pictures that touch along an edge, one of them stored as tiles (a map of rasters set edge to edge) and the other as a few pieces
 * (a drawing of clipped strips below it): no piece is large enough to count as a picture of its own (see `CO_MEMBER_SIGNIFICANT_AREA`), so the
 * two came as one render, with the page's text beside them. The tiles seamed to one another (see `areSeamedTiles`) that reach that share of the
 * page together are one picture; the rasters left over, when they reach it too and their boxes overlap the tiles' box only along an edge (a band
 * no deeper than `EDGE_OVERLAP_MAX_DEPTH_PT`), are the other. `null` when the unit is not two such pictures.
 */
export const EDGE_OVERLAP_MAX_DEPTH_PT = 8;
export const EDGE_OVERLAP_MIN_SIDE_FACTOR = 3;

export function splitMosaicFromRest(unit: ExtractionUnit, classifiedByEntry: ReadonlyMap<ImageEntry, ClassifiedImage>): ExtractionUnit[] | null {
  const boxOf = (m: ImageEntry): Rect | undefined => m.occurrences.find((o) => o.page === unit.page)?.bbox;
  const tiles = unit.memberEntries.filter((m) => m.objId !== null && m.intrinsicWidth !== null && m.intrinsicHeight !== null && boxOf(m) !== undefined && visibleWindow(m, unit.page) === undefined && m.occurrences.find((o) => o.page === unit.page)?.placement?.rotated !== true);
  if (tiles.length < 2) return null;
  const parent = tiles.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const source = (m: ImageEntry): TileSource => ({ box: boxOf(m)!, pixelWidth: m.intrinsicWidth!, pixelHeight: m.intrinsicHeight! });
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) if (areSeamedTiles(source(tiles[i]!), source(tiles[j]!))) parent[find(i)] = find(j);
  const sets = new Map<number, ImageEntry[]>();
  tiles.forEach((m, i) => sets.set(find(i), [...(sets.get(find(i)) ?? []), m]));
  const areaOf = (set: readonly ImageEntry[]): number => set.reduce((sum, m) => sum + m.maxRelativeArea, 0);
  const mosaics = [...sets.values()].filter((set) => set.length >= 2 && areaOf(set) >= CO_MEMBER_SIGNIFICANT_AREA);
  if (mosaics.length !== 1) return null;
  const mosaic = mosaics[0]!;
  const rest = unit.memberEntries.filter((m) => !mosaic.includes(m) && boxOf(m) !== undefined);
  if (rest.length === 0 || areaOf(rest) < CO_MEMBER_SIGNIFICANT_AREA || rest.length + mosaic.length !== unit.memberEntries.length) return null;
  const union = (set: readonly ImageEntry[]): Rect => set.map((m) => boxOf(m)!).reduce((acc, b) => unionRect(acc, b));
  const a = union(mosaic);
  const b = union(rest);
  const shared = rectIntersection(a, b);
  if (shared !== null) {
    const depth = Math.min(shared.maxX - shared.minX, shared.maxY - shared.minY);
    const thinner = Math.min(a.maxX - a.minX, a.maxY - a.minY, b.maxX - b.minX, b.maxY - b.minY);
    if (depth > EDGE_OVERLAP_MAX_DEPTH_PT || thinner < EDGE_OVERLAP_MIN_SIDE_FACTOR * depth) return null;
  }
  return [mosaic, rest].map((set): ExtractionUnit => {
    const representative = set.reduce((best, m) => (m.maxRelativeArea > best.maxRelativeArea ? m : best));
    const c = classifiedByEntry.get(representative);
    // The pieces left over, each shown in a clip of its own (a drawing in a torn frame painted as strips), are one picture: taken whole from what
    // they show (see `SLICED_PICTURE_REASON`), not split again by their pixels.
    const sliced = set === rest && set.length >= 2 && set.every((m) => visibleWindow(m, unit.page) !== undefined);
    return { ...unit, representativeEntry: representative, memberEntries: set, bbox: union(set), clusterMemberCount: set.length, classification: c?.classification ?? unit.classification, confidence: c?.confidence ?? unit.confidence, reason: sliced ? CLIPPED_PIECES_REASON : (c?.reason ?? unit.reason) };
  });
}

export function splitUnitsOfDistinctPictures(
  units: readonly ExtractionUnit[],
  classifiedByEntry: ReadonlyMap<ImageEntry, ClassifiedImage>,
  maskedObjIds: ReadonlySet<string>,
  textBoxesByPage?: ReadonlyMap<number, readonly Rect[]>,
): ExtractionUnit[] {
  const isSolid = (m: ImageEntry): boolean => !isBackdropShape(m);
  return units.flatMap((planned) => {
    // A raster painted a second time over the same box (the same picture, painted again to blend it or to cover its edge) is not another picture of the unit.
    const unit = withoutRepaints(planned);
    // A panel of text laid over pictures (a masked panel painted at 90%, with the page's text on it) is not part of them: a render of the unit would carry its text.
    // Each picture of the unit is a picture of its own, taken from its own pixels.
    const isTextPanelOverPictures = (m: ImageEntry): boolean => m.maxOpacity !== undefined && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && classifiedByEntry.get(m)?.reason === HIGH_TEXT_COVERAGE_REASON;
    if (unit.memberEntries.length >= 2 && unit.memberEntries.some(isTextPanelOverPictures) && unit.memberEntries.some((m) => !isTextPanelOverPictures(m) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA)) {
      return unit.memberEntries.flatMap((m): ExtractionUnit[] => {
        const c = classifiedByEntry.get(m);
        const boxes = m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox);
        if (!c || boxes.length === 0 || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA) return [];
        return [{ representativeEntry: m, memberEntries: [m], page: unit.page, bbox: boxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: 1, classification: c.classification, confidence: c.confidence, reason: c.reason }];
      });
    }
    const significant = unit.memberEntries.filter((m) => isSolid(m) && !isPanelBehindFigure(m, unit) && m.objId !== null && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
    const underFullPageIllustration = unit.representativeEntry !== null && unit.representativeEntry.maxRelativeArea >= SPLIT_BANNER_REPRESENTATIVE_MIN_AREA;
    const significantMasked = unit.memberEntries.filter((m) => isSolid(m) && m.objId !== null && m.maxRelativeArea >= (underFullPageIllustration ? SPLIT_BANNER_MASKED_MIN_AREA : CO_MEMBER_SIGNIFICANT_AREA) && maskedObjIds.has(m.objId));
    const standOnBackdrops = unit.memberEntries.some((m) => isBackdropShape(m));
    // A big card of the layout (a panel with a stat block, painted at 90%: not a faint overlay, not fully opaque) with figures standing on it: the figures are pictures of their own.
    const standOnCard = unit.memberEntries.some((m) => m.maxOpacity !== undefined && m.maxOpacity < 1 && !isTranslucentEverywhere(m) && m.maxRelativeArea >= LAYOUT_CARD_MIN_AREA);
    // A card of text (a parchment with a stat block) laid over a picture: the two are told apart, the picture is not part of the card.
    const classifierFoundCard = unit.memberEntries.some((m) => m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && classifiedByEntry.get(m)?.reason === HIGH_TEXT_COVERAGE_REASON);
    const isTextCard = (m: ImageEntry): boolean => {
      const own = m.occurrences.find((o) => o.page === unit.page)?.bbox;
      const reason = classifiedByEntry.get(m)?.reason;
      if (own === undefined || m.maxOpacity !== undefined) return false;
      if (reason === HIGH_TEXT_COVERAGE_REASON) return true;
      // When the classifier found a card of text among the members, the others are the pictures the card lies on, however much of their box the page's text blocks cover.
      if (classifierFoundCard) return false;
      return textCoverage(own, textBoxesByPage?.get(unit.page)) >= SPLIT_TEXT_CARD_MIN_COVERAGE;
    };
    const boxOnPage = (m: ImageEntry): Rect | undefined => m.occurrences.find((o) => o.page === unit.page)?.bbox;
    const standOnTextCard =
      textBoxesByPage !== undefined &&
      significant.some(
        (card) =>
          isTextCard(card) &&
          significant.some((picture) => {
            const cardBox = boxOnPage(card);
            const pictureBox = boxOnPage(picture);
            if (picture === card || isTextCard(picture) || cardBox === undefined || pictureBox === undefined || picture.maxRelativeArea < SPLIT_TEXT_CARD_PICTURE_MIN_AREA) return false;
            const shared = rectIntersection(cardBox, pictureBox);
            return shared === null || rectArea(shared) < SPLIT_TEXT_CARD_MAX_PICTURE_ON_CARD * rectArea(pictureBox);
          }),
      );
    // Pictures of which some are shown in frames of their own (a clip) and whose frames do not overlap the others (three floor plans stacked on a page,
    // a creature beside swirls of wind): the boxes of their rasters overlap where the frames do not, which is no reason to join them. The pictures whose
    // outlines overlap stay together; the groups that remain are separate pictures.
    // Slices of one picture, each cut out by a shaped clip of its own (a weapon painted as the pieces of its blade, its hilt and its tip): that
    // picture, whole. Its box is found on the page from what the slices show (see `SLICED_PICTURE_REASON`).
    if (significant.length >= 2 && areSlicesOfOnePicture(unit.memberEntries, significant, unit.page)) return [{ ...unit, reason: SLICED_PICTURE_REASON }];
    // A small picture painted in pieces (a blade laid aslant as strips): none of them large, all of them pieces.
    if (significant.length === 0 && unit.memberEntries.length >= SMALL_SLICED_PICTURE_MIN_PIECES && unit.memberEntries.every((m) => isPieceOf(m, unit.page))) {
      return [{ ...unit, reason: SLICED_PICTURE_REASON }];
    }
    if (significantMasked.length < 2 && !(standOnBackdrops || standOnCard || standOnTextCard) && significant.length >= 2) {
      const outlines = significant.map((m) => {
        const box = boxOnPage(m);
        return visibleWindow(m, unit.page) ?? (box === undefined ? undefined : [box.minX, box.minY, box.maxX, box.minY, box.maxX, box.maxY, box.minX, box.maxY]);
      });
      if (outlines.every((o): o is readonly number[] => o !== undefined)) {
        const parent = significant.map((_, i) => i);
        const find = (i: number): number => {
          while (parent[i] !== i) i = parent[i]!;
          return i;
        };
        const tileOf = (m: ImageEntry): TileSource | undefined => {
          const box = boxOnPage(m);
          return box === undefined || m.intrinsicWidth === null || m.intrinsicHeight === null || visibleWindow(m, unit.page) !== undefined || m.occurrences.find((o) => o.page === unit.page)?.placement?.rotated === true ? undefined : { box, pixelWidth: m.intrinsicWidth, pixelHeight: m.intrinsicHeight };
        };
        const seamed = (i: number, j: number): boolean => {
          const a = tileOf(significant[i]!);
          const b = tileOf(significant[j]!);
          return a !== undefined && b !== undefined && areSeamedTiles(a, b);
        };
        for (let i = 0; i < outlines.length; i++) for (let j = i + 1; j < outlines.length; j++) if (seamed(i, j) || !windowsAreApart(outlines[i] as readonly number[], outlines[j] as readonly number[], visibleWindow(significant[i]!, unit.page) === undefined && visibleWindow(significant[j]!, unit.page) === undefined ? BOXES_MAX_OVERLAP_SHARE : FRAMES_MAX_OVERLAP_SHARE)) parent[find(i)] = find(j);
        const components = new Map<number, ImageEntry[]>();
        significant.forEach((m, i) => components.set(find(i), [...(components.get(find(i)) ?? []), m]));
        if (components.size >= 2) {
          return [...components.values()].flatMap((members): ExtractionUnit[] => {
            const representative = members.reduce((best, m) => (m.maxRelativeArea > best.maxRelativeArea ? m : best));
            const c = classifiedByEntry.get(representative);
            const boxes = members.flatMap((m) => m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox));
            if (!c || boxes.length === 0) return [];
            return [{ representativeEntry: representative, memberEntries: members, page: unit.page, bbox: boxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: members.length, classification: c.classification, confidence: c.confidence, reason: c.reason }];
          });
        }
      }
    }
    if (significant.length < 2 && significantMasked.length < 2 && !(standOnBackdrops || standOnCard || standOnTextCard)) {
      const apart = splitMosaicFromRest(unit, classifiedByEntry);
      if (apart !== null) return apart;
    }
    if (unit.memberEntries.length < 2 || (significantMasked.length < 2 && !((standOnBackdrops || standOnCard || standOnTextCard) && significant.length >= 2))) return [unit];
    const isSplitOff = (m: ImageEntry): boolean => {
      if (!isSolid(m)) return false;
      if (m === unit.representativeEntry) return true;
      const c = classifiedByEntry.get(m);
      return c !== undefined && (m.maxRelativeArea >= SPLIT_OFF_MIN_AREA || (c.classification === 'content' && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA));
    };
    // A picture of consequence that lies clear of the pictures split off (at most `FRAMES_MAX_OVERLAP_SHARE` of its box on any of them: the second figure of a pair, an
    // armor beside the others) is a picture of its own, not a leftover of the stack: only the pieces that sit on the pictures are.
    // The flush washes of the layout that are split off with them are not pictures to keep clear of.
    const splitOff = unit.memberEntries.filter((m) => isSplitOff(m) && classifiedByEntry.get(m)?.reason !== FLUSH_UNDECIDED_REASON);
    const clearOfSplitOff = (m: ImageEntry): boolean => {
      const box = boxOnPage(m);
      if (box === undefined || rectArea(box) <= 0 || !isSolid(m) || isTextCard(m) || isPanelBehindFigure(m, unit) || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA || classifiedByEntry.get(m) === undefined) return false;
      return splitOff.every((o) => {
        const shared = boxOnPage(o) === undefined ? null : rectIntersection(box, boxOnPage(o)!);
        return shared === null || rectArea(shared) <= FRAMES_MAX_OVERLAP_SHARE * rectArea(box);
      });
    };
    // A picture nearly as large as the largest one split off (the third snapshot of a stack, pinned slightly over the others) is its peer as well.
    const largestSplitOff = splitOff.reduce((largest, m) => Math.max(largest, m.maxRelativeArea), 0);
    const isPeerOfSplitOff = (m: ImageEntry): boolean =>
      isSolid(m) && !isTextCard(m) && !isPanelBehindFigure(m, unit) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && m.maxRelativeArea >= SPLIT_PEER_MIN_SHARE * largestSplitOff && classifiedByEntry.get(m) !== undefined;
    const separate = unit.memberEntries.filter((m) => isSplitOff(m) || clearOfSplitOff(m) || isPeerOfSplitOff(m));
    const isRepaintOfEarlier = (m: ImageEntry, at: number): boolean => {
      const box = boxOnPage(m);
      return box !== undefined && separate.slice(0, at).some((k) => {
        const earlier = boxOnPage(k);
        return earlier !== undefined && isRepaintOf({ entry: k, box: earlier }, { entry: m, box });
      });
    };
    return separate.filter((m, at) => !isRepaintOfEarlier(m, at)).flatMap((m): ExtractionUnit[] => {
      const c = classifiedByEntry.get(m);
      const boxes = m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox);
      if (!c || boxes.length === 0) return [];
      return [
        {
          representativeEntry: m,
          memberEntries: [m],
          page: unit.page,
          bbox: boxes.reduce((acc, b) => unionRect(acc, b)),
          clusterMemberCount: 1,
          classification: c.classification,
          confidence: c.confidence,
          reason: c.reason,
        },
      ];
    });
  });
}
