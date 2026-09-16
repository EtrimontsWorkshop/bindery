import type { Rect } from '../geometry.js';
import type { FontRole } from '../inventory/fontRegistry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion } from '../inventory/vectorRegistry.js';
import type { BuildTextLayoutResult, TextStream } from '../text/buildTextLayout.js';
import type { Diagnostic, StreamAngle } from '../text/types.js';
import { buildSemanticBlocks, type ImageBBoxOnPage, type SemanticBlock } from '../semantic/blockBuilder.js';
import { detectColumns, validateColumnStabilityAcrossPages, type ColumnRegion } from './columns.js';
import { repairGutterCrossingLines } from './gutterRepair.js';
import { splitLineByEdgeRun } from './lineEdgeSplit.js';
import { buildReadingOrder } from './readingOrder.js';
import { detectRunningElements, type PageForRunningElements } from './runningElements.js';
import { splitSpanningLines } from './spanning.js';

/**
 * Orkiestracja fazy 2, druga polowa (KROK-6) — spina Z2-Z6 w jeden przebieg
 * per dokument, na wejsciu z `buildTextLayout` (krok 5) i `buildInventory`
 * (krok 4). Zamyka faze 2 (MDD §8): wyjscie to `PageLayout[]` (kolumny +
 * strumienie w poprawnej kolejnosci czytania) i `SemanticBlock[]` calego dokumentu.
 *
 * `images`/`quality` z MDD §5.1 `PageLayout` NIE sa tu populowane — klasyfikacja
 * tresc/dekoracja obrazow nalezy do fazy 3, a `quality` (MDD §6.2) jest juz
 * osobnym, dokumentowym (nie per-strona) mechanizmem w `quality.ts`/`inspect.ts`.
 * Ten typ `PageLayout` jest CELOWO wezszy niz MDD — dokladnie zakres tego kroku.
 */

export interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  rotation: StreamAngle;
  columns: ColumnRegion[];
  streams: TextStream[];
}

export interface BuildPageLayoutResult {
  pages: PageLayout[];
  /** Bloki WSZYSTKICH stron, w kolejnosci: strona po stronie, wewnatrz strony w kolejnosci czytania. */
  blocks: SemanticBlock[];
  diagnostics: Diagnostic[];
}

export interface InventoryForLayout {
  fontRoles: ReadonlyMap<string, FontRole>;
  vectors: readonly VectorRegion[];
  images: readonly ImageEntry[];
  perPage: readonly { pageNumber: number; box: Rect; rotation: number }[];
}

function normalizeRotation(rotation: number): StreamAngle {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

export function buildPageLayouts(textLayout: BuildTextLayoutResult, inventory: InventoryForLayout): BuildPageLayoutResult {
  const diagnostics: Diagnostic[] = [...textLayout.diagnostics];
  const pageBoxByNumber = new Map(inventory.perPage.map((p) => [p.pageNumber, p]));
  const vectorsByPage = new Map<number, VectorRegion[]>();
  for (const v of inventory.vectors) {
    const arr = vectorsByPage.get(v.page) ?? [];
    arr.push(v);
    vectorsByPage.set(v.page, arr);
  }
  const imagesByPage = new Map<number, ImageBBoxOnPage[]>();
  for (const entry of inventory.images) {
    for (const occ of entry.occurrences) {
      const arr = imagesByPage.get(occ.page) ?? [];
      arr.push({ bbox: occ.bbox });
      imagesByPage.set(occ.page, arr);
    }
  }

  // Faza A (Z2+Z3, per strona): podzial rozpinajace/kolumnowe + detekcja kolumn.
  interface PerPagePrep {
    pageNumber: number;
    primaryStream: TextStream | undefined;
    otherStreams: TextStream[];
    split: ReturnType<typeof splitSpanningLines>;
    columns: ColumnRegion[];
    pageBox: Rect;
    rotation: StreamAngle;
  }

  const prep: PerPagePrep[] = textLayout.pages.map(({ pageNumber, streams }) => {
    const primaryStream = streams.find((s) => s.angle === 0);
    const otherStreams = streams.filter((s) => s.angle !== 0);
    const pageInfo = pageBoxByNumber.get(pageNumber);
    const pageBox = pageInfo?.box ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    // [KROK-11 Z1] Rozbij naglowki-etykiety srodakapitowe (prefiks I/LUB
    // sufiks linii) PRZED wszystkim innym — MUSI dzialac na SUROWYCH liniach
    // z `lineCluster.ts` (`runs` jeszcze nienaruszone), zanim
    // `splitSpanningLines`/`gutterRepair.ts` zdiazy je zaklasyfikowac/rozciac
    // po WLASNYM (tokenowym) dyskryminatorze i wyzerowac `runs` na
    // fragmentach — patrz naglowek `lineEdgeSplit.ts`. Wezsze fragmenty
    // powstale z tego rozciecia zwykle juz nie przecinaja zadnej rynny, wiec
    // `gutterRepair.ts` nie musi ich ponownie dotykac. Ograniczone do
    // strumienia PODSTAWOWEGO (kat 0) — tam wystepuje kolizja z
    // rynnami/kolumnami; strumienie boczne (marginalia pod innym katem) nie
    // przechodza przez `splitSpanningLines`/`detectColumns` w ten sam sposob.
    const edgeSplitLines = (primaryStream?.lines ?? []).flatMap((line) => splitLineByEdgeRun(line));
    const edgeSplitCount = edgeSplitLines.length - (primaryStream?.lines.length ?? 0);
    if (edgeSplitCount > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'INLINE_HEADING_EDGE_SPLIT',
        params: { count: edgeSplitCount },
        pageNumber,
      });
    }

    const rawSplit = splitSpanningLines(edgeSplitLines, undefined, pageBox.maxY - pageBox.minY);
    const { columns, confidence, diagnostics: colDiagnostics } = detectColumns(rawSplit.columnar, pageNumber);
    diagnostics.push(...colDiagnostics);

    // [KROK-10] Przebieg naprawczy PO detekcji kolumn — rozcina linie
    // falszywie sklejajace dwie kolumny na tej samej wysokosci (dyskryminator:
    // brak tokenow WEWNATRZ obszaru rynny), patrz gutterRepair.ts. Dziala na
    // kolumnach wykrytych z JUZ-poprawnie-kolumnowych linii (rawSplit.columnar,
    // nieskazonych przez sama anomalie, ktora z definicji trafila do
    // `spanning`) — zero cyklu detekcja->naprawa->ponowna detekcja.
    const { split, splitCount } = repairGutterCrossingLines(rawSplit, columns, confidence);
    if (splitCount > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'GUTTER_FALSE_MERGE_REPAIRED',
        params: { count: splitCount, confidence: confidence.toFixed(2) },
        pageNumber,
      });
    }

    return {
      pageNumber,
      primaryStream,
      otherStreams,
      split,
      columns,
      pageBox,
      rotation: normalizeRotation(pageInfo?.rotation ?? 0),
    };
  });

  // Faza B (Z5, DOKUMENT calosciowo — wzorzec A8): naglowki/stopki biegnace.
  const runningElementInput: PageForRunningElements[] = prep.map((p) => ({
    pageNumber: p.pageNumber,
    pageHeight: p.pageBox.maxY - p.pageBox.minY,
    primaryLines: [...p.split.spanning, ...p.split.columnar],
  }));
  const runningMatches = detectRunningElements(runningElementInput);
  const runningKindByPage = new Map<number, Map<string, 'header' | 'footer'>>();
  for (const m of runningMatches) {
    const map = runningKindByPage.get(m.pageNumber) ?? new Map<string, 'header' | 'footer'>();
    map.set(m.lineId, m.kind);
    runningKindByPage.set(m.pageNumber, map);
  }

  // Diagnostyka miedzystronicowa stabilnosci liczby kolumn (Z3) — informacyjna, nigdy nie wymusza zgodnosci.
  diagnostics.push(
    ...validateColumnStabilityAcrossPages(prep.map((p) => ({ pageNumber: p.pageNumber, columnCount: p.columns.length }))),
  );

  // Faza C (Z4+Z6, per strona): kolejnosc czytania + bloki semantyczne.
  const pages: PageLayout[] = [];
  const allBlocks: SemanticBlock[] = [];

  for (const p of prep) {
    const otherStreamsForOrder = p.otherStreams.map((s) => ({ angle: s.angle, lines: s.lines }));
    const ordered = buildReadingOrder(p.split, p.columns, otherStreamsForOrder, p.rotation);

    const primaryLines = ordered.filter((o) => o.streamAngle === 0).map((o) => o.line);
    const streams: TextStream[] = [{ angle: 0, isPrimary: true, lines: primaryLines }];
    for (const other of p.otherStreams) {
      const lines = ordered.filter((o) => o.streamAngle === other.angle).map((o) => o.line);
      streams.push({ angle: other.angle, isPrimary: false, lines });
    }

    pages.push({
      pageNumber: p.pageNumber,
      width: p.pageBox.maxX - p.pageBox.minX,
      height: p.pageBox.maxY - p.pageBox.minY,
      rotation: p.rotation,
      columns: p.columns,
      streams,
    });

    const blocks = buildSemanticBlocks({
      pageNumber: p.pageNumber,
      orderedLines: ordered,
      fontRoles: inventory.fontRoles,
      vectors: vectorsByPage.get(p.pageNumber) ?? [],
      images: imagesByPage.get(p.pageNumber) ?? [],
      runningElementKindByLineId: runningKindByPage.get(p.pageNumber) ?? new Map(),
      columns: p.columns,
    });
    allBlocks.push(...blocks);
  }

  return { pages, blocks: allBlocks, diagnostics };
}
