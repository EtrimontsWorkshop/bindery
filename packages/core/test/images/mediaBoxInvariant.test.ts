import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { rectsOverlap } from '../../src/geometry.js';
import { fixtures } from '../synth/index.js';

/**
 * DoD kroku 7, §11.3: bbox KAZDEGO wystapienia obrazu/regionu wektorowego MUSI
 * przecinac MediaBox strony, na ktorej zostal zarejestrowany — inaczej cos w
 * `walkOperators`/`imageRegistry`/`vectorRegistry` przypisalo wystapienie do
 * ZLEJ strony (bbox calkowicie poza jej `MediaBox`). Nie jest to nowy mechanizm
 * (brief zabrania budowania czegos pod U5-podobne luki) — to WERYFIKACJA
 * niezmiennika, ktory powinien trzymac sie z konstrukcji (CTM/`page.box` z
 * `inventory.ts` sa zawsze przetwarzane w kontekscie WLASCIWEJ strony). Fixture
 * `extract-bleed`/`images-bleed-background` CELOWO wychodzi POZA `MediaBox` na
 * kazdej krawedzi, ale wciaz go PRZECINA (naklada sie czesciowo) — to
 * odrozniajacy przypadek od "calkowicie poza strona".
 */
describe('DoD §11.3 — bbox obrazu/wektora przecina MediaBox wlasnej strony', () => {
  const imageAndVectorFixtures = fixtures.filter(
    (f) => f.id.startsWith('images-') || f.id.startsWith('extract-') || f.id.startsWith('vectors-'),
  );

  it(`sprawdzono ${imageAndVectorFixtures.length} fixture'ow grup A/D`, () => {
    expect(imageAndVectorFixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of imageAndVectorFixtures) {
    it(`${fixture.id}: kazde wystapienie obrazu i regionu wektorowego przecina MediaBox`, async () => {
      const buf = fixture.build();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      const inv = await buildInventory(doc as never);
      const pageBoxByPage = new Map(inv.perPage.map((p) => [p.pageNumber, p.box]));

      for (const entry of inv.images) {
        for (const occ of entry.occurrences) {
          const pageBox = pageBoxByPage.get(occ.page);
          expect(pageBox, `strona ${occ.page} (objId=${entry.objId}) nie istnieje w perPage`).toBeDefined();
          expect(rectsOverlap(occ.bbox, pageBox!), `objId=${entry.objId} na str. ${occ.page}: bbox ${JSON.stringify(occ.bbox)} nie przecina MediaBox ${JSON.stringify(pageBox)}`).toBe(
            true,
          );
        }
      }

      for (const region of inv.vectors) {
        const pageBox = pageBoxByPage.get(region.page);
        expect(pageBox, `strona ${region.page} nie istnieje w perPage`).toBeDefined();
        expect(rectsOverlap(region.bbox, pageBox!), `region wektorowy na str. ${region.page}: bbox ${JSON.stringify(region.bbox)} nie przecina MediaBox`).toBe(true);
      }
    });
  }
});
