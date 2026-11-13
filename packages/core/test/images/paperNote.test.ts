import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDF_OPEN_OPTIONS } from '../../src/pdfDocument.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout } from '../../src/text/buildTextLayout.js';
import { buildPageLayouts } from '../../src/layout/index.js';
import { buildImageExtraction, type PdfDocumentLikeForImages } from '../../src/images/buildImageExtraction.js';
import { groupBlockBoxesByPage } from '../../src/images/textBlockBoxes.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import { build as buildPaperNote, NOTE_BOX, NOTE_TEXT } from '../synth/fixtures/extract-paper-note.js';

async function extract() {
  const buf = buildPaperNote();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const open = async (): Promise<any> => pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buf) }).promise;
  const inv = await buildInventory(await open());
  const layout = await buildTextLayout(await open(), new Map(inv.fonts.map((f) => [f.key, f.size])));
  const { blocks } = buildPageLayouts(layout, { fontRoles: inv.fontRoles, vectors: inv.vectors, images: inv.images, perPage: inv.perPage });
  return buildImageExtraction((await open()) as PdfDocumentLikeForImages, { images: inv.images, vectors: inv.vectors, shapes: inv.shapes, perPage: inv.perPage }, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
    targetLongEdgePx: 256,
    bodyBlockBoxesByPage: groupBlockBoxesByPage(blocks, new Set(['body', 'caption'])),
    textBlockBoxesByPage: groupBlockBoxesByPage(blocks),
    wordBoxesByPage: inv.wordBoxesByPage,
  });
}

describe('buildImageExtraction — a note whose text the page writes on blank paper (extract-paper-note)', () => {
  it('keeps each note as the render of its place, with its text, not as the blank paper raster', async () => {
    const result = await extract();
    const notes = result.images.filter((i) => i.holdsText === true);
    expect(notes).toHaveLength(NOTE_TEXT.length);
    const noteAspect = (NOTE_BOX.maxX - NOTE_BOX.minX) / (NOTE_BOX.maxY - NOTE_BOX.minY);
    for (const note of notes) {
      expect(note.extractSource).toBe('region-render');
      // The render of the note's place on the page, not the 150x50 paper raster.
      expect(note.width / note.height).toBeCloseTo(noteAspect, 0);
      expect(note.width).not.toBe(150);
    }
  });

  it('gives notes on the same paper but with different text different hashes, so neither is dropped as a copy of the other', async () => {
    const result = await extract();
    const hashes = new Set(result.images.filter((i) => i.holdsText === true).map((i) => i.contentHash));
    expect(hashes.size).toBe(NOTE_TEXT.length);
  });
});
