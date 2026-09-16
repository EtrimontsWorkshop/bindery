import { unionRect, type Rect } from '../geometry.js';
import type { Diagnostic } from '../text/types.js';
import type { TextLine } from './lineCluster.js';

/**
 * Detekcja kolumn (KROK-6 Z3) — histogram gestosci na osi X, TYLKO strumien 0°,
 * TYLKO linie KOLUMNOWE (Z2 musi byc wywolane pierwsze — inaczej naglowek
 * rozpinajacy niszczy dolina rynny). Rzutuje bboksy LINII, nie itemow (U1:
 * itemy sa fragmentaryczne, linie nie).
 *
 * Brak wyraznych dolin -> jedna kolumna, z confidence=1. To POPRAWNA odpowiedz
 * (brief), nie awaria detekcji.
 */

export interface ColumnRegion {
  /** Kolejnosc czytania (0-based), lewo->prawo dla strumienia 0°. */
  index: number;
  bbox: Rect;
}

export interface ColumnDetectionResult {
  columns: ColumnRegion[];
  /** 0-1, dla CALEGO wyniku (nie per-kolumna) — jakosc najslabszej potwierdzonej rynny; 1 gdy brak rynien (jedna kolumna). */
  confidence: number;
  diagnostics: Diagnostic[];
}

const HISTOGRAM_BIN_WIDTH_PT = 2;
/** Rynna musi miec przynajmniej tyle punktow szerokosci, zeby liczyc sie jako kandydat (kalibrowane na samples/, patrz RAPORT-KROK-6.md). */
const MIN_VALLEY_WIDTH_PT = 10;
/** Gestosc w dolinie ponizej tego udzialu maksimum histogramu liczy sie jako "pusta". */
const MAX_VALLEY_DENSITY_RATIO = 0.05;
/**
 * Walidacja pionowa (brief): prawdziwa rynna jest pusta na WIEKSZOSCI wysokosci
 * bloku tekstu. Dolina widoczna tylko w gornej cwiartce strony (krotki akapit
 * konczacy sie wczesnie) to przypadek geometryczny, nie prawdziwa kolumnowa rynna.
 */
const MIN_VERTICAL_EMPTY_RATIO = 0.7;
/**
 * [KROK-6, odkrycie] Rynna moze byc realna (pusta na wiekszosci wysokosci) a
 * mimo to NIE oddzielac dwoch prawdziwych kolumn czytania — sidebar (ramka
 * wektorowa z krotkim tekstem obok kolumny) tworzy dokladnie taka sytuacje:
 * waska "kolumna" po jego stronie rynny istnieje tylko na malym WYCINKU
 * wysokosci bloku (empirycznie: fixture layout-2col-sidebar, sidebar zajmuje
 * ~33% wysokosci bloku). Brief (DoD): sidebar ma byc osobnym BLOKIEM (Z6,
 * sygnal regionu wektorowego), NIE trzecia kolumna. Kandydat na kolumne, ktorej
 * WLASNA tresc pokrywa mniej niz ten odsetek wysokosci bloku, jest scalany z
 * sasiadem zamiast liczony jako osobna kolumna czytania.
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
 * Wykrywa kolumny na JEDNEJ stronie z juz-wydzielonych linii kolumnowych (Z2).
 * `pageNumber` wylacznie do `Diagnostic.pageNumber`.
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
  // Rynny na samych brzegach (przed pierwsza/po ostatniej kolumnie) to margines strony, nie rynna miedzykolumnowa.
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

/** Linie z `lines` przypisane do kolumny o NAJWIEKSZYM pokryciu X (jak `assignColumnIndex` w readingOrder.ts). */
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

/** Odsetek wysokosci bloku pokryty WLASNYM zakresem Y (min-max) linii tej kolumny. */
function verticalSpanRatio(lines: readonly TextLine[], blockHeight: number): number {
  if (lines.length === 0 || blockHeight <= 0) return 0;
  const minY = Math.min(...lines.map((l) => l.bbox.minY));
  const maxY = Math.max(...lines.map((l) => l.bbox.maxY));
  return (maxY - minY) / blockHeight;
}

/**
 * Usuwa z listy kolumn te, ktorych WLASNA tresc pokrywa zbyt maly wycinek
 * wysokosci bloku (patrz MIN_COLUMN_VERTICAL_SPAN_RATIO) — NIE laczy ich bboxa
 * z sasiadem (celowo, KROK-6 odkrycie na plikach z `samples/`): poszerzenie
 * bboxa sasiada o obszar sidebaru zatrze wlasnie ten sygnal geometryczny, po
 * ktorym Z6 (blockBuilder) rozpoznaje "na uboczu ukladu kolumnowego" — sidebar
 * musi pozostac POZA bboxem kazdej prawdziwej kolumny, inaczej reguła
 * `sidebar` w Z6 nigdy nie odrozni go od zwyklego body tekstu wewnatrz kolumny.
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
 * [KROK-6 Z3] Walidacja MIEDZYSTRONICOWA: liczba kolumn zwykle stabilna w
 * obrebie rozdzialu. Strona odstajaca od SASIADOW (poprzednia/nastepna) to
 * sygnal ostrzegawczy — zapisuje `Diagnostic`, NIGDY nie wymusza zgodnosci ani
 * nie zmienia wyniku detekcji tej strony.
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
