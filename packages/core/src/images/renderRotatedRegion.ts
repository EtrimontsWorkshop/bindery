import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { rotateAndCropImage } from './rotateCrop.js';
import { computeRenderPlan, transformPoint, type PdfPageForRender, type RegionRenderer, type RenderRegionOptions } from './regionRenderer.js';

/**
 * [user report, "Select and Crop" — the ability to rotate the selected
 * area] A NON-axis-aligned rectangle, in PDF COORDINATES (Y up) — see
 * `RotatedRect` in `pageOverlayGeometry.ts` (the same data shape, but that
 * type lives in a file about SCREEN/overlay geometry, and we don't want a
 * dependency from here in the wrong direction; `packages/module` itself
 * converts screen->PDF via `screenRotatedRectToPdf` BEFORE calling this, so
 * this file receives an already-ready rectangle in PDF units).
 */
export interface RotatedPdfRegion {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
}

/**
 * Renders a rotated PDF region into a plain, "straightened" image — WITHOUT
 * modifying the pdf.js render itself (`renderer.renderRegion` below is
 * EXACTLY the same, already-proven function used for a normal, unrotated
 * "Select and Crop"). Two steps:
 *
 * 1. Compute the ENVELOPE (axis-aligned bbox) of the rotated rectangle and
 *    render IT normally — what's visible in this larger page fragment is
 *    content-wise sufficient to cut an arbitrarily rotated rectangle out of
 *    its middle.
 * 2. `rotateAndCropImage` (a pure pixel function, `rotateCrop.ts`) cuts out
 *    and "straightens" the actual rotated rectangle from this larger bitmap.
 *
 * The rotated rectangle's center/angle are converted into PIXELS of this
 * LARGER bitmap using the same technique that
 * `screenRotatedRectToPdf`/`rotateAndCropImage` already use: transform the 4
 * real corners (here: from PDF to bitmap pixels), derive center/
 * dimensions/angle from THEIR positions — zero separate, manually-inverted
 * algebra on the angle itself.
 *
 * [fix for a reported bug — a full design review] The PDF -> bitmap-pixel
 * conversion MUST use EXACTLY the same transform that
 * `renderer.renderRegion` used to produce `source` — i.e. the real pdf.js
 * matrix `page.getViewport({scale}).transform` (which itself accounts for
 * `page.rotate`, see `regionRenderer.ts`), NOT a naive scale+Y-flip computed
 * directly from `bbox`. That second formula was correct ONLY for pages with
 * `rotate === 0` (which is true for all 9 files in this project's
 * `samples/`, which is why the bug went unnoticed until now) — on a page
 * with real rotation it would give wrong coordinates with no error/warning
 * at all. `computeRenderPlan` is a PURE, deterministic function of the same
 * `bbox`/`targetLongEdgePx` the render above used, so calling it again here
 * returns EXACTLY the same `scale`/`offsetX/Y` (and `plan.outWidth/outHeight`
 * are by definition equal to `source.width/height`).
 */
export async function renderRotatedRegion(page: PdfPageForRender, region: RotatedPdfRegion, renderer: RegionRenderer, opts: RenderRegionOptions): Promise<DecodedImage> {
  const hw = region.width / 2;
  const hh = region.height / 2;
  const cos = Math.cos(region.rotationRad);
  const sin = Math.sin(region.rotationRad);
  const localCorners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const pdfCorners = localCorners.map(([lx, ly]): [number, number] => [region.centerX + lx * cos - ly * sin, region.centerY + lx * sin + ly * cos]);

  const xs = pdfCorners.map((p) => p[0]);
  const ys = pdfCorners.map((p) => p[1]);
  const bbox: Rect = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

  // Envelope render resolution scaled so that the ACTUAL (smaller) selection
  // still comes out around `opts.targetLongEdgePx` after cropping —
  // otherwise a large envelope around a narrow, heavily rotated rectangle
  // would give an unnecessarily low resolution for the selection itself.
  const bboxLongEdge = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  const regionLongEdge = Math.max(region.width, region.height);
  const bboxTargetLongEdgePx = regionLongEdge > 0 && bboxLongEdge > 0 ? opts.targetLongEdgePx * (bboxLongEdge / regionLongEdge) : opts.targetLongEdgePx;

  const source = await renderer.renderRegion(page, bbox, { targetLongEdgePx: bboxTargetLongEdgePx, signal: opts.signal });

  const plan = computeRenderPlan((scale) => page.getViewport({ scale }).transform, bbox, bboxTargetLongEdgePx);
  const viewportTransform = page.getViewport({ scale: plan.scale }).transform;
  const pixelCorners = pdfCorners.map(([x, y]): [number, number] => {
    const [deviceX, deviceY] = transformPoint(viewportTransform, x, y);
    return [deviceX - plan.offsetX, deviceY - plan.offsetY];
  });

  const centerX = pixelCorners.reduce((sum, p) => sum + p[0], 0) / 4;
  const centerY = pixelCorners.reduce((sum, p) => sum + p[1], 0) / 4;
  const [p0, p1] = pixelCorners as [[number, number], [number, number], [number, number], [number, number]];
  const rotationRad = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);

  const outScale = regionLongEdge > 0 ? opts.targetLongEdgePx / regionLongEdge : 1;
  const outputWidth = Math.max(1, Math.round(region.width * outScale));
  const outputHeight = Math.max(1, Math.round(region.height * outScale));

  return rotateAndCropImage(source, { centerX, centerY, outputWidth, outputHeight, rotationRad });
}
