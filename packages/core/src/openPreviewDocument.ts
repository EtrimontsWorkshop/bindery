import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { browserImageEncoder, type EncodedImage, type EncodeOptions } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { renderPagePreview } from './images/buildPagePreview.js';
import { renderRotatedRegion, type RotatedPdfRegion } from './images/renderRotatedRegion.js';

/**
 * [Step 11 Z3] Opens the document ONLY for the purpose of page preview in
 * the review screen (phase 9) — it does NOT recompute inventory/layout
 * (that was already done by `buildCIFFromDocument`, see
 * `buildCIFFromDocument.ts`). Intent: a lightweight, separate document
 * "handle" that the page preview panel in `packages/module` keeps open for
 * the entire duration of the review and queries FOR ANY page in any order
 * (the user scrolls/clicks `provenance.pageNumber`), without reopening the
 * whole document every time.
 *
 * The page box (`getPageBox`) reads ONLY `page.view` (the same mechanism
 * as `inventory.ts`'s `viewToRect`) — NEVER `getOperatorList()` (expensive,
 * unnecessary here) — and caches the result per page number, so repeated
 * navigation to the same page doesn't query pdf.js again.
 */

export interface PreviewPageHandle {
  pageNumber: number;
  box: Rect;
  rotation: number;
}

/** [Step 18] Like `EncodedImage`, but with the PIXEL dimensions of the decoded bitmap BEFORE encoding — needed by the caller to build `CIFImage.width/height` without re-decoding WebP/PNG in the browser. */
export interface RegionCrop extends EncodedImage {
  width: number;
  height: number;
}

export interface PreviewDocument {
  pageCount: number;
  /** Page box in PDF space (MediaBox via `page.view`) — cached after the first query for a given page. */
  getPageBox(pageNumber: number): Promise<PreviewPageHandle>;
  /** Renders the ENTIRE page to an encoded bitmap (WebP/PNG) — see `renderPagePreview`. */
  renderPage(pageNumber: number, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<EncodedImage>;
  /**
   * [Step 18, "Select and crop"] Renders ANY bbox (in PDF space, not
   * necessarily the whole `pageBox`) to an encoded bitmap — the manual
   * counterpart to `buildImageExtraction.ts`'s automatic extraction, for an
   * area indicated BY THE USER (dragging the mouse over the page preview
   * in `packages/module`), not detected automatically. Returns a
   * `RegionCrop` (not a bare `EncodedImage` like `renderPage`) — the
   * caller needs `width`/`height` to build a `CIFImage` right away without
   * additionally decoding the WebP bytes in the browser.
   */
  renderRegion(pageNumber: number, bbox: Rect, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<RegionCrop>;
  /**
   * [user report, "Select and crop" — ability to rotate the selected area]
   * Like `renderRegion`, but `region` does NOT have to be axis-aligned —
   * see `renderRotatedRegion.ts` for the full justification (renders the
   * bounding box normally, then "straightens" the actual, rotated
   * rectangle purely at the pixel level).
   */
  renderRotatedRegion(pageNumber: number, region: RotatedPdfRegion, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<RegionCrop>;
  /** Releases pdf.js resources (worker, document cache) — MUST be called when the review screen closes. */
  destroy(): Promise<void>;
}

export interface OpenPreviewDocumentOptions {
  assetBaseUrl: string;
}

export async function openPreviewDocument(data: ArrayBuffer, opts: OpenPreviewDocumentOptions): Promise<PreviewDocument> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;
  // `PDFDocumentProxy` (the result of `.promise`) does NOT have its own
  // `destroy()` — it belongs to `PDFDocumentLoadingTask` (the object
  // returned BY `getDocument()`, even before `.promise` resolves) — hence
  // we keep BOTH.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  });
  const doc = await loadingTask.promise;

  const boxCache = new Map<number, PreviewPageHandle>();

  async function getPageBox(pageNumber: number): Promise<PreviewPageHandle> {
    const cached = boxCache.get(pageNumber);
    if (cached) return cached;
    const page = await doc.getPage(pageNumber);
    const [x0, y0, x1, y1] = page.view;
    const handle: PreviewPageHandle = {
      pageNumber,
      box: { minX: x0 ?? 0, minY: y0 ?? 0, maxX: x1 ?? 0, maxY: y1 ?? 0 },
      rotation: page.rotate ?? 0,
    };
    page.cleanup();
    boxCache.set(pageNumber, handle);
    return handle;
  }

  return {
    pageCount: doc.numPages,
    getPageBox,
    async renderPage(pageNumber, renderOpts) {
      const { box } = await getPageBox(pageNumber);
      const page = await doc.getPage(pageNumber);
      try {
        return await renderPagePreview(page as never, box, browserRegionRenderer, browserImageEncoder, renderOpts);
      } finally {
        page.cleanup();
      }
    },
    async renderRegion(pageNumber, bbox, renderOpts) {
      const page = await doc.getPage(pageNumber);
      try {
        const decoded = await browserRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: renderOpts.targetLongEdgePx, signal: renderOpts.signal });
        const encoded = await browserImageEncoder.encode(decoded, { format: renderOpts.format, quality: renderOpts.quality });
        return { ...encoded, width: decoded.width, height: decoded.height };
      } finally {
        page.cleanup();
      }
    },
    async renderRotatedRegion(pageNumber, region, renderOpts) {
      const page = await doc.getPage(pageNumber);
      try {
        const decoded = await renderRotatedRegion(page as never, region, browserRegionRenderer, { targetLongEdgePx: renderOpts.targetLongEdgePx, signal: renderOpts.signal });
        const encoded = await browserImageEncoder.encode(decoded, { format: renderOpts.format, quality: renderOpts.quality });
        return { ...encoded, width: decoded.width, height: decoded.height };
      } finally {
        page.cleanup();
      }
    },
    async destroy() {
      await loadingTask.destroy();
    },
  };
}
