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

/**
 * Gathers the text of a document page by page and lays it out at the end (the spacing statistics need every page).
 * It only takes what `getTextContent()` returned and the page's font registry, so whoever already walks the pages can
 * feed it: the inventory does (`onPageText` of `buildInventory`), which spares a whole second pass over the PDF.
 * `buildTextLayout` below is the same thing with its own walk.
 */
export interface TextLayoutCollector {
  /** One page's text items, as `getTextContent()` gave them, read on a page whose operator list was fetched first. */
  addPage(pageNumber: number, items: readonly unknown[], commonObjs: { has(id: string): boolean; get(id: string): unknown }): void;
  /** The layout of everything added. `fontSizeByKey` comes from the inventory's font registry. */
  finish(fontSizeByKey: ReadonlyMap<string, number>, signal?: AbortSignal): BuildTextLayoutResult;
}

export function createTextLayoutCollector(): TextLayoutCollector {
  const diagnostics: Diagnostic[] = [];
  const cachedPages: CachedPage[] = [];
  const allGapSamples: GapSample[] = [];

  return {
    addPage(pageNumber, items, commonObjs) {
      const rawItems = (items as PdfTextItemLike[]).filter((i) => 'str' in i);

      const hygiene = runHygiene(rawItems);
      for (const d of hygiene.diagnostics) diagnostics.push({ ...d, pageNumber });

      const enriched: MergeCandidateItem[] = hygiene.items.map((item) => {
        const size = fontSizeFromTransform(item.transform);
        const fontKey = resolveFontKey(item.fontName, commonObjs, size) ?? `unresolved:${item.fontName}`;
        return { ...item, fontKey };
      });

      cachedPages.push({ pageNumber, items: enriched, wordBoundaries: hygiene.wordBoundaries });
      for (const sample of collectGapSamples(enriched, pageNumber)) allGapSamples.push(sample);
    },

    finish(fontSizeByKey, signal) {
      const fontGapProfiles = buildHierarchicalGapProfiles(allGapSamples, fontSizeByKey);

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
    },
  };
}

/** The text layout of a document, from a walk of its own over the pages (see `createTextLayoutCollector` for the shared one). */
export async function buildTextLayout(
  doc: PdfDocumentLike,
  fontSizeByKey: ReadonlyMap<string, number>,
  opts: BuildTextLayoutOptions = {},
): Promise<BuildTextLayoutResult> {
  const { signal, onProgress } = opts;
  const pageCount = doc.numPages;
  const collector = createTextLayoutCollector();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      // The operator list first: `getTextContent()` on a page that has not been through it gives fonts no registry entry.
      await page.getOperatorList();
      checkAborted(signal);
      const textContent = await page.getTextContent();
      checkAborted(signal);
      collector.addPage(pageNumber, textContent.items, page.commonObjs);
    } finally {
      page.cleanup();
    }
    onProgress?.(pageNumber, pageCount);
  }

  return collector.finish(fontSizeByKey, signal);
}
