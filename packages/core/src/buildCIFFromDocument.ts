import { buildCIFDocument, type BuildCIFDocumentResult } from './cif/buildCIFDocument.js';
import { extractOutline } from './cif/outline.js';
import { browserImageEncoder } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { buildImageExtraction, type BuildImageExtractionOptions } from './images/buildImageExtraction.js';
import { groupBlockBoxesByPage } from './images/textBlockBoxes.js';
import { buildInventory } from './inventory/inventory.js';
import { withPdf } from './pdfDocument.js';
import { stagedProgress } from './stagedProgress.js';
import { buildPageLayouts } from './layout/buildPageLayout.js';
import { createTextLayoutCollector } from './text/buildTextLayout.js';

/**
 * Entry point analogous to `extractImagesFromDocument` — pdf.js is opened ONLY here, and ALL FOUR pipelines (inventory,
 * text/layout, bookmarks, images) are stitched together into a single
 * `CIFDocument`. Same architectural reason as there: `pdfjs-dist` is
 * external in ALL Vite configurations, and the bare-specifier redirect is
 * configured ONLY in `packages/core/vite.config.ts` (check:imports).
 *
 * TWO separate `getDocument()` calls (inventory + text + bookmarks, then image extraction), each
 * with its OWN independent copy of the bytes (see `openPdf`): a real browser TRANSFERS (detaches) the
 * buffer to the Worker thread on EVERY `getDocument()` call. Image extraction is NOT merged into the first
 * document: it relies on a fresh one (pdf.js object ids and `page.objs` depend on which pages a
 * document has already visited). The text layout needs, of every fresh page, its operator list and then its
 * text — exactly what the inventory reads — so it is fed from the inventory's walk (`onPageText`) instead
 * of opening and parsing the whole PDF once more. Bookmarks do not depend on page state, so they share
 * that document too.
 *
 * Every document is opened for ONE stage and released as soon as the stage is done (`withPdf`), also when
 * the stage throws or is aborted: at most one pdf.js worker is alive at a time, and none afterwards.
 */

export interface BuildCIFFromDocumentOptions extends Pick<BuildImageExtractionOptions, 'targetLongEdgePx' | 'maxLongEdgePx' | 'outputFormat' | 'outputQuality' | 'signal' | 'onProgress' | 'includeVectorFigures' | 'removeNumberMarkers' | 'whiteBackground'> {
  assetBaseUrl: string;
  fileName: string;
  fileHash: string;
  detectedLanguage?: string | null;
  /** `false` leaves `document.journals` empty: the book's text is not laid out as journal pages (HTML) when nothing will read them. Default `true`. */
  includeJournals?: boolean;
}

export async function buildCIFFromDocument(data: ArrayBuffer, opts: BuildCIFFromDocumentOptions): Promise<BuildCIFDocumentResult> {
  const { assetBaseUrl, fileName, fileHash, detectedLanguage, includeJournals, ...imageOpts } = opts;
  // Both stages stop on the caller's signal and report into one progress figure (see `stagedProgress`).
  const { signal } = opts;
  const progressOf = stagedProgress(opts.onProgress, 2);
  const textCollector = createTextLayoutCollector();

  // Bookmarks do not depend on the state of pages, so they are read from the inventory document.
  const { inv, pageCount, outline } = await withPdf(data, assetBaseUrl, async (doc) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inventory = await buildInventory(doc as any, { signal, onProgress: progressOf(0), onPageText: textCollector.addPage });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookmarks = await extractOutline(doc as any);
    return { inv: inventory, pageCount: doc.numPages, outline: bookmarks };
  });

  const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));
  const textLayout = textCollector.finish(fontSizeByKey, signal);
  const { blocks } = buildPageLayouts(textLayout, {
    fontRoles: inv.fontRoles,
    vectors: inv.vectors,
    images: inv.images,
    perPage: inv.perPage,
  });

  // Bboxes of `body`+`caption` blocks (see classify.ts) — the same map is used here
  // AND for images, without needing an additional `getDocument()` call (we
  // already have `blocks`).
  const bodyBlockBoxesByPage = groupBlockBoxesByPage(blocks, new Set(['body', 'caption']));
  const textBlockBoxesByPage = groupBlockBoxesByPage(blocks);
  const headingBlockBoxesByPage = groupBlockBoxesByPage(blocks, new Set(['heading']));

  const imageResult = await withPdf(data, assetBaseUrl, (extractDoc) =>
    buildImageExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractDoc as any,
      { images: inv.images, vectors: inv.vectors, shapes: inv.shapes, lines: inv.lines, perPage: inv.perPage },
      browserRegionRenderer,
      browserImageEncoder,
      {
        ...imageOpts,
        onProgress: progressOf(1),
        bodyBlockBoxesByPage,
        textBlockBoxesByPage,
        headingBlockBoxesByPage,
        wordBoxesByPage: inv.wordBoxesByPage,
      },
    ),
  );

  return buildCIFDocument({
    fileName,
    fileHash,
    pageCount,
    detectedLanguage: detectedLanguage ?? null,
    blocks,
    outline,
    images: imageResult.images,
    diagnostics: [...inv.diagnostics, ...textLayout.diagnostics, ...imageResult.diagnostics],
    includeJournals,
  });
}
