import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { classifyQuality, mergeSignals, pickSamplePages, tallySignals } from './quality.js';

export interface DocumentSummary {
  pageCount: number;
  title: string | null;
  producer: string | null;
  hasOutline: boolean;
  quality: {
    hasTextLayer: boolean;
    unicodeConfidence: number;
    suspectedScan: boolean;
  };
}

export interface InspectOptions {
  /**
   * pdf.js asset base directory, with a trailing slash.
   * In Foundry: 'modules/bindery/lib/'. In Node tests: path to node_modules/pdfjs-dist.
   */
  assetBaseUrl: string;
}

/**
 * The only real function of phase 1 (walking skeleton).
 * Opens the document, retrieves metadata/outline, and computes a quality
 * score for the text layer on a sample of pages (methodology from the
 * phase 0 spike, see quality.ts).
 *
 * Throws PDFException/PasswordException from pdf.js without catching —
 * R4 requires a readable message for an encrypted PDF, but that is the
 * responsibility of the UI layer (packages/module), not core. Core never
 * silently hides errors.
 */
export async function inspectDocument(
  data: ArrayBuffer,
  opts: InspectOptions,
): Promise<DocumentSummary> {
  // pdf.js configuration (not Foundry) — a single source of truth, works
  // the same in Node (tests) as in the browser (risk I1). In Node, pdf.js
  // uses a fake worker automatically, so this line is a no-op outside the browser.
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;

  // `data.slice(0)` — a copy INDEPENDENT from `data`, NOT a view over it
  // (Step 8 discovery: in a real browser pdf.js TRANSFERS the buffer to
  // the Worker thread on `getDocument()`, which DETACHES the original
  // ArrayBuffer in the main thread). Without this copy the caller (e.g.
  // `ImportWizard`, which holds one `ArrayBuffer` per selected file)
  // couldn't reuse the same buffer for a DIFFERENT call (e.g.
  // `extractImagesFromDocument` after `inspectDocument` on the same file)
  // — the second attempt would throw `TypeError: Cannot perform Construct
  // on a detached ArrayBuffer`. See the full description in
  // `extractImagesFromDocument.ts`.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const pageCount = doc.numPages;

  let title: string | null = null;
  let producer: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, unknown> | undefined;
    title = typeof info?.['Title'] === 'string' && info['Title'] ? (info['Title'] as string) : null;
    producer =
      typeof info?.['Producer'] === 'string' && info['Producer'] ? (info['Producer'] as string) : null;
  } catch {
    // metadata is optional — its absence is not a critical error
  }

  let hasOutline = false;
  try {
    const outline = await doc.getOutline();
    hasOutline = Array.isArray(outline) && outline.length > 0;
  } catch {
    // outline is optional
  }

  const samplePages = pickSamplePages(pageCount);
  const perPageSignals = [];
  let glyphCount = 0;

  for (const pageNum of samplePages) {
    const page = await doc.getPage(pageNum);
    try {
      const textContent = await page.getTextContent();
      let pageText = '';
      for (const item of textContent.items) {
        if ('str' in item) pageText += item.str;
      }
      glyphCount += pageText.length;
      perPageSignals.push(tallySignals(pageText));
    } finally {
      page.cleanup();
    }
  }

  const quality = classifyQuality(glyphCount, mergeSignals(perPageSignals));

  return {
    pageCount,
    title,
    producer,
    hasOutline,
    quality,
  };
}
