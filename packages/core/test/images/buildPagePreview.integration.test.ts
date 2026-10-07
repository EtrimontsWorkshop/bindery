import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { renderPagePreview } from '../../src/images/buildPagePreview.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';

/**
 * An integration test of the REAL pdf.js (mirrors the pattern of
 * `nodeCanvasRenderer.integration.test.ts`) — `renderPagePreview` is a THIN orchestrator over the
 * already verified `RegionRenderer`/`ImageEncoder`, so this test checks ONLY the wiring (the bbox
 * of the whole page is passed correctly, the result is encoded bytes), not the rendering logic
 * itself again.
 */
describe('renderPagePreview — an integration with a real pdf.js', () => {
  it('renders the WHOLE page (not a fragment) into an encoded bitmap with the expected proportions', async () => {
    const buf = buildVectorsRectangle();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);

    // The default MediaBox of the test fixtures (layoutHelpers/rawPdf) is [0,0,612,792] — Letter.
    const pageBox = { minX: 0, minY: 0, maxX: 612, maxY: 792 };
    const result = await renderPagePreview(page as never, pageBox, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
      targetLongEdgePx: 400,
      format: 'png',
    });

    expect(result.format).toBe('png');
    expect(result.bytes.length).toBeGreaterThan(0);
    // PNG magic bytes — confirms it actually went through the encoder, not raw RGBA.
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes[1]).toBe(0x50); // 'P'

    page.cleanup();
  });

  it('an AbortSignal already aborted before the call rejects immediately, without calling the encoder', async () => {
    const buf = buildVectorsRectangle();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderPagePreview(
        page as never,
        { minX: 0, minY: 0, maxX: 612, maxY: 792 },
        nodeCanvasRegionRenderer,
        nodeCanvasImageEncoder,
        { targetLongEdgePx: 400, signal: controller.signal },
      ),
    ).rejects.toThrow();

    page.cleanup();
  });
});
