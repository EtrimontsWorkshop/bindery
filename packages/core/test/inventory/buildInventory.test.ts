import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory, type PdfDocumentLike } from '../../src/inventory/inventory.js';

import { build as buildImagesDecorated } from '../synth/fixtures/images-decorated.js';
import { build as buildImagesLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildImagesBleedBackground } from '../synth/fixtures/images-bleed-background.js';
import { build as buildImagesOverlapping } from '../synth/fixtures/images-overlapping.js';
import { build as buildImagesMaskOpcode } from '../synth/fixtures/images-mask-opcode.js';
import { build as buildImagesMaskGeometry } from '../synth/fixtures/images-mask-geometry.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';
import { build as buildFontsNoSuffix } from '../synth/fixtures/fonts-no-suffix.js';
import { build as buildFontsSubsetPrefix } from '../synth/fixtures/fonts-subset-prefix.js';

/** pdfjs-dist's PDFDocumentProxy is structurally compatible with PdfDocumentLike. */
async function openFixture(buf: Buffer): Promise<PdfDocumentLike> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLike;
}

describe('buildInventory — images-decorated (pageRefs)', () => {
  it('ozdobnik wspoldzielony przez 3 strony NIE dostaje stabilnego objId na kazdej stronie (odkrycie pdf.js)', async () => {
    const doc = await openFixture(buildImagesDecorated());
    const inv = await buildInventory(doc);
    expect(inv.pageCount).toBe(3);

    // ODKRYCIE empiryczne (KROK-4): pdf.js NIE przydziela temu samemu zasobowi PDF
    // stabilnego objId od pierwszego wystapienia. Pierwsze uzycie (strona 1) dostaje
    // lokalny id typu "img_p0_1"; dopiero po powtornym uzyciu pdf.js "awansuje" zasob
    // do wspoldzielonego id typu "g_d0_..." — to id JEST stabilne na kolejnych
    // stronach (2 i 3), ale rozni sie od pierwszego wystapienia. Skutek: ten sam
    // obraz PDF rozpada sie na DWA ImageEntry z perspektywy jednoprzebiegowej
    // inwentaryzacji bez dekodowania pikseli (poza zakresem KROK-4, patrz A8/R-13) —
    // scalenie wymagaloby fingerprintu tresci, odlozone do fazy 3.
    const withTwoPages = inv.images.filter((img) => img.pageRefs.length === 2);
    expect(withTwoPages).toHaveLength(1); // ozdobnik po "awansie" pdf.js (strony 2+3)

    const withOnePage = inv.images.filter((img) => img.pageRefs.length === 1);
    // 54 unikalne obrazy x 3 strony = 162, + pierwsze (nie-awansowane) wystapienie ozdobnika na stronie 1
    expect(withOnePage.length).toBe(163);

    // [KROK-5 Z6.2] Korelacja pozycyjna po skwantowanym bboksie ZAMYKA ten dokladnie
    // przypadek: ozdobnik ma identyczny bbox na kazdym uzyciu (nieruchomy element
    // szablonu strony), wiec oba rozdzielone wpisy powinny zostac powiazane.
    const twoPageEntry = withTwoPages[0]!;
    const decorFirstUse = withOnePage.find((img) => img.correlatedWith === twoPageEntry.objId);
    expect(decorFirstUse).toBeDefined();
    expect(decorFirstUse!.occurrences[0]!.bbox).toEqual(twoPageEntry.occurrences[0]!.bbox);
  });
});

describe('buildInventory — images-luminosity-mask (sciezka group)', () => {
  it('maska ma isMaskLayer=true, maskEvidence="group"', async () => {
    const doc = await openFixture(buildImagesLuminosityMask());
    const inv = await buildInventory(doc);
    const masked = inv.images.filter((img) => img.maskEvidence === 'group');
    expect(masked).toHaveLength(1);
    expect(masked[0]!.isMaskLayer).toBe(true);
  });
});

describe('buildInventory — images-mask-opcode (sciezka opcode)', () => {
  it('maska paintImageMaskXObject ma isMaskLayer=true, maskEvidence="opcode"', async () => {
    const doc = await openFixture(buildImagesMaskOpcode());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(2);

    // pdf.js przydziela wlasne id obiektow (np. "mask_p0_1"/"img_p0_2"), niezalezne
    // od nazw kluczy slownika /XObject uzytych w strumieniu tresci — nie zakladamy
    // konkretnych stringow, tylko rozrozniamy po maskEvidence (KROK-4).
    const maskEntry = inv.images.find((img) => img.maskEvidence === 'opcode');
    expect(maskEntry?.isMaskLayer).toBe(true);

    const contentEntry = inv.images.find((img) => img.maskEvidence === null);
    expect(contentEntry?.isMaskLayer).toBe(false);
  });
});

describe('buildInventory — images-mask-geometry (sciezka geometry, przypadek pozytywny)', () => {
  it('Over1 dostaje maskEvidence="geometry" (bbox identyczny z Under1, index diff=2); Control1 bez dowodu', async () => {
    const doc = await openFixture(buildImagesMaskGeometry());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(3);

    const geometryMatches = inv.images.filter((img) => img.maskEvidence === 'geometry');
    expect(geometryMatches).toHaveLength(1);
    expect(geometryMatches[0]!.isMaskLayer).toBe(false); // geometry to slaby dowod — nie ustawia isMaskLayer

    const withoutEvidence = inv.images.filter((img) => img.maskEvidence === null);
    expect(withoutEvidence).toHaveLength(2); // Under1 i Control1
  });
});

describe('buildInventory — images-bleed-background (bbox nieprzyciety)', () => {
  it('bbox z ujemnymi wspolrzednymi zachowany bez przyciecia do MediaBox', async () => {
    const doc = await openFixture(buildImagesBleedBackground());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(1);
    const bbox = inv.images[0]!.occurrences[0]!.bbox;
    expect(bbox.minX).toBeLessThan(0);
    expect(bbox.minY).toBeLessThan(0);
    expect(bbox.maxX).toBeGreaterThan(612); // szersze niz MediaBox
    expect(bbox.maxY).toBeGreaterThan(792);
  });
});

describe('buildInventory — images-overlapping (klastrowanie)', () => {
  it('5 nakladajacych sie obrazow w jednym clusterId, szosty osobno; brak falszywych trafien geometry', async () => {
    const doc = await openFixture(buildImagesOverlapping());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(6);

    const clusterCounts = new Map<string, number>();
    for (const img of inv.images) {
      if (!img.clusterId) continue;
      clusterCounts.set(img.clusterId, (clusterCounts.get(img.clusterId) ?? 0) + 1);
    }
    const sizes = [...clusterCounts.values()].sort((a, b) => b - a);
    // Fixture: baza + 4 ikony nakladajace sie na niej (bezposrednio potwierdzone
    // empirycznie po naprawie bledu CTM w walkOperators — geometria pokazuje ze
    // WSZYSTKIE 4 ikony (nie 3) naprawde naklada sie na baze), + 1 ikonka calkowicie
    // osobno (bez nakladania).
    expect(sizes[0]).toBe(5); // baza + 4 ikony nakladajace
    expect(sizes[1]).toBe(1); // odosobniony ikonka nr 6

    // Zaden z tych obrazow nie powinien dostac geometry-mask-evidence tylko z
    // powodu nakladania sie bboxow — geometry wymaga TAKZE bliskosci `index`
    // (<=3) I >=95% pokrycia, obrazy tej fixture sa rysowane w duzych odstepach.
    const falsePositives = inv.images.filter((img) => img.maskEvidence === 'geometry');
    expect(falsePositives).toHaveLength(0);
  });
});

describe('buildInventory — vectors-rectangle (constructPath przez prawdziwy pdf.js, KROK-5 Z7)', () => {
  it('fill i fillStroke (B) daja poprawne VectorRegion, w tym DWA eventy dla fillStroke', async () => {
    const doc = await openFixture(buildVectorsRectangle());
    const inv = await buildInventory(doc);
    expect(inv.vectors).toHaveLength(3); // 1x fill + (1x fill + 1x stroke dla fillStroke/B)

    const fillOnly = inv.vectors.find((v) => v.bbox.minX === 100);
    expect(fillOnly?.kind).toBe('fill');
    expect(fillOnly?.bbox).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 150 });

    const fillStrokePair = inv.vectors.filter((v) => v.bbox.minX === 350);
    expect(fillStrokePair.map((v) => v.kind).sort()).toEqual(['fill', 'stroke']);
    expect(fillStrokePair[0]!.bbox).toEqual({ minX: 350, minY: 400, maxX: 430, maxY: 480 });
  });
});

describe('buildInventory — fonty (fonts-no-suffix, fonts-subset-prefix)', () => {
  it('fonts-no-suffix: 3 klucze fontow, kazdy z przypisana rola, niezalenie od braku sufiksow', async () => {
    const doc = await openFixture(buildFontsNoSuffix());
    const inv = await buildInventory(doc);
    expect(inv.fonts.length).toBeGreaterThanOrEqual(3);
    for (const font of inv.fonts) {
      expect(inv.fontRoles.get(font.key)).toBeDefined();
    }
    const bodyCount = [...inv.fontRoles.values()].filter((r) => r === 'body').length;
    expect(bodyCount).toBe(1); // dokladnie jeden font "body" (najwiekszy udzial)
  });

  it('fonts-subset-prefix: prefiks AAAAAH+ zdjety z key/baseFont, zachowany w subsetPrefix', async () => {
    const doc = await openFixture(buildFontsSubsetPrefix());
    const inv = await buildInventory(doc);
    const withPrefix = inv.fonts.filter((f) => f.subsetPrefix !== null);
    expect(withPrefix.length).toBeGreaterThan(0);
    for (const f of withPrefix) {
      expect(f.key).not.toMatch(/^[A-Z]{6}\+/);
      expect(f.baseFont).not.toMatch(/^[A-Z]{6}\+/);
      expect(f.subsetPrefix).toMatch(/^[A-Z]{6}$/);
    }
  });
});

describe('buildInventory — AbortSignal', () => {
  it('przerywa przetwarzanie w polowie dokumentu (3 strony)', async () => {
    const doc = await openFixture(buildImagesDecorated());
    const controller = new AbortController();
    let pagesSeen = 0;
    await expect(
      buildInventory(doc, {
        signal: controller.signal,
        onProgress: (done) => {
          pagesSeen = done;
          if (done === 1) controller.abort();
        },
      }),
    ).rejects.toThrow(/AbortSignal/);
    expect(pagesSeen).toBeLessThan(3);
  });
});

describe('buildInventory — determinizm', () => {
  it('dwa uruchomienia na tym samym pliku daja identyczny wynik (po serializacji)', async () => {
    function serialize(inv: Awaited<ReturnType<typeof buildInventory>>) {
      return JSON.stringify(inv, (_key, value) => (value instanceof Set ? [...value].sort() : value), 2);
    }
    const buf = buildImagesOverlapping();
    const inv1 = await buildInventory(await openFixture(buf));
    const inv2 = await buildInventory(await openFixture(buf));
    expect(serialize(inv1)).toBe(serialize(inv2));
  });
});
