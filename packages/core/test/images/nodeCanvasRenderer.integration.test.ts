import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { build as buildLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';

/**
 * An integration test of the REAL pdf.js (not mocks) — verifies that `PdfPageForRender` (an
 * interface inferred from the pdf.js types) really fits the real `PDFPageProxy.getViewport()`/
 * `render()`, and that a region render yields sensible, non-empty pixels in the right place. Uses
 * `nodeCanvasRenderer.ts` DIRECTLY from the sources (not through `@bindery/core`) — see the
 * comment in that file for why it is deliberately not exported.
 */
describe('nodeCanvasRegionRenderer — an integration with a real pdf.js', () => {
  it('renders a region around an image, the result has the expected dimensions and is not completely transparent/empty', async () => {
    const buf = buildLuminosityMask();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);

    // The fixture draws a 100x100 image (page space) at cm(100,0,0,100,50,600) — see images-luminosity-mask.ts.
    const bbox = { minX: 50, minY: 600, maxX: 150, maxY: 700 };
    const result = await nodeCanvasRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: 200 });

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
    expect(result.rgba.length).toBe(200 * 200 * 4);

    // The source image is a flat red (200,30,30) — at least some of the pixels should reflect that
    // (a luminosity mask may darken it, but shouldn't give a completely black/transparent result).
    let anyNonBlack = false;
    for (let i = 0; i < result.rgba.length; i += 4) {
      if (result.rgba[i]! > 10 || result.rgba[i + 1]! > 10 || result.rgba[i + 2]! > 10) {
        anyNonBlack = true;
        break;
      }
    }
    expect(anyNonBlack).toBe(true);

    page.cleanup();
  });

  it('renders a region of pure vector graphics (no image) without an error — the fallback path for drawn maps', async () => {
    const buf = buildVectorsRectangle();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const bbox = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    const result = await nodeCanvasRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: 100 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    page.cleanup();
  });

  it('an AbortSignal already aborted before the call rejects immediately', async () => {
    const buf = buildLuminosityMask();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      nodeCanvasRegionRenderer.renderRegion(page as never, { minX: 50, minY: 600, maxX: 150, maxY: 700 }, { targetLongEdgePx: 200, signal: controller.signal }),
    ).rejects.toThrow();
    page.cleanup();
  });
});
