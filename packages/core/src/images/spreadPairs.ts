import type { Rect } from '../geometry.js';

/** How far (pt) from the page edge a picture may stop and still count as running to it. */
const EDGE_TOLERANCE_PT = 4;
/** How far (pt) the top and bottom of the two halves of a picture may differ. */
const ALIGNMENT_TOLERANCE_PT = 4;
/** How far (pt) the right edge of one piece may lie short of the left edge of the next one on the same page (they touch), and how far they may overlap (a picture cut in two is often cut with a margin: the two rasters overlap by some points, and the right one shows again what the left one ends with). A gap between two pictures means two pictures (a row of portraits). */
const SEAM_MAX_GAP_PT = 1.5;
const SEAM_MAX_OVERLAP_PT = 6;
/** Two rasters that overlap more than that at the seam are the halves of one picture only when they were cut from one raster: the same height in pixels and the same density, up to this overlap. */
const CUT_WITH_MARGIN_MAX_OVERLAP_PT = 15;
const CUT_MIN_PIXELS = 100;
const CUT_MAX_DENSITY_DIFFERENCE = 0.03;

export interface SpreadCandidate {
  page: number;
  bbox: Rect;
}

/** The size in pixels of the raster that a candidate is, when it is one. */
export type PixelSizeOf<T> = (candidate: T) => { width: number; height: number } | undefined;

/** Whether two rasters that overlap at their seam by more than a few points were cut from one raster: real pictures of the same height in pixels and of the same density. */
function cutFromOneRaster(left: SpreadCandidate, leftPixels: { width: number; height: number } | undefined, right: SpreadCandidate, rightPixels: { width: number; height: number } | undefined): boolean {
  if (leftPixels === undefined || rightPixels === undefined) return false;
  if (Math.min(leftPixels.width, leftPixels.height, rightPixels.width, rightPixels.height) < CUT_MIN_PIXELS) return false;
  const densityLeft = leftPixels.height / (left.bbox.maxY - left.bbox.minY);
  const densityRight = rightPixels.height / (right.bbox.maxY - right.bbox.minY);
  return Math.abs(leftPixels.height - rightPixels.height) <= 1 && Math.abs(densityLeft - densityRight) <= CUT_MAX_DENSITY_DIFFERENCE * Math.max(densityLeft, densityRight);
}

/**
 * The pictures that run across a spread: a picture that reaches the right edge of its page and one on the next page that starts at the
 * left edge, with the same top and bottom — the two halves of one map; and two pictures on one page that meet side by side with the same top and bottom. Maps each left half to its right half (a candidate takes part in one pair at most).
 */
export function findSpreadPairs<T extends SpreadCandidate>(candidates: readonly T[], pageBoxByPage: ReadonlyMap<number, Rect>, pixelSizeOf: PixelSizeOf<T> = () => undefined): Map<T, T> {
  const pairs = new Map<T, T>();
  const taken = new Set<T>();
  // One picture stored in two pieces that meet side by side on a page: the right edge of the left one is the left edge of the right one.
  for (const left of candidates) {
    if (taken.has(left)) continue;
    const right = candidates.find(
      (c) =>
        c !== left &&
        !taken.has(c) &&
        c.page === left.page &&
        c.bbox.minX > left.bbox.minX &&
        c.bbox.minX - left.bbox.maxX <= SEAM_MAX_GAP_PT &&
        (left.bbox.maxX - c.bbox.minX <= SEAM_MAX_OVERLAP_PT || (left.bbox.maxX - c.bbox.minX <= CUT_WITH_MARGIN_MAX_OVERLAP_PT && cutFromOneRaster(left, pixelSizeOf(left), c, pixelSizeOf(c)))) &&
        Math.abs(c.bbox.minY - left.bbox.minY) <= ALIGNMENT_TOLERANCE_PT &&
        Math.abs(c.bbox.maxY - left.bbox.maxY) <= ALIGNMENT_TOLERANCE_PT,
    );
    if (right === undefined) continue;
    pairs.set(left, right);
    taken.add(left);
    taken.add(right);
  }
  for (const left of candidates) {
    const leftBox = pageBoxByPage.get(left.page);
    if (leftBox === undefined || left.bbox.maxX < leftBox.maxX - EDGE_TOLERANCE_PT || taken.has(left)) continue;
    const right = candidates.find((c) => {
      if (c === left || taken.has(c) || c.page !== left.page + 1) return false;
      const rightBox = pageBoxByPage.get(c.page);
      return (
        rightBox !== undefined &&
        c.bbox.minX <= rightBox.minX + EDGE_TOLERANCE_PT &&
        Math.abs(c.bbox.minY - left.bbox.minY) <= ALIGNMENT_TOLERANCE_PT &&
        Math.abs(c.bbox.maxY - left.bbox.maxY) <= ALIGNMENT_TOLERANCE_PT
      );
    });
    if (right === undefined) continue;
    pairs.set(left, right);
    taken.add(left);
    taken.add(right);
  }
  return pairs;
}
