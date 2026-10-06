import { reconstructLines } from '../extract/reconstructLines.js';
import { elementCenter, type PageTextElement, type ReconstructedLine } from '../extract/types.js';
import type { PageForDetection } from './types.js';

/** One reconstructed line, tagged with WHERE it sits in the whole document's reading order — the backbone `detectStatblocks.ts` walks. */
export interface ReadingOrderEntry {
  pageNumber: number;
  columnIndex: number;
  line: ReconstructedLine;
}

/**
 * Buckets a page's elements into its declared columns by nearest-column
 * assignment (by X: inside a column's X-range wins outright; otherwise the
 * column whose range is horizontally closest) — simple and robust to an
 * element sitting slightly outside its column's nominal box (a common
 * real-world imprecision), without needing to reject anything as
 * "unassignable".
 */
function assignElementsToColumns(page: PageForDetection): PageTextElement[][] {
  const columns = page.columns && page.columns.length > 0 ? page.columns : [page.pageBox];
  const buckets: PageTextElement[][] = columns.map(() => []);
  for (const el of page.elements) {
    const center = elementCenter(el);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    columns.forEach((col, index) => {
      const distance = center.x < col.minX ? col.minX - center.x : center.x > col.maxX ? center.x - col.maxX : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    buckets[bestIndex]!.push(el);
  }
  return buckets;
}

/**
 * The whole document, flattened into ONE continuous reading-order
 * stream: pages in `pageNumber` order, columns left-to-right within a
 * page, lines top-to-bottom within a column (`reconstructLines`, reused rather than reimplemented). This single stream is
 * what lets `detectStatblocks.ts` treat "the next thing after this line"
 * uniformly whether or not it happens to cross a column or page boundary
 * — exactly what's needed for a statblock to legitimately span one.
 */
export function buildStatblockReadingOrder(pages: readonly PageForDetection[]): ReadingOrderEntry[] {
  const result: ReadingOrderEntry[] = [];
  const sortedPages = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of sortedPages) {
    const columnBuckets = assignElementsToColumns(page);
    columnBuckets.forEach((bucket, columnIndex) => {
      for (const line of reconstructLines(bucket)) result.push({ pageNumber: page.pageNumber, columnIndex, line });
    });
  }
  return result;
}

/** A minimal (page, column) locator — accepted instead of a full `ReadingOrderEntry` so callers building up a region incrementally (no `.line` yet) can compare against it too. */
export interface ColumnLocator {
  pageNumber: number;
  columnIndex: number;
}

/** Two entries are "the same column" when they share both page and column index — crossing this boundary is a NO-OP for most boundary rules (never itself a stop signal), but IS the stop signal for `endOfColumnOrPage`. */
export function isSameColumn(a: ColumnLocator, b: ColumnLocator): boolean {
  return a.pageNumber === b.pageNumber && a.columnIndex === b.columnIndex;
}
