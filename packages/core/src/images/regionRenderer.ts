import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Abstrakcja renderu regionu (KROK-7 Z3, MDD faza 3 "Przebieg 2" fallback).
 * Ten sam wzorzec co `normalizeDecodedImage` — jeden interfejs, dwie implementacje
 * (przegladarka: `OffscreenCanvas`, tutaj; Node/testy: `@napi-rs/canvas`, w
 * `nodeCanvasRenderer.ts`, CELOWO NIEEKSPORTOWANY z `index.ts` — patrz komentarz
 * przy tamtym pliku, dlaczego).
 */

export interface RenderRegionOptions {
  /** Docelowa dlugosc DLUZSZEJ krawedzi wyniku w pikselach. */
  targetLongEdgePx: number;
  signal?: AbortSignal;
}

/**
 * Podzbior `PDFPageProxy` faktycznie uzywany tutaj — pozwala testowac logike
 * renderu bez prawdziwego dokumentu pdf.js (ten sam wzorzec co `PdfPageLike`
 * w `buildTextLayout.ts`).
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
 * Twardy gorny limit dlugosci krawedzi wyniku (brief: "np. 4096 px") — chroni
 * przed wyprodukowaniem pliku rzedu 200 MB z rozkladowki przy bardzo duzym
 * `targetLongEdgePx` lub bardzo szerokim bboksie. 4096px to typowy limit
 * tekstury/canvasu wielu przegladarek i kart graficznych — bezpieczny sufit,
 * nie proba "najwyzszej mozliwej" rozdzielczosci.
 */
export const MAX_OUTPUT_EDGE_PX = 4096;

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Renderowanie regionu przerwane (AbortSignal)', 'AbortError');
}

/**
 * [naprawa zgloszonego bledu, "rotated crop na stronie z page.rotate != 0
 * wycina zle piksele"] Eksportowana, zeby `renderRotatedRegion.ts` mogl
 * przeliczac DOWOLNY punkt PDF na piksele TEJ SAMEJ bitmapy tym samym
 * wzorem co render — zamiast wlasnej, naiwnej formuly skalowania+odbicia Y,
 * ktora byla poprawna WYLACZNIE dla `page.rotate === 0` (pdf.js
 * `getViewport({scale})` domyslnie zaklada `rotation: page.rotate`, wiec
 * transformacja MOZE zawierac obrot, nie tylko skale+odbicie).
 */
export function transformPoint(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}

/** Bbox w przestrzeni urzadzenia (po transformacji viewportu) czterech rogow bboksa w przestrzeni strony PDF. */
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
  /** Skala do przekazania do `page.getViewport({ scale })`. */
  scale: number;
  /** Docelowa szerokosc/wysokosc canvasu w pikselach (>=1, <= MAX_OUTPUT_EDGE_PX). */
  outWidth: number;
  outHeight: number;
  /** Przesuniecie [dx,dy] tak, zeby lewy-gorny rog bboksa (w skali `scale`) wypadl w (0,0) canvasu. */
  offsetX: number;
  offsetY: number;
}

/**
 * Liczy plan renderu (skala + wymiary canvasu + przesuniecie) niezaleznie od
 * srodowiska — czysta funkcja, testowalna bez prawdziwego pdf.js. Skaluje tak,
 * zeby DLUZSZA krawedz bboksa (w przestrzeni urzadzenia przy skali 1) osiagnela
 * `targetLongEdgePx`, po czym przycina do `MAX_OUTPUT_EDGE_PX` gdy trzeba.
 */
export function computeRenderPlan(getViewportTransform: (scale: number) => readonly number[], bbox: Rect, targetLongEdgePx: number): RenderPlan {
  const transformAtScale1 = getViewportTransform(1);
  const deviceBBoxAtScale1 = deviceBBoxFromPageSpace(transformAtScale1, bbox);
  const widthAtScale1 = deviceBBoxAtScale1.maxX - deviceBBoxAtScale1.minX;
  const heightAtScale1 = deviceBBoxAtScale1.maxY - deviceBBoxAtScale1.minY;
  const longEdgeAtScale1 = Math.max(widthAtScale1, heightAtScale1);
  if (!(longEdgeAtScale1 > 0)) {
    throw new Error('computeRenderPlan: bbox ma zerowa lub ujemna powierzchnie w przestrzeni urzadzenia');
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

/** Minimalny podzbior CanvasRenderingContext2D uzywany do wyciagniecia pikseli po renderze — wspoldzielony przez obie implementacje. */
export interface CanvasContextLike {
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
}

/**
 * Wspolna logika renderu — obie implementacje (przegladarka/Node) roznia sie
 * WYLACZNIE sposobem tworzenia canvasu/kontekstu, reszta (plan renderu,
 * obsluga AbortSignal, wywolanie `page.render()`) jest identyczna.
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
 * Implementacja przegladarkowa (`OffscreenCanvas` — standard platformy webowej,
 * nie API Foundry, patrz uzasadnienie A1 w `normalizeDecodedImage.ts`).
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
      throw new Error('browserRegionRenderer: OffscreenCanvas niedostepny w tym srodowisku (prawdopodobnie Node) — uzyj nodeCanvasRenderer w testach.');
    }
    return renderRegionShared(page, bbox, opts, (w, h) => {
      const canvas = new OffscreenCanvasCtor(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('browserRegionRenderer: nie udalo sie utworzyc kontekstu 2D dla OffscreenCanvas');
      return ctx;
    });
  },
};
