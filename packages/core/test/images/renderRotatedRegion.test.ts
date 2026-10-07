import { describe, expect, it } from 'vitest';
import { renderRotatedRegion } from '../../src/images/renderRotatedRegion.js';
import { computeRenderPlan, transformPoint } from '../../src/images/regionRenderer.js';
import type { RegionRenderer, RenderRegionOptions, PdfPageForRender } from '../../src/images/regionRenderer.js';
import type { Rect } from '../../src/geometry.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * A fake page factory — `getViewport({scale})` returns `baseTransform` scaled linearly (like the
 * real pdf.js: the viewport matrix at scale S is the matrix at scale 1 multiplied by S).
 * `baseTransform` simulates WHAT `page.rotate` really does to the pdf.js matrix — for `rotate=0`
 * it is a plain scale + Y flip (`[1,0,0,-1,0,0]`), for a real page rotation it is a matrix that
 * MIXES X/Y (not just scale+flip) — EXACTLY the case that the naive, old formula in
 * `renderRotatedRegion.ts` (scale+Y flip computed DIRECTLY from the bbox, without
 * `page.getViewport`) missed entirely.
 */
function makeFakePage(baseTransform: readonly [number, number, number, number, number, number]): PdfPageForRender {
  return {
    getViewport({ scale }) {
      return { transform: baseTransform.map((v) => v * scale) };
    },
  } as PdfPageForRender;
}

/** The page matrix WITHOUT rotation (`page.rotate === 0`) — the pdf.js convention: device_x = pdf_x, device_y = -pdf_y (a Y flip about 0). Every file used in development has `page.rotate === 0`. */
const UNROTATED_PAGE = makeFakePage([1, 0, 0, -1, 0, 0]);

/**
 * The page matrix WITH A REAL ROTATION — it MIXES X/Y (not just scales and flips), the way a real
 * pdf.js matrix for a page with `/Rotate 90/180/270` actually looks. It doesn't have to be
 * BYTE-FOR-BYTE what pdf.js really returns for `rotation:90` (that depends on its internal
 * implementation) — it is enough that the test proves: `renderRotatedRegion` CORRECTLY uses the
 * WHOLE matrix from `page.getViewport`, rather than assuming scale+Y flip.
 */
const ROTATED_PAGE = makeFakePage([0, 1, -1, 0, 0, 0]);

/**
 * A fake page renderer — for ANY given bbox (PDF, Y up) it "renders" a flat, black bitmap with one
 * bright marker at the GIVEN PDF position, CORRECTLY accounting for `page.getViewport` (like the
 * real `regionRenderer.ts` — hence the reuse of `computeRenderPlan`/`transformPoint`, which are
 * `regionRenderer.ts`'s OWN, separately tested functions, not the logic of `renderRotatedRegion.ts`
 * under test). The marker is placed by applying THE SAME transformation, so the test proves that
 * `renderRotatedRegion` correctly REVERSES that mapping for any page — not only for a page
 * without rotation.
 */
function fakeRenderer(markerPdfX: number, markerPdfY: number, markerHalfSizePdf: number): RegionRenderer {
  return {
    async renderRegion(page: PdfPageForRender, bbox: Rect, opts: RenderRegionOptions): Promise<DecodedImage> {
      const plan = computeRenderPlan((scale) => page.getViewport({ scale }).transform, bbox, opts.targetLongEdgePx);
      const transform = page.getViewport({ scale: plan.scale }).transform;
      const [markerDeviceX, markerDeviceY] = transformPoint(transform, markerPdfX, markerPdfY);
      const markerPixelX = markerDeviceX - plan.offsetX;
      const markerPixelY = markerDeviceY - plan.offsetY;
      const markerHalfSizePx = markerHalfSizePdf * plan.scale;
      const rgba = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4);
      for (let oy = 0; oy < plan.outHeight; oy++) {
        for (let ox = 0; ox < plan.outWidth; ox++) {
          const idx = (oy * plan.outWidth + ox) * 4;
          rgba[idx + 3] = 255; // a black, opaque background
          if (Math.abs(ox - markerPixelX) <= markerHalfSizePx && Math.abs(oy - markerPixelY) <= markerHalfSizePx) {
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
          }
        }
      }
      return { width: plan.outWidth, height: plan.outHeight, rgba };
    },
  };
}

function findMarkerCentroid(image: DecodedImage): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (y * image.width + x) * 4;
      const brightness = image.rgba[idx]! + image.rgba[idx + 1]! + image.rgba[idx + 2]!;
      sumX += x * brightness;
      sumY += y * brightness;
      sumWeight += brightness;
    }
  }
  return { x: sumX / sumWeight, y: sumY / sumWeight };
}

describe('renderRotatedRegion', () => {
  it('rotationRad=0, a marker to the right of the region\'s center -> lands to the right of the output\'s center', () => {
    const renderer = fakeRenderer(330, 300, 5); // 30pt to the right (PDF +X) of the region's center (300,300)
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: 0 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(dx).toBeGreaterThan(10);
      expect(Math.abs(dy)).toBeLessThan(10);
    });
  });

  it('[The convention of this function, verified directly by this test] rotationRad=+90° IN PDF (Y up) — a marker to the right (PDF +X) of the center lands BELOW the output\'s center. If integration with the UI (the drag direction of the rotation handle) turns out to be reversed, the only fix is negating the angle BEFORE calling this function (in `ReviewScreen.ts`, at the screen->PDF conversion), not here.', () => {
    const renderer = fakeRenderer(330, 300, 5);
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: Math.PI / 2 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(Math.abs(dx)).toBeLessThan(10);
      expect(dy).toBeGreaterThan(10);
    });
  });

  it('the output dimensions correspond to the region\'s proportions (not the envelope\'s) and the target edge length', () => {
    const renderer = fakeRenderer(0, 0, 1);
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 200, height: 100, rotationRad: Math.PI / 4 }, renderer, { targetLongEdgePx: 400 }).then((result) => {
      expect(result.width).toBe(400);
      expect(result.height).toBe(200);
    });
  });

  it('[a fix for a reported bug] a page with a REAL rotation (the page.getViewport matrix mixes X/Y) — a marker to the right (PDF +X) of the region\'s center STILL lands to the right of the output\'s center for rotationRad=0, even though the raw PDF coordinates were "rotated" by the page itself. Before the fix (a naive scale+Y flip computed from the bbox, without page.getViewport) this test would detect wrong coordinates on every page with page.rotate != 0.', () => {
    const renderer = fakeRenderer(330, 300, 5);
    return renderRotatedRegion(ROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: 0 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(dx).toBeGreaterThan(10);
      expect(Math.abs(dy)).toBeLessThan(10);
    });
  });
});
