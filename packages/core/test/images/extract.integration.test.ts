import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_OPEN_OPTIONS } from '../../src/pdfDocument.js';
import { describe, expect, it } from 'vitest';
import { extractDirect, waitForDependencies } from '../../src/images/extract.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { build as buildImagesDecorated } from '../synth/fixtures/images-decorated.js';

/**
 * An integration test on a REAL pdf.js — verifies that `PdfObjectsLike`/`has()`-before-`get()`
 * (inferred from reading the `PDFObjects` source in pdf.mjs, see the comment in extract.ts)
 * actually works on a real `page.objs`, not only on mocks. Uses a real `objId` from a real
 * inventory, not an invented identifier.
 */
describe('extractDirect — an integration with a real pdf.js (page.objs)', () => {
  it('extracts a real image through page.objs, source="objs", without falling back to a render', async () => {
    const buf = buildImagesDecorated();

    const invDoc = (await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buf) }).promise) as never;
    const inv = await buildInventory(invDoc);
    // An entry UNIQUE per page — an ordinary per-page image resolves through page.objs right after
    // getOperatorList().
    const imageEntry = inv.images.find((e) => e.objId !== null && e.pageRefs.length === 1);
    expect(imageEntry).toBeDefined();

    const doc = await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buf) }).promise;
    const pageNumber = imageEntry!.occurrences[0]!.page;
    const page = await doc.getPage(pageNumber);
    await page.getOperatorList(); // fills page.objs, as in the real pipeline (buildTextLayout does the same before getTextContent)

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

  it('registers every resource of the operator list once its dependencies have arrived, whatever the timing', async () => {
    const buf = buildImagesDecorated();
    const doc = await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buf) }).promise;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const operatorList = await page.getOperatorList();
      expect(await waitForDependencies(page as never, operatorList, 10_000)).toBe(true);
      const dependencies = operatorList.fnArray.flatMap((fn, i) => (fn === pdfjs.OPS.dependency ? (operatorList.argsArray[i] as string[]) : []));
      expect(dependencies.length).toBeGreaterThan(0);
      for (const id of dependencies) expect((id.startsWith('g_') ? page.commonObjs : page.objs).has(id)).toBe(true);
    }
  });
});

