import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { fontSizeFromTransform } from './layout/textGeometry.js';
import { resolveFontKey } from './inventory/fontRegistry.js';

/**
 * [Step 23 Z6] Raw text tokens for ONE page (text + bbox) — EXCLUSIVELY for
 * "click on the page to paste text into a form field" in the profile editor.
 * Deliberately does NOT compute `fontRole` (which needs `buildInventory`,
 * requiring a pass over the WHOLE document) — Z6 doesn't need the font role,
 * only the text, so we skip a cost that the rest of the profile flow
 * (`analyzeProfileDocument`) already pays for during its full pass anyway.
 * Same opening pattern as `openPreviewDocument.ts`/`inspectDocument.ts` (its
 * own copy of the bytes).
 *
 * [Step 29 Z3] `fontKey`, however, IS computed here despite the above —
 * `resolveFontKey` needs ONLY `page.commonObjs` (a SINGLE page), not the
 * whole-document `buildInventory`. Clicking a name candidate on the "Name"
 * tab (Profile Studio) learns THIS key — without it there would be nothing
 * to learn.
 *
 * [LIVE bug report, "requireFontKeys isn't saved even after clicking a real
 * name"] The previous version of this comment claimed that `page.commonObjs`
 * is "already populated by getTextContent()" (F0-Q1) — measured directly to
 * be FALSE for less common/decorative fonts (e.g. a character-name font used
 * once per page): `getTextContent()` does NOT guarantee that EVERY font
 * encountered finishes fully loading into `commonObjs` before its promise
 * resolves — `resolveFontKey` silently returns `null` for such a token
 * (`commonObjs.has(fontName)` still `false`), and clicking in the Studio
 * "works" visually (the text preview updates — `#namePreviewText`, a
 * completely independent field), but `requireFontKeys` never gets an entry.
 * The real source of truth, documented since phase 0 (see `CLAUDE.md`, "Font
 * fingerprinting works via `commonObjs.get(fontName).name` AFTER
 * `getOperatorList()`") — the same pattern the rest of the code
 * (`tokenizePage.ts`'s actual callers, `buildInventory`) already uses
 * correctly; this function was the one place that skipped it.
 */

export interface PageTextToken {
  text: string;
  bbox: Rect;
  fontKey?: string;
}

export interface GetPageTextTokensOptions {
  assetBaseUrl: string;
}

export async function getPageTextTokens(data: ArrayBuffer, pageNumber: number, opts: GetPageTextTokensOptions): Promise<PageTextToken[]> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const page = await doc.getPage(pageNumber);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const tokens: PageTextToken[] = [];
  for (const item of tc.items as { str?: string; transform?: number[]; width?: number; fontName?: string }[]) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const transform = item.transform;
    const size = transform ? fontSizeFromTransform(transform as [number, number, number, number, number, number]) : 0;
    const x = transform?.[4] ?? 0;
    const y = transform?.[5] ?? 0;
    const w = item.width ?? 0;
    const fontKey = item.fontName ? (resolveFontKey(item.fontName, page.commonObjs, size) ?? undefined) : undefined;
    tokens.push({ text: str.trim(), bbox: { minX: x, maxX: x + w, minY: y, maxY: y + (size || 10) }, fontKey });
  }
  page.cleanup();
  return tokens;
}
