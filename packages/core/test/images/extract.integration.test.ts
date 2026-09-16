import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { extractDirect } from '../../src/images/extract.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { build as buildImagesDecorated } from '../synth/fixtures/images-decorated.js';

/**
 * Test integracyjny na PRAWDZIWYM pdf.js — weryfikuje `PdfObjectsLike`/`has()`-
 * przed-`get()` (wywnioskowane z lektury zrodla `PDFObjects` w pdf.mjs, patrz
 * komentarz w extract.ts) faktycznie dziala na prawdziwym `page.objs`, nie
 * tylko na mockach. Uzywa prawdziwego `objId` z prawdziwej inwentaryzacji
 * (krok 4), nie zmyslonego identyfikatora.
 */
describe('extractDirect — integracja z prawdziwym pdf.js (page.objs)', () => {
  it('wyciaga prawdziwy obraz przez page.objs, zrodlo="objs", bez uciekania sie do renderu', async () => {
    const buf = buildImagesDecorated();

    const invDoc = (await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise) as never;
    const inv = await buildInventory(invDoc);
    // Wpis UNIKALNY per strona (nie wspoldzielona dekoracja, ktorej objId pdf.js
    // oznacza prefiksem "g_" i przenosi do commonObjs LENIWIE — dopiero po
    // renderze/przetworzeniu innych stron, patrz odkrycie w RAPORT-KROK-7.md) —
    // zwykly obraz per-strone resolwuje sie przez page.objs od razu po getOperatorList().
    const imageEntry = inv.images.find((e) => e.objId !== null && e.pageRefs.length === 1);
    expect(imageEntry).toBeDefined();

    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const pageNumber = imageEntry!.occurrences[0]!.page;
    const page = await doc.getPage(pageNumber);
    await page.getOperatorList(); // wypelnia page.objs, jak w prawdziwym potoku (krok 5/buildTextLayout robi to samo przed getTextContent)

    const result = await extractDirect(
      page as never,
      imageEntry!.objId,
      imageEntry!.occurrences[0]!.bbox,
      nodeCanvasRegionRenderer,
      { targetLongEdgePx: 256 },
      pageNumber,
    );

    expect(result.source).toBe('objs');
    expect(result.diagnostics).toHaveLength(0);
    expect(result.image.width).toBeGreaterThan(0);
    expect(result.image.height).toBeGreaterThan(0);

    page.cleanup();
  });
});
