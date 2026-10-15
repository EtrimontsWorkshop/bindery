import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { withPdf } from './pdfDocument.js';
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
   * In Foundry: 'modules/bindery-pdf-importer/lib/'. In Node tests: path to node_modules/pdfjs-dist.
   */
  assetBaseUrl: string;
}

/**
 * The only real function of the walking skeleton.
 * Opens the document, retrieves metadata/outline, and computes a quality
 * score for the text layer on a sample of pages (methodology from the
 * initial spike, see quality.ts).
 *
 * Throws PDFException/PasswordException from pdf.js without catching —
 * a readable message for an encrypted PDF is required, but that is the
 * responsibility of the UI layer (packages/module), not core. Core never
 * silently hides errors.
 */
export async function inspectDocument(
  data: ArrayBuffer,
  opts: InspectOptions,
): Promise<DocumentSummary> {
  // Opened and released in `pdfDocument.ts` (workerSrc, an independent copy of the bytes, and the release
  // also when this throws — a password-protected file makes the open itself throw).
  return withPdf(data, opts.assetBaseUrl, summarize);
}

async function summarize(doc: PDFDocumentProxy): Promise<DocumentSummary> {
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
