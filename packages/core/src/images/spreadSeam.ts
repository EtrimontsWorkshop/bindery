import type { DecodedImage } from './normalizeDecodedImage.js';
import { scaleToHeight } from './stitchHorizontally.js';

/** Share of the seam's rows that must carry some drawing on at least one side: a seam of plain paper joins nothing. */
const SEAM_MIN_INK_ROW_SHARE = 0.02;
/** Of the rows with a drawing, the share in which both sides have one: a figure that runs across the gutter is drawn on both pages. */
const SEAM_MIN_BOTH_INK_SHARE = 0.6;
/**
 * How much the two sides of the seam may differ (mean over the three channels, 0-255, in the rows where both have a drawing), as a multiple of how
 * much neighboring columns differ inside each picture next to the seam, plus a small absolute allowance. One drawing that goes on across the
 * gutter changes across the seam as it does anywhere else; two pictures that only meet there (two portraits, a board and a sheet of paper) jump.
 */
const SEAM_MAX_JUMP_FACTOR = 2;
const SEAM_JUMP_ALLOWANCE = 6;
/** A pixel is drawing when it is visible and not close to white. */
const INK_MIN_ALPHA = 32;
const INK_MAX_BRIGHTNESS = 225;

interface SeamPixel {
  r: number;
  g: number;
  b: number;
  ink: boolean;
}

function seamPixel(image: DecodedImage, row: number, firstColumn: number, columns: number): SeamPixel {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let c = 0; c < columns; c++) {
    const i = (row * image.width + firstColumn + c) * 4;
    r += image.rgba[i]!;
    g += image.rgba[i + 1]!;
    b += image.rgba[i + 2]!;
    a += image.rgba[i + 3]!;
  }
  r /= columns;
  g /= columns;
  b /= columns;
  a /= columns;
  return { r, g, b, ink: a >= INK_MIN_ALPHA && Math.min(r, g, b) < INK_MAX_BRIGHTNESS };
}

/**
 * Whether the right edge of `left` and the left edge of `right` look like one picture cut in two by the gutter: something is drawn on the
 * seam, on both sides in the same rows, in colors that go on across it. Two unrelated pictures that merely meet at the edges of facing pages
 * (a column of figures, a pair of portraits) do not pass.
 */
export function halvesContinueAcrossSeam(left: DecodedImage, right: DecodedImage): boolean {
  if (left.height <= 0 || right.height <= 0 || left.width <= 0 || right.width <= 0) return false;
  const second = scaleToHeight(right, left.height);
  const columns = Math.max(1, Math.round(left.height / 500));
  const leftColumns = Math.min(columns, left.width);
  const rightColumns = Math.min(columns, second.width);
  const hasInnerColumns = left.width >= 2 * leftColumns && second.width >= 2 * rightColumns;
  const distance = (a: SeamPixel, b: SeamPixel): number => (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
  let inkRows = 0;
  let bothRows = 0;
  let jump = 0;
  let inner = 0;
  for (let y = 0; y < left.height; y++) {
    const l = seamPixel(left, y, left.width - leftColumns, leftColumns);
    const r = seamPixel(second, y, 0, rightColumns);
    if (!l.ink && !r.ink) continue;
    inkRows++;
    if (l.ink && r.ink) {
      bothRows++;
      jump += distance(l, r);
      if (hasInnerColumns) {
        const l2 = seamPixel(left, y, left.width - 2 * leftColumns, leftColumns);
        const r2 = seamPixel(second, y, rightColumns, rightColumns);
        inner += (distance(l, l2) + distance(r, r2)) / 2;
      }
    }
  }
  if (inkRows < SEAM_MIN_INK_ROW_SHARE * left.height || bothRows < SEAM_MIN_BOTH_INK_SHARE * inkRows) return false;
  return jump / bothRows <= SEAM_MAX_JUMP_FACTOR * (inner / bothRows) + SEAM_JUMP_ALLOWANCE;
}
