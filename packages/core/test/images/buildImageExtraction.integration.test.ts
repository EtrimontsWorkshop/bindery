import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildImageExtraction, type PdfDocumentLikeForImages } from '../../src/images/buildImageExtraction.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import { build as buildImagesLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildImagesOverlapping } from '../synth/fixtures/images-overlapping.js';
import { build as buildExtractDecorated3pages } from '../synth/fixtures/extract-decorated-3pages.js';

async function openDoc(buf: Buffer): Promise<PdfDocumentLikeForImages> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLikeForImages;
}

async function run(buf: Buffer) {
  const invDoc = await openDoc(buf);
  const inv = await buildInventory(invDoc as never);
  const doc = await openDoc(buf);
  return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 256 });
}

/**
 * Testy integracyjne orkiestratora na fixture'ach GRUPY A/KROK-4 (nie zbudowanych
 * z myslą o kroku 7) — celowo ograniczone do tego, co te fixture'y faktycznie
 * uzasadniaja: maska (region-render zamiast surowego zasobu bez maski) i klaster
 * (jeden wynik, nie N). Scenariusze wymagajace konkretnych progow klasyfikacji
 * (content jednoznacznie, region czysto wektorowy pokrywajacy strone, ozdobnik
 * na wielu stronach obok prawdziwej tresci) maja WLASNE, celowo zbudowane
 * fixture'y w Z7 (`test/synth/fixtures/extract-*.ts`) — patrz
 * `buildImageExtraction.groupD.test.ts`.
 */
describe('buildImageExtraction — integracja pelnego potoku (Z1-Z6) na prawdziwych fixturach', () => {
  it('obraz maskowany (maly, ponizej progu duzej powierzchni) idzie przez region-render, nie surowa ekstrakcje bez maski', async () => {
    const result = await run(buildImagesLuminosityMask());
    // Forma samej maski ('mask') jest wykluczona z wyniku; zostaje tylko zasob maskowany.
    expect(result.images).toHaveLength(1);
    const maskedContent = result.images[0]!;
    expect(maskedContent.classification).not.toBe('mask');
    expect(maskedContent.extractSource).toBe('region-render');
    expect(maskedContent.width).toBeGreaterThan(0);
  }, 30000);

  it('klaster nakladajacych sie obrazow (baza + 4 ikony na niej) daje JEDEN wpis; obraz calkowicie osobny daje DRUGI', async () => {
    const result = await run(buildImagesOverlapping());
    // 6 obrazow: 5 wzajemnie nakladajacych sie (klaster) + 1 calkowicie osobny (bez nakladania).
    expect(result.images).toHaveLength(2);
    const clustered = result.images.find((img) => img.extractSource === 'region-render');
    expect(clustered).toBeDefined();
  }, 30000);

  it('determinizm: dwa przebiegi na tym samym pliku daja identyczne metadane i hashe (nie porownujemy surowych pikseli renderu, tylko hash tresci)', async () => {
    const buf = buildImagesLuminosityMask();
    const r1 = await run(buf);
    const r2 = await run(buf);
    const strip = (r: Awaited<ReturnType<typeof run>>) =>
      r.images
        .map((img) => ({
          objId: img.entry.objId,
          classification: img.classification,
          contentHash: img.contentHash,
          width: img.width,
          height: img.height,
          targetKind: img.targetKind,
        }))
        .sort((a, b) => (a.objId ?? '').localeCompare(b.objId ?? ''));
    expect(JSON.stringify(strip(r1))).toBe(JSON.stringify(strip(r2)));
    expect(r1.correlationClosedByBBox).toBe(r2.correlationClosedByBBox);
    expect(r1.correlationClosedByHash).toBe(r2.correlationClosedByHash);
  }, 30000);

  it('AbortSignal przerywa W POLOWIE — po pierwszej jednostce z trzech, nie tylko gdy juz przerwany na starcie', async () => {
    // `extract-decorated-3pages` ma 3 strony, KAZDA z wlasna jednostka do ekstrakcji
    // (osobny obraz tresci per strona, patrz Z7) — wystarczajaco, zeby odroznic
    // "przerwane na starcie" (test nizej) od "przerwane W TRAKCIE petli po jednostkach".
    const buf = buildExtractDecorated3pages();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    const doc = await openDoc(buf);
    const controller = new AbortController();
    let progressCalls = 0;
    await expect(
      buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 256,
        signal: controller.signal,
        onProgress: (done) => {
          progressCalls++;
          if (done === 1) controller.abort(); // przerwij PO pierwszej jednostce, PRZED druga
        },
      }),
    ).rejects.toThrow();
    // Dowod, ze przerwanie faktycznie nastapilo W POLOWIE (co najmniej jedna jednostka
    // zdazyla sie przetworzyc PRZED zgloszeniem AbortError), nie na samym starcie.
    expect(progressCalls).toBeGreaterThanOrEqual(1);
    expect(progressCalls).toBeLessThan(3);
  }, 30000);

  it('AbortSignal juz przerwany przerywa cala ekstrakcje natychmiast, nawet gdy nie ma jednostek do przetworzenia', async () => {
    const invDoc = await openDoc(buildImagesLuminosityMask());
    const inv = await buildInventory(invDoc as never);
    const doc = await openDoc(buildImagesLuminosityMask());
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 256, signal: controller.signal }),
    ).rejects.toThrow();
  }, 30000);
});
