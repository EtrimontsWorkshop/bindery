import { unionRect, type Rect } from '../geometry.js';
import type { Diagnostic } from '../text/types.js';
import type { TextLine } from './lineCluster.js';

/**
 * Column detection (Step 6 Z3) — density histogram on the X axis, ONLY the 0°
 * stream, ONLY COLUMNAR lines (Z2 must run first — otherwise a spanning
 * header destroys the gutter valley). Projects LINE bboxes, not item bboxes
 * (U1: items are fragmentary, lines are not).
 *
 * No clear valleys -> a single column, with confidence=1. That is the CORRECT
 * answer (per the brief), not a detection failure.
 */

export interface ColumnRegion {
  /** Reading order (0-based), left->right for the 0° stream. */
  index: number;
  bbox: Rect;
}

export interface ColumnDetectionResult {
  columns: ColumnRegion[];
  /** 0-1, for the WHOLE result (not per column) — quality of the weakest confirmed gutter; 1 when there are no gutters (single column). */
  confidence: number;
  diagnostics: Diagnostic[];
}

const HISTOGRAM_BIN_WIDTH_PT = 2;
/** A gutter must be at least this many points wide to count as a candidate (calibrated on samples/, see RAPORT-KROK-6.md). */
const MIN_VALLEY_WIDTH_PT = 10;
/** Density in a valley below this fraction of the histogram maximum counts as "empty". */
const MAX_VALLEY_DENSITY_RATIO = 0.05;
/**
 * Vertical validation (per the brief): a true gutter is empty across MOST of the
 * height of the text block. A valley visible only in the top quarter of the page
 * (a short paragraph ending early) is a geometric coincidence, not a true column gutter.
 */
const MIN_VERTICAL_EMPTY_RATIO = 0.7;
/**
 * [Step 6, discovery] A gutter can be real (empty across most of the height) and
 * still NOT separate two true reading columns — a sidebar (a vector frame with
 * short text next to a column) creates exactly this situation: the narrow
 * "column" on its side of the gutter exists only over a small SLICE of the
 * block height (empirically: fixture layout-2col-sidebar, the sidebar covers
 * ~33% of the block height). Per the brief (DoD): a sidebar should be its own
 * BLOCK (Z6, vector-region signal), NOT a third column. A column candidate whose
 * OWN content covers less than this fraction of the block height gets merged
 * with its neighbor instead of counted as a separate reading column.
 */
const MIN_COLUMN_VERTICAL_SPAN_RATIO = 0.5;

function computeTextBlockBBox(lines: readonly TextLine[]): Rect | null {
  return lines.reduce<Rect | null>((acc, line) => (acc ? unionRect(acc, line.bbox) : line.bbox), null);
}

interface BinRun {
  startBin: number;
  endBin: number;
}

function findLowDensityRuns(histogram: readonly number[], threshold: number): BinRun[] {
  const runs: BinRun[] = [];
  let runStart: number | null = null;
  for (let b = 0; b < histogram.length; b++) {
    const isLow = histogram[b]! <= threshold;
    if (isLow && runStart === null) runStart = b;
    if (!isLow && runStart !== null) {
      runs.push({ startBin: runStart, endBin: b - 1 });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ startBin: runStart, endBin: histogram.length - 1 });
  return runs;
}

function singleColumn(textBlock: Rect): ColumnDetectionResult {
  return { columns: [{ index: 0, bbox: textBlock }], confidence: 1, diagnostics: [] };
}

/**
 * Detects columns on ONE page from already-separated columnar lines (Z2).
 * `pageNumber` is used solely for `Diagnostic.pageNumber`.
 */
export function detectColumns(columnarLines: readonly TextLine[], pageNumber: number): ColumnDetectionResult {
  if (columnarLines.length === 0) {
    return { columns: [], confidence: 0, diagnostics: [] };
  }

  const textBlock = computeTextBlockBBox(columnarLines)!;
  const width = textBlock.maxX - textBlock.minX;
  if (width <= 0) return singleColumn(textBlock);

  const binCount = Math.max(1, Math.ceil(width / HISTOGRAM_BIN_WIDTH_PT));
  const histogram = new Array<number>(binCount).fill(0);
  for (const line of columnarLines) {
    const startBin = Math.floor((line.bbox.minX - textBlock.minX) / HISTOGRAM_BIN_WIDTH_PT);
    const endBin = Math.floor((line.bbox.maxX - textBlock.minX) / HISTOGRAM_BIN_WIDTH_PT);
    for (let b = Math.max(0, startBin); b <= Math.min(binCount - 1, endBin); b++) histogram[b]!++;
  }

  const maxDensity = Math.max(...histogram);
  if (maxDensity === 0) return singleColumn(textBlock);

  const valleyThreshold = maxDensity * MAX_VALLEY_DENSITY_RATIO;
  const minValleyBins = Math.ceil(MIN_VALLEY_WIDTH_PT / HISTOGRAM_BIN_WIDTH_PT);
  // Gutters right at the edges (before the first/after the last column) are page margin, not an inter-column gutter.
  const candidates = findLowDensityRuns(histogram, valleyThreshold).filter(
    (run) => run.startBin > 0 && run.endBin < binCount - 1 && run.endBin - run.startBin + 1 >= minValleyBins,
  );

  const verticalHeight = textBlock.maxY - textBlock.minY;
  const confirmed: { run: BinRun; emptyRatio: number }[] = [];
  for (const run of candidates) {
    const gutterMinX = textBlock.minX + run.startBin * HISTOGRAM_BIN_WIDTH_PT;
    const gutterMaxX = textBlock.minX + (run.endBin + 1) * HISTOGRAM_BIN_WIDTH_PT;
    let coveredHeight = 0;
    for (const line of columnarLines) {
      if (line.bbox.minX < gutterMaxX && gutterMinX < line.bbox.maxX) {
        coveredHeight += line.bbox.maxY - line.bbox.minY;
      }
    }
    const emptyRatio = verticalHeight > 0 ? 1 - Math.min(1, coveredHeight / verticalHeight) : 1;
    if (emptyRatio >= MIN_VERTICAL_EMPTY_RATIO) confirmed.push({ run, emptyRatio });
  }

  if (confirmed.length === 0) {
    const diagnostics: Diagnostic[] = [];
    if (candidates.length > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'COLUMN_VALLEY_REJECTED_VERTICAL',
        params: { count: candidates.length, minPercent: MIN_VERTICAL_EMPTY_RATIO * 100 },
        pageNumber,
      });
    }
    return { ...singleColumn(textBlock), diagnostics };
  }

  let columns: ColumnRegion[] = [];
  let cursor = textBlock.minX;
  for (const { run } of confirmed) {
    const gutterMinX = textBlock.minX + run.startBin * HISTOGRAM_BIN_WIDTH_PT;
    const gutterMaxX = textBlock.minX + (run.endBin + 1) * HISTOGRAM_BIN_WIDTH_PT;
    columns.push({ index: columns.length, bbox: { minX: cursor, minY: textBlock.minY, maxX: gutterMinX, maxY: textBlock.maxY } });
    cursor = gutterMaxX;
  }
  columns.push({ index: columns.length, bbox: { minX: cursor, minY: textBlock.minY, maxX: textBlock.maxX, maxY: textBlock.maxY } });

  const mergeDiagnostics: Diagnostic[] = [];
  columns = mergeSparseColumns(columns, columnarLines, verticalHeight, pageNumber, mergeDiagnostics);

  const confidence = Math.min(...confirmed.map((c) => c.emptyRatio));
  return { columns, confidence, diagnostics: mergeDiagnostics };
}

/** Lines from `lines` assigned to the column with the LARGEST X overlap (like `assignColumnIndex` in readingOrder.ts). */
function assignLinesToColumns(lines: readonly TextLine[], columns: readonly ColumnRegion[]): TextLine[][] {
  const byColumn: TextLine[][] = columns.map(() => []);
  for (const line of lines) {
    let bestIndex = 0;
    let bestOverlap = -Infinity;
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]!;
      const overlap = Math.min(col.bbox.maxX, line.bbox.maxX) - Math.max(col.bbox.minX, line.bbox.minX);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    byColumn[bestIndex]!.push(line);
  }
  return byColumn;
}

/** Fraction of the block height covered by this column's OWN Y range (min-max) of lines. */
function verticalSpanRatio(lines: readonly TextLine[], blockHeight: number): number {
  if (lines.length === 0 || blockHeight <= 0) return 0;
  const minY = Math.min(...lines.map((l) => l.bbox.minY));
  const maxY = Math.max(...lines.map((l) => l.bbox.maxY));
  return (maxY - minY) / blockHeight;
}

/**
 * Removes columns from the list whose OWN content covers too small a slice of
 * the block height (see MIN_COLUMN_VERTICAL_SPAN_RATIO) — does NOT merge their
 * bbox into the neighbor's (deliberately, Step 6 discovery on files from
 * `samples/`): widening the neighbor's bbox with the sidebar area would erase
 * exactly the geometric signal that Z6 (blockBuilder) uses to recognize
 * "outside the column layout" — a sidebar must stay OUTSIDE the bbox of every
 * true column, otherwise the `sidebar` rule in Z6 could never tell it apart
 * from ordinary body text inside a column.
 */
function mergeSparseColumns(
  columns: readonly ColumnRegion[],
  columnarLines: readonly TextLine[],
  verticalHeight: number,
  pageNumber: number,
  diagnostics: Diagnostic[],
): ColumnRegion[] {
  let result = [...columns];
  let mergedAny = true;
  while (mergedAny && result.length > 1) {
    mergedAny = false;
    const assigned = assignLinesToColumns(columnarLines, result);
    for (let i = 0; i < result.length; i++) {
      const ratio = verticalSpanRatio(assigned[i]!, verticalHeight);
      if (ratio >= MIN_COLUMN_VERTICAL_SPAN_RATIO) continue;
      diagnostics.push({
        severity: 'info',
        code: 'COLUMN_SPARSE_DROPPED',
        params: { index: i, percent: (ratio * 100).toFixed(0), minPercent: MIN_COLUMN_VERTICAL_SPAN_RATIO * 100 },
        pageNumber,
      });
      result = [...result.slice(0, i), ...result.slice(i + 1)];
      mergedAny = true;
      break;
    }
  }
  return result.map((c, i) => ({ index: i, bbox: c.bbox }));
}

/**
 * [Step 6 Z3] CROSS-PAGE validation: column count is usually stable within a
 * chapter. A page that deviates from its NEIGHBORS (previous/next) is a
 * warning signal — it records a `Diagnostic`, but NEVER forces agreement or
 * changes that page's detection result.
 */
export function validateColumnStabilityAcrossPages(
  perPageColumnCounts: readonly { pageNumber: number; columnCount: number }[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < perPageColumnCounts.length; i++) {
    const curr = perPageColumnCounts[i]!;
    const prev = perPageColumnCounts[i - 1];
    const next = perPageColumnCounts[i + 1];
    const neighbors = [prev, next].filter((n): n is { pageNumber: number; columnCount: number } => n !== undefined);
    if (neighbors.length === 0) continue;
    const matchesAnyNeighbor = neighbors.some((n) => n.columnCount === curr.columnCount);
    if (!matchesAnyNeighbor) {
      diagnostics.push({
        severity: 'info',
        code: 'COLUMN_COUNT_UNSTABLE',
        params: { pageNumber: curr.pageNumber, columnCount: curr.columnCount, neighborCounts: neighbors.map((n) => n.columnCount).join('/') },
        pageNumber: curr.pageNumber,
      });
    }
  }
  return diagnostics;
}
