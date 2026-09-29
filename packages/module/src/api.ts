import { ASSET_BASE_URL } from './settings.js';

export interface BinderyAPI {
  readonly version: string;
  /**
   * Analyzes a PDF without a UI. Loading @bindery/core (and the pdf.js it
   * uses) is lazy — only on first call (risk I3).
   */
  inspectDocument(data: ArrayBuffer): Promise<import('@bindery/core').DocumentSummary>;
}

/** Preview of an extracted image — ONLY what the review screen needs (A5: a human always reviews before saving). */
export interface ExtractedImagePreview {
  objId: string | null;
  page: number;
  classification: import('@bindery/core').ImageClassification;
  targetKind: string;
  width: number;
  height: number;
  format: 'webp' | 'png';
  bytes: Uint8Array;
  /** Blob URL for previewing in the UI — the caller is responsible for `URL.revokeObjectURL` after closing. */
  previewUrl: string;
}

function bytesToBlobUrl(bytes: Uint8Array, format: 'webp' | 'png'): string {
  const mime = format === 'webp' ? 'image/webp' : 'image/png';
  // Copy into a new ArrayBuffer (not ArrayBufferLike/SharedArrayBuffer) — required by the `BlobPart` type.
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
}

export function buildAPI(version: string): BinderyAPI {
  return {
    version,
    async inspectDocument(data: ArrayBuffer) {
      const { inspectDocument } = await import('@bindery/core');
      return inspectDocument(data, { assetBaseUrl: ASSET_BASE_URL });
    },
  };
}

/**
 * Phase 3 orchestration over a real document in the browser (Step 8 Z4/Z5).
 * All the logic for opening pdf.js and stitching together inventory and
 * extraction lives in `@bindery/core` (`extractImagesFromDocument`) — NOT
 * here. Reason: `pdfjs-dist` is external (`external`) in all of this repo's
 * Vite configs, but remapping the bare specifier to a real path
 * (`output.paths`) is configured ONLY in `packages/core/vite.config.ts`. A
 * direct `import('pdfjs-dist/...')` FROM HERE would leave a bare specifier
 * in the module's built code — caught empirically by `check:imports` (the
 * same bug class as the "bare-specifier incident" from phase 1,
 * RAPORT-FAZA-1.md) on the first attempt.
 *
 * Returns ONLY `content` entries — `undecided` will go to the review screen
 * only in step 9 (semantic blocks); for now we only show what
 * `packages/core` has already recognized as unambiguous content.
 */
export async function extractImagesForReview(data: ArrayBuffer, opts: { signal?: AbortSignal } = {}): Promise<ExtractedImagePreview[]> {
  const { extractImagesFromDocument } = await import('@bindery/core');
  const result = await extractImagesFromDocument(data, { assetBaseUrl: ASSET_BASE_URL, signal: opts.signal });

  return result.images
    .filter((img) => img.classification === 'content')
    .map((img) => ({
      objId: img.entry.objId,
      page: img.entry.occurrences[0]?.page ?? 0,
      classification: img.classification,
      targetKind: img.targetKind,
      width: img.width,
      height: img.height,
      format: img.payload.format,
      bytes: img.payload.bytes,
      previewUrl: bytesToBlobUrl(img.payload.bytes, img.payload.format),
    }));
}

/** Preview of the journal hierarchy BEFORE saving (A5: a human always reviews) — name + page count, without the full HTML content. */
export interface JournalPreview {
  name: string;
  pageCount: number;
}

export interface CIFBuildResult {
  preview: { journals: JournalPreview[]; imageCount: number };
  document: import('@bindery/core').CIFDocument;
  imageBytesById: Map<string, { bytes: Uint8Array; format: string }>;
}

/** SHA-256 in hex — the standard Web Crypto API (not Foundry's), for `CIFDocument.source.fileHash`. */
async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Phase 8 orchestration (Step 9 Z3/Z4/Z5) over a real document in the
 * browser — the same architectural pattern as `extractImagesForReview`:
 * all the pdf.js opening lives in `@bindery/core` (`buildCIFFromDocument`),
 * NOT here (`check:imports`, see the comment near `extractImagesForReview`).
 */
export async function buildJournalsForReview(
  data: ArrayBuffer,
  fileName: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<CIFBuildResult> {
  const { buildCIFFromDocument } = await import('@bindery/core');
  const fileHash = await hashArrayBuffer(data);
  const result = await buildCIFFromDocument(data, { assetBaseUrl: ASSET_BASE_URL, fileName, fileHash, signal: opts.signal, onProgress: opts.onProgress });
  return {
    preview: {
      journals: result.document.journals.map((j) => ({ name: j.name, pageCount: j.pages.length })),
      imageCount: result.document.images.length,
    },
    document: result.document,
    imageBytesById: result.imageBytesById,
  };
}

/**
 * [Step 11 Z3] Opens a document handle EXCLUSIVELY for previewing pages in
 * the review screen — see `openPreviewDocument` in `@bindery/core`. The
 * caller (`ReviewScreen`) is responsible for calling `destroy()` when the
 * screen closes.
 */
export async function openPreviewForReview(data: ArrayBuffer): Promise<import('@bindery/core').PreviewDocument> {
  const { openPreviewDocument } = await import('@bindery/core');
  return openPreviewDocument(data, { assetBaseUrl: ASSET_BASE_URL });
}
