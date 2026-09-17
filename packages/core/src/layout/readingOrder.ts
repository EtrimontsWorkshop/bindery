import type { ColumnRegion } from './columns.js';
import type { TextLine } from './lineCluster.js';
import type { SpanningSplit } from './spanning.js';
import type { StreamAngle } from '../text/types.js';

/**
 * Reading order (Step 6 Z4) — a BAND algorithm, resilient to spanning
 * elements: the page is sliced into horizontal bands at every spanning line
 * (Z2); within a band, columns go left->right (Z3), within a column lines go
 * top->bottom; bands go top->bottom; streams with angle != 0° come LAST,
 * each as its own sequence (marginalia are NOT interleaved into the main flow).
 */

export interface OrderedLine {
  line: TextLine;
  streamAngle: StreamAngle;
}

function midY(line: TextLine): number {
  return (line.bbox.minY + line.bbox.maxY) / 2;
}

/** The column with the LARGEST X overlap with the line — robust against small inaccuracies at the gutter boundary. */
function assignColumnIndex(line: TextLine, columns: readonly ColumnRegion[]): number {
  if (columns.length === 0) return -1;
  let best = columns[0]!;
  let bestOverlap = -Infinity;
  for (const col of columns) {
    const overlapStart = Math.max(col.bbox.minX, line.bbox.minX);
    const overlapEnd = Math.min(col.bbox.maxX, line.bbox.maxX);
    const overlap = overlapEnd - overlapStart;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = col;
    }
  }
  return best.index;
}

/** Column order within a band — left->right, REVERSED for pages rotated 180° (the reading direction reverses). */
function orderedColumnIndices(columns: readonly ColumnRegion[], pageRotation: 0 | 90 | 180 | 270): number[] {
  const indices = columns.map((c) => c.index).sort((a, b) => a - b);
  return pageRotation === 180 ? indices.reverse() : indices;
}

/**
 * Builds the reading order of the PRIMARY stream (angle 0°) from the
 * spanning/columnar split (Z2) and the detected columns (Z3), then appends the
 * remaining streams (angle != 0°) AT THE END, each as its own unbroken
 * sequence in its OWN pre-existing order (marginalia are not interleaved into
 * the main flow).
 */
export function buildReadingOrder(
  split: SpanningSplit,
  columns: readonly ColumnRegion[],
  otherStreams: readonly { angle: StreamAngle; lines: readonly TextLine[] }[] = [],
  pageRotation: 0 | 90 | 180 | 270 = 0,
): OrderedLine[] {
  const result: OrderedLine[] = [];

  // Bands: sort spanning lines top->bottom; each splits the page into a columnar band + itself as a separate band.
  const sortedSpanning = [...split.spanning].sort((a, b) => midY(b) - midY(a));
  const orderedCols = orderedColumnIndices(columns, pageRotation);

  function emitColumnarBand(bandTop: number, bandBottom: number): void {
    const inBand = split.columnar.filter((l) => {
      const y = midY(l);
      return y <= bandTop && y > bandBottom;
    });
    const byColumn = new Map<number, TextLine[]>();
    for (const line of inBand) {
      const colIndex = assignColumnIndex(line, columns);
      const arr = byColumn.get(colIndex) ?? [];
      arr.push({ ...line, columnIndex: colIndex });
      byColumn.set(colIndex, arr);
    }
    for (const colIndex of orderedCols) {
      const lines = (byColumn.get(colIndex) ?? []).sort((a, b) => midY(b) - midY(a));
      for (const line of lines) result.push({ line, streamAngle: 0 });
    }
    // Columnar lines not assigned to any detected column (columns=[]) go under key -1.
    if (columns.length === 0) {
      const orphan = (byColumn.get(-1) ?? []).sort((a, b) => midY(b) - midY(a));
      for (const line of orphan) result.push({ line, streamAngle: 0 });
    }
  }

  let cursorTop = Number.POSITIVE_INFINITY;
  for (const spanningLine of sortedSpanning) {
    emitColumnarBand(cursorTop, midY(spanningLine));
    result.push({ line: { ...spanningLine, columnIndex: -1 }, streamAngle: 0 });
    cursorTop = midY(spanningLine);
  }
  emitColumnarBand(cursorTop, Number.NEGATIVE_INFINITY);

  for (const stream of otherStreams) {
    for (const line of stream.lines) {
      result.push({ line: { ...line, columnIndex: -1 }, streamAngle: stream.angle });
    }
  }

  return result;
}
