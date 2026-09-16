import type { ColumnRegion } from './columns.js';
import type { TextLine } from './lineCluster.js';
import type { SpanningSplit } from './spanning.js';
import type { StreamAngle } from '../text/types.js';

/**
 * Kolejnosc czytania (KROK-6 Z4) — algorytm PASMOWY, odporny na elementy
 * rozpinajace: strona jest ciachana na pasma poziome na kazdej linii
 * rozpinajacej (Z2); wewnatrz pasma kolumny ida lewo->prawo (Z3), wewnatrz
 * kolumny linie gora->dol; pasma gora->dol; strumienie o kacie != 0° NA KONCU,
 * kazdy jako osobna sekwencja (marginalia NIE sa wplatane w tok glowny).
 */

export interface OrderedLine {
  line: TextLine;
  streamAngle: StreamAngle;
}

function midY(line: TextLine): number {
  return (line.bbox.minY + line.bbox.maxY) / 2;
}

/** Kolumna o NAJWIEKSZYM pokryciu X z linia — odporne na drobne niedoklosci na granicy rynny. */
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

/** Kolejnosc kolumn w paśmie — lewo->prawo, ODWROCONA dla stron obroconych o 180° (kierunek czytania sie odwraca). */
function orderedColumnIndices(columns: readonly ColumnRegion[], pageRotation: 0 | 90 | 180 | 270): number[] {
  const indices = columns.map((c) => c.index).sort((a, b) => a - b);
  return pageRotation === 180 ? indices.reverse() : indices;
}

/**
 * Buduje kolejnosc czytania strumienia PODSTAWOWEGO (kat 0°) z podzialu
 * rozpinajace/kolumnowe (Z2) i wykrytych kolumn (Z3), po czym dokleja pozostale
 * strumienie (kat != 0°) NA KONCU, kazdy jako wlasna, nieprzerywana sekwencja
 * we WLASNEJ juz istniejacej kolejnosci (marginalia nie sa wplatane w tok glowny).
 */
export function buildReadingOrder(
  split: SpanningSplit,
  columns: readonly ColumnRegion[],
  otherStreams: readonly { angle: StreamAngle; lines: readonly TextLine[] }[] = [],
  pageRotation: 0 | 90 | 180 | 270 = 0,
): OrderedLine[] {
  const result: OrderedLine[] = [];

  // Pasma: posortuj linie rozpinajace gora->dol; kazda dzieli strone na pasmo-kolumnowe + siebie samą jako osobne pasmo.
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
    // Linie kolumnowe nieprzypisane do zadnej wykrytej kolumny (columns=[]) trafiaja pod klucz -1.
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
