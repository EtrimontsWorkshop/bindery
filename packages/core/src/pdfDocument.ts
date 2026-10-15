import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * The one place that opens a PDF with pdf.js for analysis, and the one place that releases it.
 *
 * Why releasing matters: without a shared worker (`GlobalWorkerOptions.workerPort` / `worker` option) every
 * `getDocument()` starts a REAL Web Worker in a browser, and that worker keeps the transferred bytes of the
 * whole file plus its font and image caches until the loading task is destroyed. `page.cleanup()` frees
 * resources of a page only, never the document or its worker. A document that is not destroyed therefore
 * stays in memory for as long as the page lives — one worker per open, several opens per import.
 *
 * `PDFDocumentProxy` has no `destroy()`; it belongs to the loading task (`doc.loadingTask`), which is why
 * this module keeps hold of it, including when loading itself fails (a password-protected or corrupt file).
 */

export interface OpenedPdf {
  doc: pdfjs.PDFDocumentProxy;
  /** Releases the document and its worker. Safe to call more than once; never throws. */
  destroy(): Promise<void>;
}

/**
 * Opens `data` and returns the document together with the means to release it. `data.slice(0)` — a copy
 * INDEPENDENT from `data`, NOT a view over it: in a real browser pdf.js TRANSFERS the buffer to the worker
 * thread on `getDocument()`, which DETACHES the original `ArrayBuffer` in the main thread, so the caller could
 * not reuse the same buffer for the next open (`TypeError: Cannot perform Construct on a detached
 * ArrayBuffer`). In Node the fake worker transfers within the process and the same copy keeps the
 * Uint8Array instance from being reused.
 */
export async function openPdf(data: ArrayBuffer, assetBaseUrl: string): Promise<OpenedPdf> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  });
  let destroying: Promise<void> | null = null;
  const destroy = (): Promise<void> => {
    destroying ??= loadingTask.destroy().catch((err: unknown) => {
      // Releasing is best effort: a failure here must not hide the result or the error of the work itself.
      console.warn('Bindery | releasing a PDF document failed:', err);
    });
    return destroying;
  };
  try {
    const doc = await loadingTask.promise;
    return { doc, destroy };
  } catch (err) {
    await destroy();
    throw err;
  }
}

/**
 * Runs `work` on a freshly opened document and releases the document afterwards, whether `work` returned,
 * threw or was aborted. The result must be plain data: nothing that refers to the document (a page, an
 * operator list) may leave `work`, because the document is gone when it returns.
 */
export async function withPdf<T>(data: ArrayBuffer, assetBaseUrl: string, work: (doc: pdfjs.PDFDocumentProxy) => Promise<T>): Promise<T> {
  const opened = await openPdf(data, assetBaseUrl);
  try {
    return await work(opened.doc);
  } finally {
    await opened.destroy();
  }
}
