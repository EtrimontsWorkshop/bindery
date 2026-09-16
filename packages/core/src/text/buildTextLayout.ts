import { resolveFontKey } from '../inventory/fontRegistry.js';
import { groupByAngle } from '../layout/angleStreams.js';
import { clusterIntoLines, type TextLine } from '../layout/lineCluster.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { mergeWords, type MergeCandidateItem } from '../layout/wordMerge.js';
import { buildHierarchicalGapProfiles, collectGapSamples, type GapSample, type HierarchicalGapProfile } from './gapStatistics.js';
import { runHygiene } from './hygiene.js';
import type { Diagnostic, PdfTextItemLike, StreamAngle, WordBoundary } from './types.js';

/**
 * Orkiestracja warstwy tekstu (KROK-5, MDD §5.1) — spina Z1-Z5 w jeden przebieg
 * per dokument. DWIE fazy geometryczne, zgodnie z zalozeniem A8 (jak w kroku 4):
 * (1) higiena + zbieranie probek odstepow na CALYM dokumencie — enabler Z2,
 * nie da sie tego policzyc na jednej stronie; (2) scalanie i klastrowanie w
 * linie per strona, korzystajac z profilow zbudowanych w fazie 1. Obie fazy
 * dziela TE SAME juz wyciagniete dane per strone (cache w pamieci) — bez
 * drugiego wywolania `getTextContent()`.
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
   * `commonObjs` (uzywane przez `resolveFontKey`) jest wypelniane przez
   * `getOperatorList()`, NIE przez samo `getTextContent()` — pominiecie tego
   * wywolania sprawia, ze `commonObjs.has(fontName)` jest zawsze false, a
   * rozwiazywanie fontKey cicho spada do niedeterministycznego wewnetrznego id
   * pdf.js (`g_dN_fM`, gdzie N to GLOBALNY licznik dokumentow w procesie, nie
   * per-dokument — zweryfikowane empirycznie w KROK-5 przez test determinizmu).
   * Musi byc wywolane PRZED `getTextContent()`, dokladnie jak w `inventory.ts`.
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
    throw new DOMException('buildTextLayout przerwane przez AbortSignal', 'AbortError');
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

  // Faza 1: higiena + fontKey per item + probki odstepow, na calym dokumencie.
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      // Wypelnia commonObjs (fonty) BEZ renderu — patrz komentarz na PdfPageLike.getOperatorList.
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

  // [KROK-6 Z1a] Profil hierarchiczny (dokument + per-strona) — mergeWords uzywa
  // bardziej zachowawczego z dwoch progow, naprawiajac sklejenia na stronach o
  // gestym, nietypowym ukladzie (spisy tresci) bez zadnej wiedzy o semantyce.
  const fontGapProfiles = buildHierarchicalGapProfiles(allGapSamples, fontSizeByKey);

  // Faza 2: scalanie (Z4) + klastrowanie w linie (Z5) per strumien katowy, per strona. Czysta, brak I/O.
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
