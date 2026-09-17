import type { Rect } from '../geometry.js';
import type { EncodedImage, EncodeOptions, ImageEncoder } from './encodeImage.js';
import type { PdfPageForRender, RegionRenderer } from './regionRenderer.js';

/**
 * [Step 11 Z3] Render of the WHOLE page (not a single image) into a bitmap —
 * needed for the PDF page preview panel on the review screen (phase 9). No
 * NEW render logic — `RegionRenderer`/`ImageEncoder` from step 7 already do
 * exactly what's needed (render an arbitrary page bbox, encode to
 * WebP/PNG); this file is a THIN orchestrator that simply passes the bbox of
 * the WHOLE page instead of a single image's bbox — mirroring the pattern of
 * `buildImageExtraction.ts`/`buildPageLayout.ts` (one entry point tying
 * already-existing pieces together), not a new mechanism.
 *
 * `renderer`/`encoder` are injected (not hardcoded to
 * `browserRegionRenderer`/`browserImageEncoder`) — the same reason as in
 * `buildImageExtraction.ts`: testability in Node (`nodeCanvasRenderer.ts`/
 * `nodeCanvasImageEncoder.ts`, deliberately NOT EXPORTED from `index.ts`),
 * while the Foundry layer (`packages/module`) injects `browserRegionRenderer`/
 * `browserImageEncoder` (the only real implementations in the browser, A1).
 */

export interface RenderPagePreviewOptions {
  /** Target length of the result's longer edge in pixels — see `RenderRegionOptions`. */
  targetLongEdgePx: number;
  signal?: AbortSignal;
  format?: EncodeOptions['format'];
  quality?: EncodeOptions['quality'];
}

/**
 * Renders the WHOLE page (bbox = `pageBox`, typically from
 * `InventoryResult.perPage[].box`, already computed by the inventory pass —
 * step 4 — to avoid re-reading `page.view` here) into an encoded bitmap
 * ready for an `<img>`.
 */
export async function renderPagePreview(
  page: PdfPageForRender,
  pageBox: Rect,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: RenderPagePreviewOptions,
): Promise<EncodedImage> {
  const decoded = await renderer.renderRegion(page, pageBox, { targetLongEdgePx: opts.targetLongEdgePx, signal: opts.signal });
  return encoder.encode(decoded, { format: opts.format, quality: opts.quality });
}
