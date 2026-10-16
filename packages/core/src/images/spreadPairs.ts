import type { Rect } from '../geometry.js';

/** How far (pt) from the page edge a picture may stop and still count as running to it. */
const EDGE_TOLERANCE_PT = 4;
/** How far (pt) the top and bottom of the two halves of a picture may differ. */
const ALIGNMENT_TOLERANCE_PT = 4;

export interface SpreadCandidate {
  page: number;
  bbox: Rect;
}

/**
 * The pictures that run across a spread: a picture that reaches the right edge of its page and one on the next page that starts at the
 * left edge, with the same top and bottom — the two halves of one map. Maps each left half to its right half (a candidate takes part in one pair at most).
 */
export function findSpreadPairs<T extends SpreadCandidate>(candidates: readonly T[], pageBoxByPage: ReadonlyMap<number, Rect>): Map<T, T> {
  const pairs = new Map<T, T>();
  const taken = new Set<T>();
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
