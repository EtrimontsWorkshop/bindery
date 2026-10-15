import type { Rect } from '../geometry.js';
import type { Diagnostic } from '../text/types.js';
import { maskRectangularity } from './maskShape.js';
import type { RawLook } from './blankSheet.js';
import { opaqueBounds, type FractionalBounds } from './opaqueBounds.js';
import { normalizeDecodedImage, type DecodedImage } from './normalizeDecodedImage.js';
import type { PdfPageForRender, RegionRenderer, RenderRegionOptions } from './regionRenderer.js';

/**
 * Direct extraction. A three-stage path in
 * a fixed order: `page.objs` -> `page.commonObjs` -> region-render fallback. Every result goes through `normalizeDecodedImage()`. Failed
 * decoding -> a `Diagnostic` (warning), NEVER a silent skip (U6 — JPX
 * without `wasmUrl` silently returns `undefined`, doesn't throw).
 *
 * The `objId` of resources that pdf.js decides upfront
 * are "shared across pages" (e.g. a decoration from the same PDF object in
 * the Resources of several pages) carries a `"g_"` prefix (e.g.
 * `"g_d0_img_p1_1"`) — pdf.js ITSELF distinguishes them this way (`pdf.mjs`:
 * `data.startsWith("g_") ? commonObjs.get(data) : objs.get(data)`). Measured
 * empirically: RIGHT AFTER a single page's `getOperatorList()`,
 * `commonObjs` is COMPLETELY EMPTY for such a resource — the promise of
 * "promotion" hasn't been fulfilled yet (it needs
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
 * `page.commonObjs`), and if that fails — renders `bbox` as a fallback.
 * Always returns a result (the render fallback doesn't fail for lack of an
 * object — it works even for purely vector graphics, `objId=null`).
 *
 * Between the first attempt and
 * finally giving up in favor of a region render there is one MORE attempt,
 * AFTER a warmup render — observed directly on a large document (250+
 * pages): for ordinary (non-`g_`) `objId` values,
 * which normally should resolve via `page.objs` right after
 * `getOperatorList()`, `has()` sometimes returns `false` on both paths —
 * pdf.js only "promises" a resource's promotion to the registry AFTER a
 * full page render (`page.render()`), not after the operator list alone
 * (see the comment at the top of the file, the same non-determinism already
 * documented for `g_` resources earlier — here
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
 * Probes the NATIVE (source) length of image `objId`'s longer
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
export async function probeIntrinsicSizePx(page: PdfPageForExtract, objId: string): Promise<{ width: number; height: number } | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      return { width: image.width, height: image.height };
    } catch {
      continue; // probing is "best-effort" — failed decoding here is not an error, see the function comment.
    }
  }
  return null;
}

/** The longer edge of {@link probeIntrinsicSizePx}. */
export async function probeIntrinsicLongEdgePx(page: PdfPageForExtract, objId: string): Promise<number | null> {
  const size = await probeIntrinsicSizePx(page, objId);
  return size ? Math.max(size.width, size.height) : null;
}

/**
 * Mean brightness (0..1) of resource `objId`, read the way a luminosity mask is read: a white pixel lets
 * the masked picture through, a black one hides it. `null` when the resource is not available (the same
 * "best-effort" rules as {@link probeIntrinsicSizePx}). Pixels are sampled on a grid of at most ~250k
 * points — enough for a share that is compared with a threshold.
 */
export async function probeMeanBrightnessFraction(page: PdfPageForExtract, objId: string): Promise<number | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / 250_000)));
      let sum = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += stride) {
        for (let x = 0; x < image.width; x += stride) {
          const i = (y * image.width + x) * 4;
          sum += (image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!) / 3;
          count++;
        }
      }
      return count > 0 ? sum / count / 255 : null;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * How completely the white area of mask resource `objId` fills its smallest enclosing rectangle (see
 * `maskRectangularity`). `null` when the resource is not available (the same "best-effort" rules as
 * {@link probeIntrinsicSizePx}).
 */
export async function probeMaskRectangularity(page: PdfPageForExtract, objId: string): Promise<number | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      return maskRectangularity(normalizeDecodedImage(raw));
    } catch {
      continue;
    }
  }
  return null;
}

/** The part of a pdf.js operator list that {@link currentObjIdAt} reads. */
export interface OperatorListLike {
  fnArray?: ArrayLike<number>;
  argsArray?: ArrayLike<unknown>;
}

const OP_PAINT_IMAGE_MASK_XOBJECT = 83;
const OP_PAINT_IMAGE_XOBJECT = 85;
const OP_PAINT_IMAGE_XOBJECT_REPEAT = 88;

/**
 * The id under which pdf.js registered the image painted by operator `index` in THIS document.
 *
 * Object ids are not stable between two opens of the same file: a resource used on several pages gets a
 * shared (`g_...`) id only once pdf.js has seen it a second time, and which page counts as the second
 * depends on which pages were visited before. The inventory walks every page; extraction opens a fresh
 * document and visits only the pages that hold units, so an id taken from the inventory can name
 * another resource there (a mask strip instead of a photo) or none at all. The operator index of a
 * painted image is the same in both documents, and the operator list says what its id is here. Falls back
 * to `fallback` when the operator is not an image paint or the list is missing.
 */
export function currentObjIdAt(operatorList: unknown, index: number | undefined, fallback: string | null): string | null {
  if (index === undefined) return fallback;
  const list = operatorList as OperatorListLike | null | undefined;
  const fn = list?.fnArray?.[index];
  const args = list?.argsArray?.[index] as unknown[] | undefined;
  if (!Array.isArray(args)) return fallback;
  let id: unknown = null;
  if (fn === OP_PAINT_IMAGE_XOBJECT || fn === OP_PAINT_IMAGE_XOBJECT_REPEAT) id = args[0];
  else if (fn === OP_PAINT_IMAGE_MASK_XOBJECT) id = (args[0] as { data?: unknown } | undefined)?.data;
  return typeof id === 'string' && id.length > 0 ? id : fallback;
}

/**
 * Waits until every id in `objIds` is present in `page.objs` or `page.commonObjs`, or until `timeoutMs` has
 * passed; returns the time spent. In a browser the worker hands decoded resources over asynchronously:
 * right after `getOperatorList()` many of them (measured: about a quarter of all images, most of the mask
 * resources) are not registered yet, and all of them are within a few milliseconds. Reading them early
 * looks like "this resource does not exist".
 */
export async function waitForObjects(page: PdfPageForExtract, objIds: readonly string[], timeoutMs: number, stepMs = 10): Promise<number> {
  const started = Date.now();
  const missing = (): boolean => objIds.some((id) => !page.objs.has(id) && !page.commonObjs.has(id));
  while (timeoutMs > 0 && missing() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return Date.now() - started;
}

/** What {@link probeOpaquePixelStats} measures. */
export interface OpaquePixelStats {
  /** The share (0-1) of pixels whose alpha is above 16. */
  opaqueFraction: number;
  /** Mean brightness (0-255) of the pixels counted as opaque; 0 when there are none. */
  meanOpaqueBrightness: number;
}

/**
 * How much of resource `objId` is not transparent and how bright that part is, or `null` when the resource is not
 * available (same best-effort rules as {@link probeIntrinsicSizePx}). A cut-out figure on a transparent ground has a
 * low opaque share; a sheet of paper or a photo has 1; a faded paper vignette has a low share of bright pixels.
 * Pixels are sampled on a grid of at most ~250k points.
 */
export async function probeOpaquePixelStats(page: PdfPageForExtract, objId: string): Promise<OpaquePixelStats | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / 250_000)));
      let opaque = 0;
      let count = 0;
      let brightness = 0;
      for (let y = 0; y < image.height; y += stride) {
        for (let x = 0; x < image.width; x += stride) {
          const i = (y * image.width + x) * 4;
          if (image.rgba[i + 3]! > 16) {
            opaque++;
            brightness += (image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!) / 3;
          }
          count++;
        }
      }
      return count > 0 ? { opaqueFraction: opaque / count, meanOpaqueBrightness: opaque > 0 ? brightness / opaque : 0 } : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** The share of opaque pixels of resource `objId`, or `null` — see {@link probeOpaquePixelStats}. */
export async function probeOpaqueFraction(page: PdfPageForExtract, objId: string): Promise<number | null> {
  return (await probeOpaquePixelStats(page, objId))?.opaqueFraction ?? null;
}

/** The bounds (image fractions) of the visible part of resource `objId`, or `null` — see {@link opaqueBounds} and {@link probeOpaquePixelStats}. */
export async function probeOpaqueBounds(page: PdfPageForExtract, objId: string): Promise<FractionalBounds | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      return opaqueBounds(normalizeDecodedImage(raw));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Luminance, its spread and saturation over the visible pixels of resource `objId` (sampled on a grid of at most
 * ~250k points), or `null` when the resource is not available or nothing is visible.
 */
export async function probeRawLook(page: PdfPageForExtract, objId: string): Promise<RawLook | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / 250_000)));
      let n = 0;
      let sum = 0;
      let sumSq = 0;
      let sat = 0;
      for (let y = 0; y < image.height; y += stride) {
        for (let x = 0; x < image.width; x += stride) {
          const i = (y * image.width + x) * 4;
          if (image.rgba[i + 3]! <= 16) continue;
          const r = image.rgba[i]!;
          const g = image.rgba[i + 1]!;
          const b = image.rgba[i + 2]!;
          const lum = 0.3 * r + 0.59 * g + 0.11 * b;
          n++;
          sum += lum;
          sumSq += lum * lum;
          sat += Math.max(r, g, b) - Math.min(r, g, b);
        }
      }
      if (n === 0) return null;
      const mean = sum / n;
      return { meanLuminance: mean, luminanceStdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), meanSaturation: sat / n };
    } catch {
      continue;
    }
  }
  return null;
}
