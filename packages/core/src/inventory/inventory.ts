import type { Rect } from '../geometry.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { buildFontKey, rankFontRoles, stripSubsetPrefix, type FontEntry, type FontRole } from './fontRegistry.js';
import { buildImageEntries, type ImageEntry, type PageImageEvents } from './imageRegistry.js';
import { buildVectorRegions, type VectorRegion } from './vectorRegistry.js';
import { walkOperators } from './walkOperators.js';

/**
 * Orchestration of the inventory pass (MDD annex A8, Step 4 Z5). Page by
 * page, sequentially — NEVER Promise.all across all pages (performance
 * rule #2 from MDD §12). Zero `objs.get()`, zero `render()`.
 */

export interface InventoryResult {
  pageCount: number;
  fonts: FontEntry[];
  fontRoles: Map<string, FontRole>;
  images: ImageEntry[];
  vectors: VectorRegion[];
  perPage: { pageNumber: number; box: Rect; rotation: number }[];
}

export interface BuildInventoryOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Duck-typed subset of `PDFPageProxy` actually used here — lets us test the
 * orchestration without a real pdf.js document.
 */
export interface PdfPageLike {
  view: readonly number[];
  rotate: number;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

function viewToRect(view: readonly number[]): Rect {
  const [x0, y0, x1, y1] = view;
  return { minX: x0 ?? 0, minY: y0 ?? 0, maxX: x1 ?? 0, maxY: y1 ?? 0 };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('buildInventory aborted by AbortSignal', 'AbortError');
  }
}

interface FontAccumulator {
  baseFont: string;
  size: number;
  glyphCount: number;
  itemCount: number;
  pages: Set<number>;
}

export async function buildInventory(
  doc: PdfDocumentLike,
  opts: BuildInventoryOptions = {},
): Promise<InventoryResult> {
  const { signal, onProgress } = opts;
  const pageCount = doc.numPages;

  const perPage: { pageNumber: number; box: Rect; rotation: number }[] = [];
  const perPageImageEvents: PageImageEvents[] = [];
  const allVectors: VectorRegion[] = [];
  const fontAccByKey = new Map<string, FontAccumulator>();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);

    const page = await doc.getPage(pageNumber);
    try {
      const pageBox = viewToRect(page.view);
      perPage.push({ pageNumber, box: pageBox, rotation: page.rotate ?? 0 });

      // ONE pass over this page's operator list — images, vectors, groups.
      const ops = await page.getOperatorList();
      checkAborted(signal);
      const events = walkOperators(ops, pageBox);

      perPageImageEvents.push({ page: pageNumber, pageBox, events });
      allVectors.push(...buildVectorRegions(events, pageNumber, pageBox));

      // Font fingerprinting: getTextContent() is a SEPARATE pdf.js call (not a
      // second pass over the operator list's fnArray) — needed for real
      // per-font glyph counts, which the operator list alone doesn't provide
      // in a form convenient to count without duplicating pdf.js's logic.
      // commonObjs is already populated thanks to getOperatorList() above (F0-Q1) —
      // no render required.
      const textContent = await page.getTextContent();
      checkAborted(signal);
      for (const item of textContent.items as Array<Record<string, unknown>>) {
        if (typeof item['str'] !== 'string' || item['str'].length === 0) continue;
        const fontName = item['fontName'] as string | undefined;
        if (!fontName || !page.commonObjs.has(fontName)) continue;
        const fontObj = page.commonObjs.get(fontName) as { name?: string } | undefined;
        const baseFont = fontObj?.name;
        if (!baseFont) continue;

        // [Step 9, discovery] MUST be EXACTLY the same formula as
        // `fontSizeFromTransform` (layout/textGeometry.ts, used by the entire
        // downstream text/layout layer to build `TextLine.dominantFont.key`) —
        // before this fix, this file computed size from transform[2]/[3] (the
        // Y axis), while `fontSizeFromTransform` computes it from
        // transform[0]/[1] (the X axis). For text with horizontal scaling
        // (`Tz`, condensed/expanded fonts) these two values DIFFER, so
        // `buildFontKey` produced a DIFFERENT key than the one that actually
        // ended up in `TextLine` — lines using such a font never found their
        // role in `fontRoles` (the key was missing from the registry), which
        // was measured as 284/369 `unknown` blocks on
        // Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf, whose dominant key was
        // `CaxtonStd-Book@7.5`, which was NOT in `inv.fonts` (the real
        // registry had `CaxtonStd-Book@8` and `@8.5`, built with the same
        // formula as here now).
        const transform = item['transform'] as number[] | undefined;
        const size = transform ? fontSizeFromTransform(transform) : 0;
        const key = buildFontKey(baseFont, size);

        let acc = fontAccByKey.get(key);
        if (!acc) {
          acc = { baseFont, size: Math.round(size * 2) / 2, glyphCount: 0, itemCount: 0, pages: new Set() };
          fontAccByKey.set(key, acc);
        }
        acc.glyphCount += (item['str'] as string).length;
        acc.itemCount += 1;
        acc.pages.add(pageNumber);
      }
    } finally {
      // Measured in phase 0: saves 33% memory at zero time cost.
      page.cleanup();
    }

    onProgress?.(pageNumber, pageCount);
  }

  const images = buildImageEntries(perPageImageEvents);

  const fonts: FontEntry[] = [...fontAccByKey.entries()]
    .map(([key, acc]) => {
      const { prefix } = stripSubsetPrefix(acc.baseFont);
      const entry: FontEntry = {
        key,
        baseFont: stripSubsetPrefix(acc.baseFont).name,
        subsetPrefix: prefix,
        size: acc.size,
        glyphCount: acc.glyphCount,
        itemCount: acc.itemCount,
        pages: acc.pages,
      };
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const fontRoles = rankFontRoles(fonts);

  // Determinism: order fixed by a stable key, not by Map/Set iteration order
  // (vectors sorted by page, then by bbox).
  allVectors.sort((a, b) => a.page - b.page || a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY);

  return {
    pageCount,
    fonts,
    fontRoles,
    images,
    vectors: allVectors,
    perPage,
  };
}
