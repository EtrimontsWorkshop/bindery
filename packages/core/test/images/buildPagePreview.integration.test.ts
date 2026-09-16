import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { renderPagePreview } from '../../src/images/buildPagePreview.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';

/**
 * [KROK-11 Z3] Test integracyjny PRAWDZIWEGO pdf.js (mirror wzorca
 * `nodeCanvasRenderer.integration.test.ts`) — `renderPagePreview` to CIENKI
 * orkiestrator nad juz zweryfikowanym `RegionRenderer`/`ImageEncoder`, wiec
 * ten test sprawdza WYLACZNIE spiecie (bbox calej strony trafia poprawnie,
 * wynik jest zakodowanymi bajtami), nie ponownie logike renderu samego w sobie.
 */
describe('renderPagePreview — integracja z prawdziwym pdf.js', () => {
  it('renderuje CALA strone (nie fragment) do zakodowanej bitmapy o oczekiwanych proporcjach', async () => {
    const buf = buildVectorsRectangle();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);

    // Domyslny MediaBox testowych fixture'ow (layoutHelpers/rawPdf) to [0,0,612,792] — Letter.
    const pageBox = { minX: 0, minY: 0, maxX: 612, maxY: 792 };
    const result = await renderPagePreview(page as never, pageBox, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
      targetLongEdgePx: 400,
      format: 'png',
    });

    expect(result.format).toBe('png');
    expect(result.bytes.length).toBeGreaterThan(0);
    // PNG magic bytes — potwierdza, ze faktycznie przeszlo przez enkoder, nie surowe RGBA.
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes[1]).toBe(0x50); // 'P'

    page.cleanup();
  });

  it('AbortSignal juz przerwany przed wywolaniem odrzuca natychmiast, bez wywolania enkodera', async () => {
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
