import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { browserImageEncoder, type EncodedImage } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { buildImageExtraction, type BuildImageExtractionOptions, type BuildImageExtractionResult } from './images/buildImageExtraction.js';
import { buildInventory } from './inventory/inventory.js';
import { buildTextLayout } from './text/buildTextLayout.js';
import { buildPageLayouts } from './layout/buildPageLayout.js';

/**
 * [Step 8 Z4/Z5] Entry point analogous to `inspectDocument` (phase 1) —
 * pdf.js is opened ONLY here (not in `packages/module`), and inventory is
 * stitched together with image extraction. An architectural reason, not a
 * stylistic one: `pdfjs-dist` is external (`external`) in ALL Vite
 * configurations in this repo (risk I3 — lazy loading), and the bare
 * specifier redirect to the real path (`output.paths` in `vite.config.ts`)
 * is configured ONLY in `packages/core`. A direct `import('pdfjs-dist/...')`
 * from `packages/module` would leave a bare specifier in the built code —
 * this is EXACTLY the same bug as the "bare-specifier incident" from phase
 * 1 (RAPORT-FAZA-1.md), caught here by `check:imports` BEFORE deployment
 * to real Foundry.
 *
 * `browserRegionRenderer`/`browserImageEncoder` are standard web APIs
 * (OffscreenCanvas), not Foundry — using them here does not break A1 (the
 * boundary concerns Foundry globals: `game`/`Hooks`/`foundry`/`ui`/`canvas`/`CONFIG`,
 * not "browser code" in general).
 *
 * [Step 8, discovery — a REAL browser, not Node] The same pattern as
 * `tools/calibrate-images.ts` (two separate `getDocument()` calls,
 * inventory + extraction) throws in real Foundry `TypeError: Cannot
 * perform Construct on a detached ArrayBuffer` on the SECOND call, even
 * though each call created a "fresh" `new Uint8Array(data)`. Cause: in the
 * browser, pdf.js uses a REAL Worker and TRANSFERS (does not copy) the
 * data buffer to the worker thread on the first `getDocument()` call —
 * this DETACHES the original `ArrayBuffer` in the main thread, so EVERY
 * subsequent view over the SAME underlying buffer (even a new
 * `Uint8Array`) is already unusable. This is a DIFFERENT mechanism than
 * the one documented in Step 4 "buffer-reuse DataCloneError" under Node
 * (there the fake worker also transfers, but within the same process —
 * the bug was in REUSING the same Uint8Array instance, not in the
 * transfer/detach itself). Fix: `data.slice(0)` BEFORE every
 * `getDocument()` call — creates an INDEPENDENT copy of the bytes, so
 * detaching one copy doesn't affect the original `data` or subsequent
 * copies.
 */

export interface ExtractImagesFromDocumentOptions extends BuildImageExtractionOptions {
  /** pdf.js asset base directory — see `InspectOptions.assetBaseUrl`. */
  assetBaseUrl: string;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    // `data.slice(0)` — a copy INDEPENDENT from `data`, see the comment
    // above the file (the browser transfers/detaches the buffer to the
    // Worker thread per call).
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

/**
 * [Step 9 Z2] Bboxes of `body` blocks (text pipeline) grouped by page — the
 * only point where the text pipeline (`buildTextLayout`+`buildPageLayouts`)
 * and the image pipeline (`buildImageExtraction`) actually meet, EXPLICITLY
 * via the returned map, not via global state (Step 9 Z2 brief). A third
 * `getDocument()` call (separate from inventory/extraction) — see the
 * comment above the file: every use of pdf.js in the browser needs its OWN
 * independent copy of the bytes.
 */
async function buildBodyBlockBoxesByPage(
  data: ArrayBuffer,
  assetBaseUrl: string,
  inv: Awaited<ReturnType<typeof buildInventory>>,
): Promise<Map<number, Rect[]>> {
  const layoutDoc = await openDocument(data, assetBaseUrl);
  const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textLayout = await buildTextLayout(layoutDoc as any, fontSizeByKey);
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
  // because it's close to an image.
  const byPage = new Map<number, Rect[]>();
  for (const b of blocks) {
    if (b.kind !== 'body' && b.kind !== 'caption') continue;
    const arr = byPage.get(b.pageNumber) ?? [];
    arr.push(b.bbox);
    byPage.set(b.pageNumber, arr);
  }
  return byPage;
}

export async function extractImagesFromDocument(
  data: ArrayBuffer,
  opts: ExtractImagesFromDocumentOptions,
): Promise<BuildImageExtractionResult> {
  const { assetBaseUrl, ...extractionOpts } = opts;

  const invDoc = await openDocument(data, assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);
  const bodyBlockBoxesByPage = await buildBodyBlockBoxesByPage(data, assetBaseUrl, inv);
  const extractDoc = await openDocument(data, assetBaseUrl);

  return buildImageExtraction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractDoc as any,
    { images: inv.images, vectors: inv.vectors, perPage: inv.perPage },
    browserRegionRenderer,
    browserImageEncoder,
    { ...extractionOpts, bodyBlockBoxesByPage },
  );
}

export type { EncodedImage };
