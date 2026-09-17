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
 * Orchestration of phase 2, second half (Step 6) — wires Z2-Z6 into a single
 * pass per document, fed by `buildTextLayout` (step 5) and `buildInventory`
 * (step 4). Closes out phase 2 (MDD §8): output is `PageLayout[]` (columns +
 * streams in correct reading order) and `SemanticBlock[]` for the whole document.
 *
 * `images`/`quality` from MDD §5.1's `PageLayout` are NOT populated here — image
 * content/decoration classification belongs to phase 3, and `quality` (MDD §6.2) is
 * already a separate, document-level (not per-page) mechanism in `quality.ts`/`inspect.ts`.
 * This `PageLayout` type is DELIBERATELY narrower than the MDD one — exactly this step's scope.
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
  /** Blocks from ALL pages, in order: page by page, and within a page in reading order. */
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

  // Phase A (Z2+Z3, per page): spanning/columnar split + column detection.
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

    // [Step 11 Z1] Split off inline heading labels (line-start AND/OR
    // line-end prefix) BEFORE everything else — MUST operate on the RAW
    // lines from `lineCluster.ts` (`runs` still untouched), before
    // `splitSpanningLines`/`gutterRepair.ts` get a chance to classify/split
    // them using their OWN (token-based) discriminator and clear `runs` on
    // the fragments — see the `lineEdgeSplit.ts` header comment. The narrower
    // fragments produced by this split usually no longer cross any gutter, so
    // `gutterRepair.ts` doesn't need to touch them again. Restricted to the
    // PRIMARY stream (angle 0) — that's where the collision with
    // gutters/columns happens; side streams (marginalia at another angle) don't
    // go through `splitSpanningLines`/`detectColumns` the same way.
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

    // [Step 10] Repair pass AFTER column detection — splits lines that were
    // falsely merged across two columns at the same height (discriminator:
    // no tokens INSIDE the gutter area), see gutterRepair.ts. Operates on
    // columns detected from lines that were ALREADY correctly columnar
    // (rawSplit.columnar, unaffected by the very anomaly that by definition
    // ended up in `spanning`) — zero detect->repair->re-detect cycle.
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

  // Phase B (Z5, WHOLE DOCUMENT — A8 pattern): running headers/footers.
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

  // Cross-page diagnostics on column-count stability (Z3) — informational only, never enforces agreement.
  diagnostics.push(
    ...validateColumnStabilityAcrossPages(prep.map((p) => ({ pageNumber: p.pageNumber, columnCount: p.columns.length }))),
  );

  // Phase C (Z4+Z6, per page): reading order + semantic blocks.
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
