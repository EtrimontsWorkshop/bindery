import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from '../../geometry.js';
import { buildInventory } from '../../inventory/inventory.js';
import { buildPageLayouts } from '../../layout/buildPageLayout.js';
import type { SemanticBlock } from '../../semantic/blockBuilder.js';
import { buildTextLayout } from '../../text/buildTextLayout.js';
import type { PageTextElement } from '../extract/types.js';
import type { DetectionProgress, PageForDetection } from './types.js';

/**
 * [Task 3] "A thin integration layer with the existing pdf.js code" —
 * reuses the REAL, already-shipped pipeline (`buildInventory` ->
 * `buildTextLayout` -> `buildPageLayouts`, the exact same three calls
 * `buildCIFFromDocument.ts` already orchestrates for images/scenes/
 * journals — rule 5, not a second copy of pdf.js access) to get real
 * per-page text with real column detection (`PageLayout.columns`,
 * `layout/columns.ts`) and real vector-frame regions
 * (`inventory/vectorRegistry.ts`'s `VectorRegion`), then converts that
 * into the plain `PageForDetection[]` shape `detectStatblocks` (pure)
 * consumes. `detectStatblocks` itself never sees pdf.js.
 *
 * KNOWN LIMITATION (see PLAN.md's Task 3 open questions): `bold`/`italic`
 * are INFERRED from the font key's name containing "bold"/"italic"/etc.
 * — embedded PDF fonts do not reliably expose real weight/style flags
 * (the same finding, `fontRegistry.ts`'s own header comment, that shaped
 * the old, deleted profile engine) — this is a best-effort heuristic, not
 * ground truth. A profile's `styleFilter.bold`/`.italic` should be
 * treated accordingly by whoever authors one.
 */

export interface BuildPagesForDetectionOptions {
  assetBaseUrl: string;
  signal?: AbortSignal;
  onProgress?: (progress: DetectionProgress) => void;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function inferBoldItalic(fontKey: string): { bold: boolean; italic: boolean } {
  const baseFontPart = (fontKey.split('@')[0] ?? fontKey).toLowerCase();
  return {
    bold: baseFontPart.includes('bold') || baseFontPart.includes('black') || baseFontPart.includes('heavy'),
    italic: baseFontPart.includes('italic') || baseFontPart.includes('oblique'),
  };
}

/**
 * One `PageTextElement` per original token (`TextLine.tokens`, Step 10's
 * pre-aggregation bbox+text) — resolving each token's font by finding
 * which of the line's `runs` (contiguous same-font spans, optional —
 * absent means the whole line is one font) contains it; falling back to
 * the line's own `dominantFont` when there are no `runs` OR no `tokens`
 * at all (both optional fields, absent on a hand-built `TextLine` or a
 * degenerate single-token line).
 */
function semanticBlockToElements(block: SemanticBlock): PageTextElement[] {
  const elements: PageTextElement[] = [];
  for (const line of block.lines) {
    if (!line.tokens || line.tokens.length === 0) {
      const { bold, italic } = inferBoldItalic(line.dominantFont.key);
      elements.push({
        text: line.text,
        x: line.bbox.minX,
        y: line.bbox.minY,
        w: line.bbox.maxX - line.bbox.minX,
        h: line.bbox.maxY - line.bbox.minY,
        fontName: line.dominantFont.key,
        fontSize: line.dominantFont.size,
        bold,
        italic,
      });
      continue;
    }
    for (const token of line.tokens) {
      const run = line.runs?.find((r) => r.bbox.minX <= token.bbox.minX && r.bbox.maxX >= token.bbox.maxX);
      const fontKey = run?.fontKey ?? line.dominantFont.key;
      const fontSize = line.fonts.find((f) => f.key === fontKey)?.size ?? line.dominantFont.size;
      const { bold, italic } = inferBoldItalic(fontKey);
      elements.push({
        text: token.text,
        x: token.bbox.minX,
        y: token.bbox.minY,
        w: token.bbox.maxX - token.bbox.minX,
        h: token.bbox.maxY - token.bbox.minY,
        fontName: fontKey,
        fontSize,
        bold,
        italic,
      });
    }
  }
  return elements;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

/**
 * Batches page-by-page with an `onProgress` callback + `AbortSignal` check
 * between pages — "parsowanie partiami... bez blokowania UI" — the same
 * `onProgress`/`signal` contract `buildImageExtraction.ts` already uses
 * elsewhere in this codebase. `buildInventory`/`buildTextLayout` currently
 * process the whole document in one pass each (no per-page callback of
 * their own) — the per-page yielding/progress happens in THIS function's
 * own loop, once their results are in hand.
 */
export async function buildPagesForDetection(data: ArrayBuffer, options: BuildPagesForDetectionOptions): Promise<PageForDetection[]> {
  const { assetBaseUrl, signal } = options;

  const invDoc = await openDocument(data, assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inventory = await buildInventory(invDoc as any);
  checkAborted(signal);

  const layoutDoc = await openDocument(data, assetBaseUrl);
  const fontSizeByKey = new Map(inventory.fonts.map((f) => [f.key, f.size]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textLayout = await buildTextLayout(layoutDoc as any, fontSizeByKey);
  checkAborted(signal);

  const { pages: pageLayouts, blocks } = buildPageLayouts(textLayout, {
    fontRoles: inventory.fontRoles,
    vectors: inventory.vectors,
    images: inventory.images,
    perPage: inventory.perPage,
  });

  const blocksByPage = new Map<number, SemanticBlock[]>();
  for (const block of blocks) {
    const arr = blocksByPage.get(block.pageNumber) ?? [];
    arr.push(block);
    blocksByPage.set(block.pageNumber, arr);
  }

  const vectorFramesByPage = new Map<number, Rect[]>();
  for (const vector of inventory.vectors) {
    const arr = vectorFramesByPage.get(vector.page) ?? [];
    arr.push(vector.bbox);
    vectorFramesByPage.set(vector.page, arr);
  }

  const pageBoxByNumber = new Map(inventory.perPage.map((p) => [p.pageNumber, p.box]));

  const result: PageForDetection[] = [];
  const totalPages = pageLayouts.length;
  for (let i = 0; i < pageLayouts.length; i++) {
    checkAborted(signal);
    const layout = pageLayouts[i]!;
    const elements = (blocksByPage.get(layout.pageNumber) ?? []).flatMap(semanticBlockToElements);
    const columns = [...layout.columns].sort((a, b) => a.index - b.index).map((c) => c.bbox);
    result.push({
      pageNumber: layout.pageNumber,
      elements,
      pageBox: pageBoxByNumber.get(layout.pageNumber) ?? { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height },
      columns: columns.length > 0 ? columns : undefined,
      vectorFrames: vectorFramesByPage.get(layout.pageNumber),
    });
    options.onProgress?.({ pagesProcessed: i + 1, totalPages });
    // Yield a tick between pages so this never monopolizes the event loop, even on a large document.
    await Promise.resolve();
  }

  return result;
}
