import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { build as buildLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';

/**
 * Test integracyjny PRAWDZIWEGO pdf.js (nie mockow) — weryfikuje, ze
 * `PdfPageForRender` (interfejs wywnioskowany z typow pdf.js) faktycznie
 * pasuje do prawdziwego `PDFPageProxy.getViewport()`/`render()`, i ze render
 * regionu daje sensowne, nie-puste piksele we wlasciwym miejscu. Uzywa
 * `nodeCanvasRenderer.ts` BEZPOSREDNIO ze zrodel (nie przez `@bindery/core`) —
 * patrz komentarz w tamtym pliku, dlaczego jest celowo nieeksportowany.
 */
describe('nodeCanvasRegionRenderer — integracja z prawdziwym pdf.js', () => {
  it('renderuje region wokol obrazu, wynik ma oczekiwane wymiary i nie jest calkowicie przezroczysty/pusty', async () => {
    const buf = buildLuminosityMask();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);

    // Fixture rysuje obraz 100x100 (przestrzen strony) w cm(100,0,0,100,50,600) — patrz images-luminosity-mask.ts.
    const bbox = { minX: 50, minY: 600, maxX: 150, maxY: 700 };
    const result = await nodeCanvasRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: 200 });

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
    expect(result.rgba.length).toBe(200 * 200 * 4);

    // Obraz zrodlowy to jednolity czerwony (200,30,30) — przynajmniej czesc pikseli powinna to odzwierciedlac
    // (maska luminancyjna moze przyciemnic, ale nie powinna dac calkowicie czarnego/przezroczystego wyniku).
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

  it('renderuje region z czystej grafiki wektorowej (brak obrazu) bez bledu — sciezka fallback dla map rysowanych', async () => {
    const buf = buildVectorsRectangle();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await doc.getPage(1);
    const bbox = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    const result = await nodeCanvasRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: 100 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    page.cleanup();
  });

  it('AbortSignal juz przerwany przed wywolaniem odrzuca natychmiast', async () => {
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
