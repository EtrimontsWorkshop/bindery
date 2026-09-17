import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Region-render abstraction (Step 7 Z3, MDD phase 3 "Pass 2" fallback). The
 * same pattern as `normalizeDecodedImage` — one interface, two
 * implementations (browser: `OffscreenCanvas`, here; Node/tests:
 * `@napi-rs/canvas`, in `nodeCanvasRenderer.ts`, DELIBERATELY NOT EXPORTED
 * from `index.ts` — see the comment on that file for why).
 */

export interface RenderRegionOptions {
  /** Target length of the result's LONGER edge in pixels. */
  targetLongEdgePx: number;
  signal?: AbortSignal;
}

/**
 * Subset of `PDFPageProxy` actually used here — lets the render logic be
 * tested without a real pdf.js document (the same pattern as `PdfPageLike`
 * in `buildTextLayout.ts`).
 */
export interface PdfPageForRender {
  getViewport(params: { scale: number }): { transform: readonly number[] };
  render(params: { canvasContext: unknown; viewport: unknown; transform?: readonly number[] }): {
    promise: Promise<unknown>;
    cancel(): void;
  };
}

export interface RegionRenderer {
  renderRegion(page: PdfPageForRender, bbox: Rect, opts: RenderRegionOptions): Promise<DecodedImage>;
}

/**
 * Hard upper limit on the result's edge length (brief: "e.g. 4096 px") —
 * guards against producing a ~200 MB file from a spread with a very large
 * `targetLongEdgePx` or a very wide bbox. 4096px is a typical
 * texture/canvas limit for many browsers and GPUs — a safe ceiling, not an
 * attempt at the "highest possible" resolution.
 */
export const MAX_OUTPUT_EDGE_PX = 4096;

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Region render aborted (AbortSignal)', 'AbortError');
}

/**
 * [fix for a reported bug, "rotated crop on a page with page.rotate != 0
 * cuts out the wrong pixels"] Exported so `renderRotatedRegion.ts` can
 * convert ANY PDF point into pixels of THAT SAME bitmap using the same
 * formula as the render — instead of its own, naive scale+Y-flip formula,
 * which was correct ONLY for `page.rotate === 0` (pdf.js
 * `getViewport({scale})` defaults to `rotation: page.rotate`, so the
 * transform MAY include a rotation, not just scale+flip).
 */
export function transformPoint(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}

/** Bbox in device space (after the viewport transform) of the four corners of a bbox in PDF page space. */
function deviceBBoxFromPageSpace(viewportTransform: readonly number[], bbox: Rect): Rect {
  const localCorners: Array<[number, number]> = [
    [bbox.minX, bbox.minY],
    [bbox.maxX, bbox.minY],
    [bbox.minX, bbox.maxY],
    [bbox.maxX, bbox.maxY],
  ];
  const corners = localCorners.map(([x, y]) => transformPoint(viewportTransform, x, y));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export interface RenderPlan {
  /** Scale to pass to `page.getViewport({ scale })`. */
  scale: number;
  /** Target canvas width/height in pixels (>=1, <= MAX_OUTPUT_EDGE_PX). */
  outWidth: number;
  outHeight: number;
  /** Offset [dx,dy] so that the bbox's top-left corner (at scale `scale`) lands at (0,0) of the canvas. */
  offsetX: number;
  offsetY: number;
}

/**
 * Computes the render plan (scale + canvas dimensions + offset)
 * independently of the environment — a pure function, testable without a
 * real pdf.js document. Scales so that the bbox's LONGER edge (in device
 * space at scale 1) reaches `targetLongEdgePx`, then clamps to
 * `MAX_OUTPUT_EDGE_PX` when needed.
 */
export function computeRenderPlan(getViewportTransform: (scale: number) => readonly number[], bbox: Rect, targetLongEdgePx: number): RenderPlan {
  const transformAtScale1 = getViewportTransform(1);
  const deviceBBoxAtScale1 = deviceBBoxFromPageSpace(transformAtScale1, bbox);
  const widthAtScale1 = deviceBBoxAtScale1.maxX - deviceBBoxAtScale1.minX;
  const heightAtScale1 = deviceBBoxAtScale1.maxY - deviceBBoxAtScale1.minY;
  const longEdgeAtScale1 = Math.max(widthAtScale1, heightAtScale1);
  if (!(longEdgeAtScale1 > 0)) {
    throw new Error('computeRenderPlan: bbox has zero or negative area in device space');
  }

  const rawScale = targetLongEdgePx / longEdgeAtScale1;
  const rawOutWidth = widthAtScale1 * rawScale;
  const rawOutHeight = heightAtScale1 * rawScale;
  const clampRatio = Math.min(1, MAX_OUTPUT_EDGE_PX / Math.max(rawOutWidth, rawOutHeight));
  const scale = rawScale * clampRatio;

  const transformAtScale = getViewportTransform(scale);
  const deviceBBox = deviceBBoxFromPageSpace(transformAtScale, bbox);
  const outWidth = Math.max(1, Math.round(deviceBBox.maxX - deviceBBox.minX));
  const outHeight = Math.max(1, Math.round(deviceBBox.maxY - deviceBBox.minY));

  return { scale, outWidth, outHeight, offsetX: deviceBBox.minX, offsetY: deviceBBox.minY };
}

/** Minimal subset of CanvasRenderingContext2D used to pull out pixels after the render — shared by both implementations. */
export interface CanvasContextLike {
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
}

/**
 * Shared render logic — both implementations (browser/Node) differ ONLY in
 * how they create the canvas/context, the rest (the render plan, AbortSignal
 * handling, calling `page.render()`) is identical.
 */
export async function renderRegionShared(
  page: PdfPageForRender,
  bbox: Rect,
  opts: RenderRegionOptions,
  createContext: (width: number, height: number) => CanvasContextLike,
): Promise<DecodedImage> {
  checkAborted(opts.signal);
  const plan = computeRenderPlan((scale) => page.getViewport({ scale }).transform, bbox, opts.targetLongEdgePx);

  const ctx = createContext(plan.outWidth, plan.outHeight);
  const viewport = page.getViewport({ scale: plan.scale });
  const renderTransform: readonly number[] = [1, 0, 0, 1, -plan.offsetX, -plan.offsetY];
  const task = page.render({ canvasContext: ctx, viewport, transform: renderTransform });

  if (opts.signal) {
    const onAbort = (): void => task.cancel();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
  } else {
    await task.promise;
  }
  checkAborted(opts.signal);

  const imageData = ctx.getImageData(0, 0, plan.outWidth, plan.outHeight);
  return { width: plan.outWidth, height: plan.outHeight, rgba: imageData.data };
}

/**
 * Browser implementation (`OffscreenCanvas` — a web-platform standard, not a
 * Foundry API, see the A1 rationale in `normalizeDecodedImage.ts`).
 */
export const browserRegionRenderer: RegionRenderer = {
  renderRegion(page, bbox, opts) {
    const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
      | (new (
          w: number,
          h: number,
        ) => { getContext(id: '2d'): (CanvasContextLike & { [key: string]: unknown }) | null })
      | undefined;
    if (!OffscreenCanvasCtor) {
      throw new Error('browserRegionRenderer: OffscreenCanvas is not available in this environment (probably Node) — use nodeCanvasRenderer in tests.');
    }
    return renderRegionShared(page, bbox, opts, (w, h) => {
      const canvas = new OffscreenCanvasCtor(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('browserRegionRenderer: failed to create a 2D context for OffscreenCanvas');
      return ctx;
    });
  },
};
