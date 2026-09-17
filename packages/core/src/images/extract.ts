import type { Rect } from '../geometry.js';
import type { Diagnostic } from '../text/types.js';
import { normalizeDecodedImage, type DecodedImage } from './normalizeDecodedImage.js';
import type { PdfPageForRender, RegionRenderer, RenderRegionOptions } from './regionRenderer.js';

/**
 * Direct extraction (Step 7 Z4, MDD phase 3 "Pass 2"). A three-stage path in
 * a fixed order: `page.objs` -> `page.commonObjs` -> region-render fallback
 * (Z3). Every result goes through `normalizeDecodedImage()` (U2). Failed
 * decoding -> a `Diagnostic` (warning), NEVER a silent skip (U6 — JPX
 * without `wasmUrl` silently returns `undefined`, doesn't throw).
 *
 * [Step 7, discovery] The `objId` of resources that pdf.js decides upfront
 * are "shared across pages" (e.g. a decoration from the same PDF object in
 * the Resources of several pages) carries a `"g_"` prefix (e.g.
 * `"g_d0_img_p1_1"`) — pdf.js ITSELF distinguishes them this way (`pdf.mjs`:
 * `data.startsWith("g_") ? commonObjs.get(data) : objs.get(data)`). Measured
 * empirically: RIGHT AFTER a single page's `getOperatorList()`,
 * `commonObjs` is COMPLETELY EMPTY for such a resource — the promise of
 * "promotion" (see U1/RAPORT-KROK-4.md) hasn't been fulfilled yet (it needs
 * further processing — other pages and/or a render). For such resources,
 * BOTH paths (`objs`/`commonObjs`) legitimately fail at this stage, and the
 * code correctly falls back to a region render — THIS IS NOT A BUG, it's
 * expected behavior documented here so a future reader of the calibration
 * data (a high share of `region-render` strategy for multi-page resources)
 * doesn't go looking for a nonexistent bug.
 */

/**
 * Subset of `PDFObjects` (pdf.js `page.objs`/`page.commonObjs`) actually
 * used here. [U3] `get(objId, callback)` with a callback is the ONLY safe
 * variant — without a callback and without prior resolution it throws
 * `"Requesting object that isn't resolved yet"`. More IMPORTANTLY,
 * empirically verified directly in the source (`PDFObjects.get` in
 * pdf.mjs): calling `get(objId, callback)` for an objId that will NEVER
 * resolve INSERTS an empty placeholder and WAITS FOREVER — `callback` will
 * never be called. That's why `has(objId)` MUST be checked BEFORE calling
 * `get` with a callback; without this, any attempt at an object that isn't
 * in this registry (because it's in the other one) hangs the whole
 * extraction indefinitely.
 */
export interface PdfObjectsLike {
  has(objId: string): boolean;
  get(objId: string, callback: (data: unknown) => void): void;
}

export interface PdfPageForExtract extends PdfPageForRender {
  objs: PdfObjectsLike;
  commonObjs: PdfObjectsLike;
  /** MUST be called BEFORE attempting `objs.get()`/`commonObjs.get()` — populates both registries (see the comment on `PdfObjectsLike`). */
  getOperatorList(): Promise<unknown>;
}

export type ExtractSource = 'objs' | 'commonObjs' | 'region-render';

export interface ExtractDirectResult {
  image: DecodedImage;
  source: ExtractSource;
  diagnostics: Diagnostic[];
}

/** `null` when `objId` is not (yet) present in this registry — the caller tries the next path, NEVER waits on `get()` without this check (see the comment at the top of the file). */
function resolveIfReady(objs: PdfObjectsLike, objId: string): Promise<unknown> | null {
  if (!objs.has(objId)) return null;
  return new Promise((resolve) => objs.get(objId, resolve));
}

interface ResolveAttemptResult {
  /** Success (pixels ready) OR `null` — and if `null`, `attempted` tells
   * apart "we tried, decoding failed" (a retry after warmup is pointless —
   * the same bytes give the same result) from "neither registry had it yet"
   * (a retry after warmup DOES make sense — `has()` may have changed after
   * `page.render()`). */
  resolved: { image: DecodedImage; source: ExtractSource } | null;
  attempted: boolean;
}

/** One attempt going through `objs` -> `commonObjs` for `objId`. */
async function tryResolveFromRegistries(page: PdfPageForExtract, objId: string, pageNumber: number, diagnostics: Diagnostic[]): Promise<ResolveAttemptResult> {
  const sources: readonly [ExtractSource, PdfObjectsLike][] = [
    ['objs', page.objs],
    ['commonObjs', page.commonObjs],
  ];
  let attempted = false;
  for (const [source, objs] of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    attempted = true;
    try {
      const raw = await pending;
      if (raw == null) {
        // [U6] Decoding silently returned nothing (typical for JPX with no configured wasmUrl) — reported, NEVER skipped without a trace.
        diagnostics.push({
          severity: 'warning',
          code: 'IMAGE_DECODE_EMPTY',
          params: { objId, source },
          pageNumber,
        });
        continue;
      }
      return { resolved: { image: normalizeDecodedImage(raw), source }, attempted };
    } catch (err) {
      diagnostics.push({
        severity: 'warning',
        code: 'IMAGE_DECODE_FAILED',
        params: { objId, source, error: err instanceof Error ? err.message : String(err) },
        pageNumber,
      });
    }
  }
  return { resolved: null, attempted };
}

/**
 * Attempts to extract image `objId` directly (via `page.objs` or
 * `page.commonObjs`), and if that fails — renders `bbox` as a fallback (Z3).
 * Always returns a result (the render fallback doesn't fail for lack of an
 * object — it works even for purely vector graphics, `objId=null`).
 *
 * [Step 16 Z2, fix for a live-reported bug] Between the first attempt and
 * finally giving up in favor of a region render there is one MORE attempt,
 * AFTER a warmup render — observed directly on a large document (250+
 * pages, `Cienie_posrod_mgie.pdf`): for ordinary (non-`g_`) `objId` values,
 * which normally should resolve via `page.objs` right after
 * `getOperatorList()`, `has()` sometimes returns `false` on both paths —
 * pdf.js only "promises" a resource's promotion to the registry AFTER a
 * full page render (`page.render()`), not after the operator list alone
 * (see the comment at the top of the file, the same non-determinism already
 * documented for `g_` resources back in phase 0/MDD risk R-13 — here
 * revealed to also apply to ordinary `objId` values on sufficiently large
 * documents). Before this fact was known, the code immediately fell back to
 * rendering the REGION (a page fragment) as the final result — which WORKS
 * (correct bbox), but renders the page's COMPOSITED content (the image +
 * whatever else is there, e.g. an adjacent paragraph of text), NOT isolated
 * pixels of just the image resource. A region render still has to happen as
 * the fallback anyway (same cost, not extra) — used HERE FIRST as a
 * "warmup" (forces `page.render()`, and thus promotion), with a RETRY of
 * `objs`/`commonObjs` AFTER it — BUT ONLY when the first attempt had
 * NOTHING AT ALL to try (`has()` false on both registries — "it might show
 * up after the render"). If the first attempt DID try something and
 * decoding failed (`IMAGE_DECODE_EMPTY`/`IMAGE_DECODE_FAILED`), retrying is
 * pointless — the same bytes after the same render will give the same
 * error, a retry would only duplicate the diagnostics. When it succeeds —
 * we return the resource's clean pixels instead of a composited page
 * snapshot. When it still doesn't succeed — we use the PIXELS ALREADY
 * RENDERED during the warmup as the final result (zero extra render,
 * identical cost to before this change).
 */
export async function extractDirect(
  page: PdfPageForExtract,
  objId: string | null,
  bbox: Rect,
  renderer: RegionRenderer,
  renderOpts: RenderRegionOptions,
  pageNumber: number,
): Promise<ExtractDirectResult> {
  const diagnostics: Diagnostic[] = [];

  let firstAttempted = false;
  if (objId !== null) {
    const first = await tryResolveFromRegistries(page, objId, pageNumber, diagnostics);
    if (first.resolved) return { ...first.resolved, diagnostics };
    firstAttempted = first.attempted;
  }

  const renderedImage = await renderer.renderRegion(page, bbox, renderOpts);

  if (objId !== null && !firstAttempted) {
    const afterWarmup = await tryResolveFromRegistries(page, objId, pageNumber, diagnostics);
    if (afterWarmup.resolved) return { ...afterWarmup.resolved, diagnostics };
  }

  return { image: renderedImage, source: 'region-render', diagnostics };
}

/**
 * [Step 8 Z3] Probes the NATIVE (source) length of image `objId`'s longer
 * edge in pixels, without deciding on an extraction strategy — used by the
 * orchestrator to determine the target resolution of a region render (see
 * `renderResolution.ts`), NOT for extraction itself. The same `objs` ->
 * `commonObjs` path as `extractDirect` (U3: `has()` before `get()` with a
 * callback), but NEVER falls back to a region render — no result (null)
 * simply means "native resolution unknown", not an error; the caller then
 * uses plain minimums/defaults from settings. `page.objs`/`commonObjs`
 * CACHE already-resolved objects (see `PDFObjects.resolve` in pdf.mjs), so
 * this is NOT extra decoding cost beyond what pdf.js already performed while
 * building this page's operator list — just reading already-ready
 * dimensions.
 */
export async function probeIntrinsicLongEdgePx(page: PdfPageForExtract, objId: string): Promise<number | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      return Math.max(image.width, image.height);
    } catch {
      continue; // probing is "best-effort" — failed decoding here is not an error, see the function comment.
    }
  }
  return null;
}
