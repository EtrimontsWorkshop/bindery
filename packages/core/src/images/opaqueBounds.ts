import type { Rect } from '../geometry.js';
import type { Placement } from '../inventory/imageRegistry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Where a raster that has transparent margins actually shows something. A paper note or a torn scrap is placed in
 * a box that also holds its transparent edge (a shadow, a splatter, an empty margin): rendering the box copies
 * whatever page text lies in that margin. The visible part is the box of the pixels that are opaque enough, taken
 * over rows and columns that hold a real share of them, so that a few stray specks do not stretch it.
 */

/** A pixel with alpha above this counts as visible. */
const VISIBLE_ALPHA = 128;
/** A row (column) counts when at least this share of its pixels is visible. */
const MIN_LINE_SHARE = 0.01;
/** ...and at least this share of the visible share of the most visible line. Measured on a real rulebook: the body of a parchment note shows 73% in every column, the blood streak along its edge 32%. */
const BODY_SHARE = 0.5;
/** The visible box must be smaller than the raster by this much in area for it to be worth using. */
const MIN_SHRINK = 0.05;
/** At most this many samples per axis are looked at — enough to find an edge to a fraction of a percent. */
const MAX_SAMPLES_PER_AXIS = 700;

export interface FractionalBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The bounds (0-1, in image fractions) of the visible part of the image, or `null` when nothing is visible. */
export function opaqueBounds(image: DecodedImage): FractionalBounds | null {
  const { width, height, rgba } = image;
  if (width <= 0 || height <= 0) return null;
  const sx = Math.max(1, Math.ceil(width / MAX_SAMPLES_PER_AXIS));
  const sy = Math.max(1, Math.ceil(height / MAX_SAMPLES_PER_AXIS));
  const cols = Math.ceil(width / sx);
  const rows = Math.ceil(height / sy);
  const colCount = new Uint32Array(cols);
  const rowCount = new Uint32Array(rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rgba[((r * sy) * width + c * sx) * 4 + 3]! > VISIBLE_ALPHA) {
        colCount[c]!++;
        rowCount[r]!++;
      }
    }
  }
  // A row (column) belongs to the body of the picture when it is visible over at least `MIN_LINE_SHARE` of its length
  // and over at least `BODY_SHARE` of what the most visible row (column) shows: a blood streak or a drip that runs
  // along the edge of a note is visible over a smaller share of the lines than the note itself.
  const bodyLines = (counts: Uint32Array, lineLength: number): { first: number; last: number } => {
    const peak = Math.max(...counts) / lineLength;
    const limit = Math.max(MIN_LINE_SHARE, BODY_SHARE * peak);
    const first = counts.findIndex((n) => n / lineLength >= limit);
    let last = -1;
    for (let i = counts.length - 1; i >= 0; i--) {
      if (counts[i]! / lineLength >= limit) {
        last = i;
        break;
      }
    }
    return { first, last };
  };
  const { first: c0, last: c1 } = bodyLines(colCount, rows);
  const { first: r0, last: r1 } = bodyLines(rowCount, cols);
  if (c0 < 0 || r0 < 0 || c1 < c0 || r1 < r0) return null;
  return { x0: c0 / cols, y0: r0 / rows, x1: (c1 + 1) / cols, y1: (r1 + 1) / rows };
}

/**
 * The part of the placement box (`placed`, where the whole raster is painted) that the visible part of the raster
 * covers; `null` when it is not smaller than the box by `MIN_SHRINK`, or when the raster is turned (its box is then
 * not where its pixels are). The y axis of the page runs up and the rows of the image run down, hence the flip; a
 * raster that is mirrored on the page is mirrored back first.
 */
export function tightenToVisible(placed: Rect, bounds: FractionalBounds, placement?: Placement): Rect | null {
  if (placement?.rotated) return null;
  const w = placed.maxX - placed.minX;
  const h = placed.maxY - placed.minY;
  if (w <= 0 || h <= 0) return null;
  const share = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0);
  if (share > 1 - MIN_SHRINK) return null;
  const [x0, x1] = placement?.flipX ? [1 - bounds.x1, 1 - bounds.x0] : [bounds.x0, bounds.x1];
  const [y0, y1] = placement?.flipY ? [1 - bounds.y1, 1 - bounds.y0] : [bounds.y0, bounds.y1];
  return {
    minX: placed.minX + x0 * w,
    maxX: placed.minX + x1 * w,
    minY: placed.minY + (1 - y1) * h,
    maxY: placed.minY + (1 - y0) * h,
  };
}
