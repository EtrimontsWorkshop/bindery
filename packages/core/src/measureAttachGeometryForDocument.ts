import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildInventory } from './inventory/inventory.js';
import { tokenizePage, type TextContentItemLike } from './profiles/tokenizePage.js';
import { measureAttachGeometry, type AttachGeometryMeasurement } from './profiles/measureAttachGeometry.js';
import type { LabelledPairsPattern, SectionListPattern, FontRoleCandidatePattern } from './profiles/schema.js';
import type { FontRole } from './inventory/fontRegistry.js';
import type { ProfileToken } from './profiles/types.js';

/**
 * [Step 24 Z2] Entry point for Profile Studio (geometry measurement) —
 * analogous to `analyzeProfileDocument.ts`/`getPageTextTokens.ts`: pdf.js
 * is opened ONLY here for this function (`check:imports`). Deliberately
 * WITHOUT `buildInventory` WHEN the candidate is
 * `labelledPairs`/`sectionList` — neither of them reads
 * `ProfileToken.fontRole`, so the font-role map stays empty (the cost of
 * inventory, which this measurement tool doesn't need in that case).
 *
 * [Step 29 Z3, "while we're at it"] `fontRoleCandidate` (Name) has been
 * INCLUDED in the measurement since this step — `matchFontRoleCandidate`
 * READS `fontRole` (and `fontKey` via `requireFontKeys`) as an INPUT
 * filter, so WITHOUT inventory every token would have `fontRole:
 * undefined` and the measurement would always show zero pairs, regardless
 * of the real data — a silent, misleading result instead of an error.
 * Inventory is run ONLY in this branch (a separate copy of the document,
 * the same pattern as `verify-profile-studio.ts` — `buildInventory` itself
 * walks ALL pages with the operator, it cannot be safely interleaved with
 * parallel text reading on the SAME document handle).
 *
 * Deliberately WITHOUT the pregen/`pages.include` filter from the profile
 * — the measurement is a SIGNAL for calibration, not a final decision
 * (brief: "Show the distribution, the author will review everything
 * anyway"), and pregen/out-of-scope pages simply won't produce matching
 * pairs (`grids.length === 0`), so they won't skew the measurement.
 */

export interface MeasureAttachGeometryForDocumentOptions {
  assetBaseUrl: string;
  signal?: AbortSignal;
}

export async function measureAttachGeometryForDocument(
  data: ArrayBuffer,
  anchorPattern: LabelledPairsPattern,
  candidatePattern: LabelledPairsPattern | SectionListPattern | FontRoleCandidatePattern,
  opts: MeasureAttachGeometryForDocumentOptions,
): Promise<AttachGeometryMeasurement> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;

  let fontRoles: ReadonlyMap<string, FontRole> = new Map();
  if (candidatePattern.kind === 'fontRoleCandidate') {
    const invDoc = await pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      wasmUrl: `${opts.assetBaseUrl}wasm/`,
      standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
    }).promise;
    fontRoles = (await buildInventory(invDoc, { signal: opts.signal })).fontRoles;
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const pages: { tokens: ProfileToken[] }[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('measureAttachGeometryForDocument aborted by AbortSignal', 'AbortError');
    const page = await doc.getPage(pageNumber);
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const tokens = tokenizePage(tc.items as TextContentItemLike[], page, fontRoles, pageNumber);
    page.cleanup();
    pages.push({ tokens });
  }

  return measureAttachGeometry(pages, anchorPattern, candidatePattern);
}
