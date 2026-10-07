import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { rectsOverlap } from '../../src/geometry.js';
import { fixtures } from '../synth/index.js';

/**
 * The bbox of EVERY occurrence of an image/vector region MUST intersect the MediaBox of the page
 * it was registered on — otherwise something in `walkOperators`/`imageRegistry`/`vectorRegistry`
 * assigned the occurrence to the WRONG page (a bbox entirely outside its `MediaBox`). This is not
 * a new mechanism — it VERIFIES an invariant that should hold by construction (the CTM/`page.box`
 * from `inventory.ts` are always processed in the context of the RIGHT page). The
 * `extract-bleed`/`images-bleed-background` fixture DELIBERATELY extends BEYOND the `MediaBox` on
 * every edge, but still INTERSECTS it (overlaps partially) — that is the distinguishing case from
 * "entirely outside the page".
 */
describe('the bbox of an image/vector intersects the MediaBox of its own page', () => {
  const imageAndVectorFixtures = fixtures.filter(
    (f) => f.id.startsWith('images-') || f.id.startsWith('extract-') || f.id.startsWith('vectors-'),
  );

  it(`sprawdzono ${imageAndVectorFixtures.length} fixture'ow grup A/D`, () => {
    expect(imageAndVectorFixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of imageAndVectorFixtures) {
    it(`${fixture.id}: every occurrence of an image and a vector region intersects the MediaBox`, async () => {
      const buf = fixture.build();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      const inv = await buildInventory(doc as never);
      const pageBoxByPage = new Map(inv.perPage.map((p) => [p.pageNumber, p.box]));

      for (const entry of inv.images) {
        for (const occ of entry.occurrences) {
          const pageBox = pageBoxByPage.get(occ.page);
          expect(pageBox, `page ${occ.page} (objId=${entry.objId}) is missing from perPage`).toBeDefined();
          expect(rectsOverlap(occ.bbox, pageBox!), `objId=${entry.objId} on p. ${occ.page}: the bbox ${JSON.stringify(occ.bbox)} doesn't intersect the MediaBox ${JSON.stringify(pageBox)}`).toBe(
            true,
          );
        }
      }

      for (const region of inv.vectors) {
        const pageBox = pageBoxByPage.get(region.page);
        expect(pageBox, `page ${region.page} is missing from perPage`).toBeDefined();
        expect(rectsOverlap(region.bbox, pageBox!), `a vector region on p. ${region.page}: the bbox ${JSON.stringify(region.bbox)} doesn't intersect the MediaBox`).toBe(true);
      }
    });
  }
});
