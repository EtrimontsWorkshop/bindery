import type { Rect } from './geometry.js';
import { browserImageEncoder, type EncodedImage } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { buildImageExtraction, type BuildImageExtractionOptions, type BuildImageExtractionResult } from './images/buildImageExtraction.js';
import { groupBlockBoxesByPage } from './images/textBlockBoxes.js';
import { buildInventory } from './inventory/inventory.js';
import { withPdf } from './pdfDocument.js';
import { stagedProgress } from './stagedProgress.js';
import { createTextLayoutCollector, type BuildTextLayoutResult } from './text/buildTextLayout.js';
import { buildPageLayouts } from './layout/buildPageLayout.js';

/**
 * Entry point analogous to `inspectDocument` —
 * pdf.js is opened ONLY here (not in `packages/module`), and inventory is
 * stitched together with image extraction. An architectural reason, not a
 * stylistic one: `pdfjs-dist` is external (`external`) in ALL Vite
 * configurations in this repo (lazy loading), and the bare
 * specifier redirect to the real path (`output.paths` in `vite.config.ts`)
 * is configured ONLY in `packages/core`. A direct `import('pdfjs-dist/...')`
 * from `packages/module` would leave a bare specifier in the built code —
 * this is EXACTLY the same bug as an earlier "bare-specifier incident",
 * caught here by `check:imports` BEFORE deployment
 * to real Foundry.
 *
 * `browserRegionRenderer`/`browserImageEncoder` are standard web APIs
 * (OffscreenCanvas), not Foundry — using them here does not break the rule (the
 * boundary concerns Foundry globals: `game`/`Hooks`/`foundry`/`ui`/`canvas`/`CONFIG`,
 * not "browser code" in general).
 *
 * The same pattern as
 * `tools/calibrate-images.ts` (two separate `getDocument()` calls,
 * inventory + extraction) throws in real Foundry `TypeError: Cannot
 * perform Construct on a detached ArrayBuffer` on the SECOND call, even
 * though each call created a "fresh" `new Uint8Array(data)`. Cause: in the
 * browser, pdf.js uses a REAL Worker and TRANSFERS (does not copy) the
 * data buffer to the worker thread on the first `getDocument()` call —
 * this DETACHES the original `ArrayBuffer` in the main thread, so EVERY
 * subsequent view over the SAME underlying buffer (even a new
 * `Uint8Array`) is already unusable. This is a DIFFERENT mechanism than
 * the one documented earlier as "buffer-reuse DataCloneError" under Node
 * (there the fake worker also transfers, but within the same process —
 * the bug was in REUSING the same Uint8Array instance, not in the
 * transfer/detach itself). Fix: `data.slice(0)` BEFORE every
 * `getDocument()` call — creates an INDEPENDENT copy of the bytes, so
 * detaching one copy doesn't affect the original `data` or subsequent
 * copies.
 *
 * Every document is opened for ONE stage and released as soon as the stage is done (`withPdf`), also when
 * the stage throws or is aborted — see `pdfDocument.ts`.
 */

export interface ExtractImagesFromDocumentOptions extends BuildImageExtractionOptions {
  /** pdf.js asset base directory — see `InspectOptions.assetBaseUrl`. */
  assetBaseUrl: string;
}

/**
 * Bboxes of the text blocks grouped by page — the only point where the text pipeline and the image pipeline
 * (`buildImageExtraction`) meet, EXPLICITLY via the returned maps, not via global state. The text itself was
 * gathered during the inventory's walk (see `buildCIFFromDocument.ts`), so this opens nothing.
 */
function buildBlockBoxesByPage(textLayout: BuildTextLayoutResult, inv: Awaited<ReturnType<typeof buildInventory>>): { body: Map<number, Rect[]>; text: Map<number, Rect[]>; heading: Map<number, Rect[]> } {
  const { blocks } = buildPageLayouts(textLayout, {
    fontRoles: inv.fontRoles,
    vectors: inv.vectors,
    images: inv.images,
    perPage: inv.perPage,
  });

  // `body` AND `caption` — see the discovery in `classify.ts` at
  // `TEXT_COVERAGE_DECORATION_THRESHOLD`: flavor text on a decorative
  // background often has a font with the `caption` role (smaller/different
  // from the main `body`), not because it's an image caption, but simply
  // because it's close to an image. `text` holds every kind of block.
  return { body: groupBlockBoxesByPage(blocks, new Set(['body', 'caption'])), text: groupBlockBoxesByPage(blocks), heading: groupBlockBoxesByPage(blocks, new Set(['heading'])) };
}

export async function extractImagesFromDocument(
  data: ArrayBuffer,
  opts: ExtractImagesFromDocumentOptions,
): Promise<BuildImageExtractionResult> {
  const { assetBaseUrl, ...extractionOpts } = opts;
  // Both stages stop on the caller's signal and report into one progress figure (see `stagedProgress`).
  const { signal } = opts;
  const progressOf = stagedProgress(opts.onProgress, 2);
  const textCollector = createTextLayoutCollector();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await withPdf(data, assetBaseUrl, (invDoc) => buildInventory(invDoc as any, { signal, onProgress: progressOf(0), onPageText: textCollector.addPage }));
  const { body: bodyBlockBoxesByPage, text: textBlockBoxesByPage, heading: headingBlockBoxesByPage } = buildBlockBoxesByPage(textCollector.finish(new Map(inv.fonts.map((f) => [f.key, f.size])), signal), inv);

  const result = await withPdf(data, assetBaseUrl, (extractDoc) =>
    buildImageExtraction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractDoc as any,
      { images: inv.images, vectors: inv.vectors, shapes: inv.shapes, lines: inv.lines, perPage: inv.perPage },
      browserRegionRenderer,
      browserImageEncoder,
      { ...extractionOpts, onProgress: progressOf(1), bodyBlockBoxesByPage, textBlockBoxesByPage, headingBlockBoxesByPage, wordBoxesByPage: inv.wordBoxesByPage },
    ),
  );
  return { ...result, diagnostics: [...inv.diagnostics, ...result.diagnostics] };
}

export type { EncodedImage };
