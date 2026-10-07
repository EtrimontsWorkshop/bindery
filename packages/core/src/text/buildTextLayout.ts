import { resolveFontKey } from '../inventory/fontRegistry.js';
import { groupByAngle } from '../layout/angleStreams.js';
import { clusterIntoLines, type TextLine } from '../layout/lineCluster.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { mergeWords, type MergeCandidateItem } from '../layout/wordMerge.js';
import { buildHierarchicalGapProfiles, collectGapSamples, type GapSample, type HierarchicalGapProfile } from './gapStatistics.js';
import { runHygiene } from './hygiene.js';
import type { Diagnostic, PdfTextItemLike, StreamAngle, WordBoundary } from './types.js';

/**
 * Orchestration of the text layer — wires hygiene, gap statistics, word merging and line
 * clustering into a single pass per document. TWO geometric phases: (1) hygiene + collecting gap
 * samples across the WHOLE document — the enabler for gap statistics, this can't be computed on a
 * single page; (2) merging and line clustering per page, using the profiles built in phase 1.
 * Both phases share the SAME already-extracted per-page data (in-memory cache) — without a
 * second call to `getTextContent()`.
 */

export interface TextStream {
  angle: StreamAngle;
  isPrimary: boolean;
  lines: TextLine[];
}

export interface PageTextResult {
  pageNumber: number;
  streams: TextStream[];
}

export interface BuildTextLayoutResult {
  pages: PageTextResult[];
  fontGapProfiles: Map<string, HierarchicalGapProfile>;
  diagnostics: Diagnostic[];
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>;
  /**
   * `commonObjs` (used by `resolveFontKey`) is populated by
   * `getOperatorList()`, NOT by `getTextContent()` alone — skipping that call
   * makes `commonObjs.has(fontName)` always false, and fontKey resolution
   * silently falls back to pdf.js's non-deterministic internal id.
   * Must be called BEFORE `getTextContent()`, exactly as in `inventory.ts`.
   */
  getOperatorList(): Promise<unknown>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface BuildTextLayoutOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('buildTextLayout aborted by AbortSignal', 'AbortError');
  }
}

interface CachedPage {
  pageNumber: number;
  items: MergeCandidateItem[];
  wordBoundaries: WordBoundary[];
}

export async function buildTextLayout(
  doc: PdfDocumentLike,
  fontSizeByKey: ReadonlyMap<string, number>,
  opts: BuildTextLayoutOptions = {},
): Promise<BuildTextLayoutResult> {
  const { signal, onProgress } = opts;
  const pageCount = doc.numPages;
  const diagnostics: Diagnostic[] = [];
  const cachedPages: CachedPage[] = [];
  const allGapSamples: GapSample[] = [];

  // Phase 1: hygiene + per-item fontKey + gap samples, across the whole document.
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      // Populates commonObjs (fonts) WITHOUT a render — see the comment on PdfPageLike.getOperatorList.
      await page.getOperatorList();
      checkAborted(signal);
      const textContent = await page.getTextContent();
      checkAborted(signal);
      const rawItems = (textContent.items as PdfTextItemLike[]).filter((i) => 'str' in i);

      const hygiene = runHygiene(rawItems);
      for (const d of hygiene.diagnostics) diagnostics.push({ ...d, pageNumber });

      const enriched: MergeCandidateItem[] = hygiene.items.map((item) => {
        const size = fontSizeFromTransform(item.transform);
        const fontKey = resolveFontKey(item.fontName, page.commonObjs, size) ?? `unresolved:${item.fontName}`;
        return { ...item, fontKey };
      });

      cachedPages.push({ pageNumber, items: enriched, wordBoundaries: hygiene.wordBoundaries });
      allGapSamples.push(...collectGapSamples(enriched, pageNumber));
    } finally {
      page.cleanup();
    }
    onProgress?.(pageNumber, pageCount);
  }

  // Hierarchical profile (document + per-page) — mergeWords uses
  // the more conservative of the two thresholds, fixing merges on pages with
  // a dense, atypical layout (tables of contents) without any semantic knowledge.
  const fontGapProfiles = buildHierarchicalGapProfiles(allGapSamples, fontSizeByKey);

  // Phase 2: merging + line clustering per angular stream, per page. Pure, no I/O.
  const pages: PageTextResult[] = cachedPages.map(({ pageNumber, items, wordBoundaries }) => {
    checkAborted(signal);
    const { streams: angleBuckets, diagnostics: angleDiagnostics } = groupByAngle(items, pageNumber);
    diagnostics.push(...angleDiagnostics);

    const streams: TextStream[] = angleBuckets.map((bucket) => {
      const tokens = mergeWords(bucket.items, bucket.angle, wordBoundaries, fontGapProfiles, pageNumber);
      const lines = clusterIntoLines(tokens, bucket.angle, wordBoundaries, pageNumber);
      return { angle: bucket.angle, isPrimary: bucket.isPrimary, lines };
    });

    return { pageNumber, streams };
  });

  return { pages, fontGapProfiles, diagnostics };
}
