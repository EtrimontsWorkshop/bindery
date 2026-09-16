import { rectsOverlap, unionRect, type Rect } from '../geometry.js';
import type { FontRole } from '../inventory/fontRegistry.js';
import type { VectorRegion } from '../inventory/vectorRegistry.js';
import type { ColumnRegion } from '../layout/columns.js';
import type { OrderedLine } from '../layout/readingOrder.js';
import type { TextLine } from '../layout/lineCluster.js';
import type { StreamAngle } from '../text/types.js';

/**
 * Scalanie linii w bloki semantyczne + klasyfikacja `BlockKind` (KROK-6 Z6,
 * MDD §5.2). Zamyka faze 2. Granice bloku: interlinia powyzej wielokrotnosci
 * TYPOWEJ dla danego fontu (wyliczonej z rozkladu tej strony, nie ze stalej),
 * wciecie pierwszej linii, zmiana dominujacego klucza fontu, granica
 * kolumny/pasma, krawedz regionu wektorowego (U3 — pierwsze realne uzycie
 * regionow wektorowych, patrz RAPORT-KROK-5/6.md).
 */

export type BlockKind =
  | 'heading'
  | 'body'
  | 'statblock'
  | 'table'
  | 'sidebar'
  | 'caption'
  | 'header'
  | 'footer'
  | 'marginalia'
  | 'unknown';

export interface SemanticBlock {
  id: string;
  kind: BlockKind;
  confidence: number;
  pageNumber: number;
  bbox: Rect;
  angle: StreamAngle;
  lines: TextLine[];
  rawText: string;
  headingLevel?: number;
  /** Ktora regula zlapala ten blok — MDD wymaga tego wprost dla debugowalnosci. */
  matchedRuleId?: string;
}

export interface ImageBBoxOnPage {
  bbox: Rect;
}

export interface BlockBuilderInput {
  pageNumber: number;
  /** Wynik Z4 (buildReadingOrder) — juz w poprawnej kolejnosci czytania, z columnIndex ustawionym. */
  orderedLines: readonly OrderedLine[];
  fontRoles: ReadonlyMap<string, FontRole>;
  /** Regiony wektorowe TEJ strony (z InventoryResult, krok 4). */
  vectors: readonly VectorRegion[];
  /** Bboxy obrazow TEJ strony (z InventoryResult, uproszczone do samego bbox). */
  images: readonly ImageBBoxOnPage[];
  /** lineId -> 'header'|'footer' z Z5 — TYLKO linie faktycznie potwierdzone jako biegnace. */
  runningElementKindByLineId: ReadonlyMap<string, 'header' | 'footer'>;
  /** Kolumny TEJ strony (Z3) — uzywane przez `sidebar` do sprawdzenia "na uboczu ukladu kolumnowego". */
  columns: readonly ColumnRegion[];
}

/** Interlinia POWYZEJ tej wielokrotnosci mediany dzieli blok (P1-podobna zasada: prog z danych, nie stala). */
const LINE_GAP_BREAK_MULTIPLIER = 1.8;
const MIN_GAP_SAMPLES_FOR_MEDIAN = 3;
/** Wciecie pierwszej linii POWYZEJ tego progu (pt) traktowane jako sygnal nowego bloku/akapitu. */
const INDENT_BREAK_THRESHOLD_PT = 8;
/** 5+ kropek lub kropek srodkowych pod rzad — podpis wypunktowania kropkowego (spisy tresci/tabele). */
const DOT_LEADER_RE = /[.·]{5,}/;
const MAX_TABLE_LINE_LENGTH = 40;
/** [KROK-9 Z1a] Odstep POWYZEJ tej wielokrotnosci typowej interlinii liczy sie jako izolacja pionowa (naglowek). */
const ISOLATION_GAP_MULTIPLIER = 1.5;

interface LineWithContext {
  ordered: OrderedLine;
  fontKey: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Odleglosc miedzy dwie kolejnymi liniami wzdluz osi czytania (przyblizona z crossAxisPosition — dziala dla 0°/90°/180°/270°). */
function lineGap(a: TextLine, b: TextLine): number {
  return Math.abs(a.crossAxisPosition - b.crossAxisPosition);
}

function computeTypicalGap(lines: readonly OrderedLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const curr = lines[i]!;
    if (prev.line.columnIndex !== curr.line.columnIndex || prev.streamAngle !== curr.streamAngle) continue;
    gaps.push(lineGap(prev.line, curr.line));
  }
  if (gaps.length < MIN_GAP_SAMPLES_FOR_MEDIAN) return 0;
  return median(gaps);
}

/** Pozycja "wzdluz osi czytania w poprzek" (indent) — dla 0°/180° to X, przyblizone przez minX bboxa. */
function lineIndent(line: TextLine): number {
  return line.bbox.minX;
}

function shouldBreak(prev: LineWithContext, curr: LineWithContext, typicalGap: number): boolean {
  if (prev.ordered.line.columnIndex !== curr.ordered.line.columnIndex) return true; // granica kolumny
  if (prev.ordered.streamAngle !== curr.ordered.streamAngle) return true; // granica pasma/strumienia
  if (prev.fontKey !== curr.fontKey) return true; // zmiana dominujacego klucza fontu
  if (typicalGap > 0) {
    const gap = lineGap(prev.ordered.line, curr.ordered.line);
    if (gap > typicalGap * LINE_GAP_BREAK_MULTIPLIER) return true; // interlinia powyzej wielokrotnosci typowej
  }
  if (Math.abs(lineIndent(curr.ordered.line) - lineIndent(prev.ordered.line)) > INDENT_BREAK_THRESHOLD_PT) return true; // wciecie
  return false;
}

function splitByVectorRegionEdges(group: OrderedLine[], vectors: readonly VectorRegion[]): OrderedLine[][] {
  if (vectors.length === 0 || group.length === 0) return [group];
  const regionOf = (line: TextLine): VectorRegion | null => {
    for (const v of vectors) {
      if (rectsOverlap(line.bbox, v.bbox)) return v;
    }
    return null;
  };
  const groups: OrderedLine[][] = [];
  let current: OrderedLine[] = [];
  let currentRegion: VectorRegion | null = null;
  for (const ol of group) {
    const region = regionOf(ol.line);
    if (current.length > 0 && region !== currentRegion) {
      groups.push(current);
      current = [];
    }
    currentRegion = region;
    current.push(ol);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function isDotLeader(text: string): boolean {
  return DOT_LEADER_RE.test(text);
}

function isNearImage(bbox: Rect, images: readonly ImageBBoxOnPage[]): boolean {
  return images.some((img) => rectsOverlap(bbox, img.bbox) || nearby(bbox, img.bbox));
}

/** "Sasiedztwo" luzniejsze niz scisle nakladanie — podpis jest zwykle TUZ obok obrazu, nie na nim. */
function nearby(a: Rect, b: Rect): boolean {
  const margin = 20;
  const expanded: Rect = { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin };
  return rectsOverlap(a, expanded);
}

function dominantFontKey(lines: readonly TextLine[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.dominantFont.key;
    counts.set(key, (counts.get(key) ?? 0) + line.text.length);
  }
  let best = lines[0]?.dominantFont.key ?? '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * [KROK-9 Z1a] Czy grupa (przed klasyfikacja) jest jednolinijkowa i otoczona
 * wyraznym pustym marginesem powyzej I ponizej wzdluz osi czytania (typowy
 * ksztalt naglowka) — brak sasiada w tej samej kolumnie/pasmie liczy sie jako
 * izolacja (gora kolumny/pasma, MDD §5.2 tabela regul dla `accent`).
 */
function computeIsolationFlags(groups: readonly OrderedLine[][], typicalGap: number): boolean[] {
  function gapToNeighbor(from: number, step: 1 | -1, col: number, angle: StreamAngle, selfLine: TextLine): boolean {
    for (let j = from + step; j >= 0 && j < groups.length; j += step) {
      const neighbor = groups[j]!;
      if (neighbor.length === 0) continue;
      if (neighbor[0]!.line.columnIndex !== col || neighbor[0]!.streamAngle !== angle) continue;
      const neighborLine = step === 1 ? neighbor[0]!.line : neighbor[neighbor.length - 1]!.line;
      if (typicalGap <= 0) return true;
      return lineGap(selfLine, neighborLine) > typicalGap * ISOLATION_GAP_MULTIPLIER;
    }
    return true; // brak sasiada w tej kolumnie/pasmie = gora/dol kolumny/pasma, traktowane jako izolacja
  }

  return groups.map((group, i) => {
    if (group.length !== 1) return false;
    const { line, streamAngle } = group[0]!;
    const col = line.columnIndex;
    return gapToNeighbor(i, -1, col, streamAngle, line) && gapToNeighbor(i, 1, col, streamAngle, line);
  });
}

/**
 * [KROK-6, odkrycie na `samples/`] "Na uboczu ukladu kolumnowego" (brief, tabela
 * BlockKind) — blok NIE nakladajacy sie z zadna WYKRYTA kolumna (Z3). Bez tego
 * warunku kazdy blok wewnatrz jakiejkolwiek prawdziwej kolumny, ktory
 * przypadkiem nakladal sie na duzy dekoracyjny fill (tlo strony na cala
 * wysokosc, pospolite w realnych PDF-ach RPG), rowniez trafial do `sidebar` —
 * zmierzone na kilku plikach z `samples/`: `body` liczylo 0 blokow na calym
 * ~160-stronicowym dokumencie, `sidebar` >5000, bo "hasColumns" bylo prawie
 * zawsze prawdziwe (patrz komentarz przy jego wyliczeniu) i KAZDY blok
 * nakladal sie na jakis fill.
 */
function isOffToTheSideOfColumns(bbox: Rect, columns: readonly ColumnRegion[]): boolean {
  if (columns.length === 0) return false;
  return columns.every((c) => !rectsOverlap(bbox, c.bbox));
}

function classify(
  lines: readonly TextLine[],
  angle: StreamAngle,
  bbox: Rect,
  fontRoles: ReadonlyMap<string, FontRole>,
  vectors: readonly VectorRegion[],
  images: readonly ImageBBoxOnPage[],
  runningKind: 'header' | 'footer' | null,
  hasColumns: boolean,
  columns: readonly ColumnRegion[],
  isIsolated: boolean,
): { kind: BlockKind; confidence: number; matchedRuleId: string } {
  if (runningKind) {
    return { kind: runningKind, confidence: 0.95, matchedRuleId: 'Z5-running-element' };
  }
  if (angle !== 0) {
    return { kind: 'marginalia', confidence: 0.85, matchedRuleId: 'Z6-marginalia-angle' };
  }

  const fontKey = dominantFontKey(lines);
  const role = fontRoles.get(fontKey) ?? 'unknown';
  const text = lines.map((l) => l.text).join(' ');

  const overlappingFill = vectors.find((v) => v.kind === 'fill' && rectsOverlap(bbox, v.bbox));
  if (overlappingFill && hasColumns && isOffToTheSideOfColumns(bbox, columns)) {
    return { kind: 'sidebar', confidence: 0.7, matchedRuleId: 'Z6-sidebar-vector-fill' };
  }

  if (isDotLeader(text)) {
    return { kind: 'table', confidence: 0.6, matchedRuleId: 'Z6-dot-leader' };
  }

  const shortLines = lines.filter((l) => l.text.trim().length > 0 && l.text.trim().length <= MAX_TABLE_LINE_LENGTH).length;
  if (lines.length >= 4 && shortLines / lines.length >= 0.8) {
    return { kind: 'table', confidence: 0.4, matchedRuleId: 'Z6-short-regular-lines' };
  }

  // [KROK-9 Z1a] `accent` skleja tytuly, stopki redakcyjne, podpisy ilustratorow
  // i wyroznienia srodtekstowe (MDD §5.2, 459/648 blokow `unknown` na CP-RED
  // mialo te role) — ponizsze reguly strukturalne daja jej szanse trafic gdzies
  // indziej niz `unknown` PRZED sprawdzeniem `heading`/`body` po samej roli,
  // zeby np. jednolinijkowy, izolowany blok `accent` na gorze kolumny zostal
  // naglowkiem, zanim reszta funkcji w ogole go zobaczy.
  if ((role === 'caption' || role === 'accent') && isNearImage(bbox, images)) {
    return { kind: 'caption', confidence: role === 'caption' ? 0.65 : 0.55, matchedRuleId: 'Z9-caption-near-image' };
  }

  if (role === 'heading' && lines.length <= 2) {
    return { kind: 'heading', confidence: 0.75, matchedRuleId: 'Z6-heading-role' };
  }

  if (role === 'accent' && lines.length === 1 && isIsolated) {
    return { kind: 'heading', confidence: 0.55, matchedRuleId: 'Z9-accent-isolated-heading' };
  }

  if (role === 'accent' && lines.length >= 2 && !isOffToTheSideOfColumns(bbox, columns)) {
    return { kind: 'body', confidence: 0.5, matchedRuleId: 'Z9-accent-multiline-in-column-body' };
  }

  // [KROK-6, odkrycie na `samples/`] Brief mowi "rola body, wiele linii", ale
  // empirycznie WIEKSZOSC blokow o roli body ma DOKLADNIE 1 linie (krotkie
  // akapity/kwestie dialogowe, granice bloku z wciecia/interlinii tna czesto
  // do pojedynczych linii) — wymog >=2 linii wrzucal je do `unknown` (na
  // Cienie_posrod_mgie.pdf: 2825 z 4562 blokow `unknown`, tj. 62%, mialo rola
  // body i dokladnie 1 linie). Rola juz odroznia body od heading (KROK-4:
  // osobne rankingi), liczba linii nie jest do tego potrzebna.
  if (role === 'body') {
    return { kind: 'body', confidence: 0.8, matchedRuleId: 'Z6-body-role' };
  }

  return { kind: 'unknown', confidence: 0.3, matchedRuleId: 'Z6-unknown-fallback' };
}

/**
 * Buduje `SemanticBlock[]` z linii JEDNEJ strony juz w kolejnosci czytania
 * (Z4). Kolejnosc krokow: (1) grupuj po granicach kolumny/pasma/fontu/interlinii
 * /wciecia, (2) dodatkowo tnij po krawedziach regionow wektorowych (U3),
 * (3) klasyfikuj kazda grupe.
 */
export function buildSemanticBlocks(input: BlockBuilderInput): SemanticBlock[] {
  const { pageNumber, fontRoles, vectors, images, runningElementKindByLineId, columns } = input;
  if (input.orderedLines.length === 0) return [];

  // [KROK-11] Naglowek-prefiks srodakapitowy jest juz rozciety WCZESNIEJ, w
  // `buildPageLayout.ts` (przed `splitSpanningLines`/`gutterRepair.ts`) — patrz
  // `layout/lineEdgeSplit.ts`. Tutaj `orderedLines` przychodzi juz gotowe.
  const orderedLines: readonly OrderedLine[] = input.orderedLines;

  const typicalGap = computeTypicalGap(orderedLines);
  const withContext: LineWithContext[] = orderedLines.map((ol) => ({
    ordered: ol,
    fontKey: ol.line.dominantFont.key,
  }));

  const rawGroups: OrderedLine[][] = [];
  let current: OrderedLine[] = [];
  for (let i = 0; i < withContext.length; i++) {
    const ctx = withContext[i]!;
    if (current.length > 0 && shouldBreak(withContext[i - 1]!, ctx, typicalGap)) {
      rawGroups.push(current);
      current = [];
    }
    current.push(ctx.ordered);
  }
  if (current.length > 0) rawGroups.push(current);

  const groups = rawGroups.flatMap((g) => splitByVectorRegionEdges(g, vectors));
  // [KROK-6, odkrycie] columnIndex=-1 oznacza "linia rozpinajaca/marginalia/poza
  // wykryta kolumna" (Z2/Z4), NIE "druga kolumna" — musi byc odfiltrowane, inaczej
  // KAZDA strona z choc jednym naglowkiem/linia rozpinajaca ponad jednokolumnowym
  // tekstem (bardzo czeste) falszywie liczy sie jako "ma kolumny" (zmierzone na
  // `samples/`: bez tego filtra `sidebar` dominowal kosztem `body` na kilku plikach).
  const hasColumns = new Set(orderedLines.map((ol) => ol.line.columnIndex).filter((idx) => idx >= 0)).size > 1;
  const isolationFlags = computeIsolationFlags(groups, typicalGap);

  const blocks: SemanticBlock[] = [];
  let blockIndex = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    if (group.length === 0) continue;
    const lines = group.map((ol) => ol.line);
    const bbox = lines.reduce<Rect | null>((acc, l) => (acc ? unionRect(acc, l.bbox) : l.bbox), null)!;
    const angle = group[0]!.streamAngle;

    const runningKinds = new Set(lines.map((l) => runningElementKindByLineId.get(l.id)).filter((k): k is 'header' | 'footer' => !!k));
    const runningKind = runningKinds.size === 1 ? [...runningKinds][0]! : null;

    const { kind, confidence, matchedRuleId } = classify(
      lines,
      angle,
      bbox,
      fontRoles,
      vectors,
      images,
      runningKind,
      hasColumns,
      columns,
      isolationFlags[g]!,
    );

    blocks.push({
      id: `p${pageNumber}-block${blockIndex++}`,
      kind,
      confidence,
      pageNumber,
      bbox,
      angle,
      lines,
      rawText: lines.map((l) => l.text).join('\n'),
      matchedRuleId,
    });
  }

  return blocks;
}
