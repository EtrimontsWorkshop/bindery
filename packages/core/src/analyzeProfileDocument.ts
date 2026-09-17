import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildInventory } from './inventory/inventory.js';
import { classifyPageRoute } from './profiles/pageRoute.js';
import { analyzeProfilePage, aggregateDocumentAnalysis, type DocumentAnalysis, type PageAnalysis } from './profiles/studioAnalysis.js';
import { tokenizePage, type TextContentItemLike } from './profiles/tokenizePage.js';
import type { ProfileToken } from './profiles/types.js';
import type { ProfileV2 } from './profiles/schema.js';

/**
 * [Step 22 Z1/Z4] Entry point for Profile Studio — analogous to
 * `buildCIFFromDocument.ts`/`inspectDocument.ts`: pdf.js is opened ONLY
 * here (`check:imports`, the same architectural reason as everywhere else
 * in this directory's files — `pdfjs-dist` is external in ALL Vite
 * configurations). `packages/module` (`ProfileStudio.ts`) does NOT compute
 * anything on its own — it only handles the window and rendering (Step 22
 * DoD, `check:boundary`).
 */

export interface AnalyzeProfileDocumentOptions {
  assetBaseUrl: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

export async function analyzeProfileDocument(data: ArrayBuffer, profile: ProfileV2, opts: AnalyzeProfileDocumentOptions): Promise<DocumentAnalysis> {
  const invDoc = await openDocument(data, opts.assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);

  const textDoc = await openDocument(data, opts.assetBaseUrl);
  const pages: PageAnalysis[] = [];
  for (let pageNumber = 1; pageNumber <= textDoc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('analyzeProfileDocument aborted by AbortSignal', 'AbortError');

    const page = await textDoc.getPage(pageNumber);
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const tokens = tokenizePage(tc.items as TextContentItemLike[], page, inv.fontRoles, pageNumber);
    page.cleanup();

    const route = classifyPageRoute(tokens);
    pages.push(analyzeProfilePage(tokens, profile, pageNumber, route));
    opts.onProgress?.(pageNumber, textDoc.numPages);
  }

  return aggregateDocumentAnalysis(pages);
}

export interface GetFontRoleAwareTokensOptions {
  assetBaseUrl: string;
}

/**
 * [Step 34 Z2, bug measured live] `getPageTextTokens.ts` (Step 23 Z6)
 * DELIBERATELY does not compute `fontRole` (requires `buildInventory`,
 * expensive on every click) — that was sufficient for Step 23 Z6 (clicking
 * "paste text into field", labels/headings are matched by LITERAL text).
 * `proseBlock` (Notes, this step) and Step 33 Z4 (descriptions below
 * attacks) DO require `fontRole === 'accent'`, however, to recognize
 * sub-headings — without the real font role (computed from the WHOLE
 * document, NOT a single page — role is a frequency/size ranking PER
 * DOCUMENT, see `inventory.ts`) both functions silently fail despite
 * correct data, measured directly: Profile Studio "Notes" on `Wrak.pdf`
 * returned "no match" for Sciapod, even though the EXACT SAME profile+page
 * via `analyzeProfileDocument` (full run) and the Node verification script
 * found the note correctly.
 *
 * Pays the SAME cost as a full run (`buildInventory` over the entire
 * document), but returns tokens ONLY for a single requested page — to be
 * used from an EXPLICIT author action (clicking "Point to example"/"Refresh
 * preview" in the Notes tab), NOT for drawing clickable rectangles on every
 * transition between pages (there `getPageTextTokens` is still sufficient).
 */
export async function getFontRoleAwareTokensForPage(data: ArrayBuffer, pageNumber: number, opts: GetFontRoleAwareTokensOptions): Promise<ProfileToken[]> {
  const invDoc = await openDocument(data, opts.assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);

  const textDoc = await openDocument(data, opts.assetBaseUrl);
  const page = await textDoc.getPage(pageNumber);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const tokens = tokenizePage(tc.items as TextContentItemLike[], page, inv.fontRoles, pageNumber);
  page.cleanup();
  return tokens;
}
