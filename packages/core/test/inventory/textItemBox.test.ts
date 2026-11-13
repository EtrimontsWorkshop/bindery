import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_OPEN_OPTIONS } from '../../src/pdfDocument.js';
import { describe, expect, it } from 'vitest';
import { buildInventory, textItemBox, type PdfDocumentLike } from '../../src/inventory/inventory.js';
import { build as buildTemplateSlot, TEXT_LINE } from '../synth/fixtures/images-template-slot.js';
import { build as buildLayout2col } from '../synth/fixtures/layout-2col.js';

describe('textItemBox', () => {
  it('spans the item along its baseline, from below it to the font height above it', () => {
    // 10pt text at (100, 500), 40pt wide.
    expect(textItemBox([10, 0, 0, 10, 100, 500], 40, 10)).toEqual({ minX: 100, minY: 497.5, maxX: 140, maxY: 507.5 });
  });

  it('turns with rotated text', () => {
    // Text running upwards (rotated 90°): the width goes up the page, the height to the left.
    const box = textItemBox([0, 10, -10, 0, 100, 500], 40, 10)!;
    expect(box.minX).toBeCloseTo(92.5);
    expect(box.maxX).toBeCloseTo(102.5);
    expect(box.minY).toBeCloseTo(500);
    expect(box.maxY).toBeCloseTo(540);
  });

  it('gives no box for an item without size', () => {
    expect(textItemBox([10, 0, 0, 10, 0, 0], 0, 10)).toBeNull();
  });
});

describe('buildInventory — wordBoxesByPage', () => {
  const inventoryOf = async (pdf: Buffer) => buildInventory((await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(pdf) }).promise) as unknown as PdfDocumentLike);

  it('keeps no words for a page without images', async () => {
    const inv = await inventoryOf(buildLayout2col());
    expect(inv.wordBoxesByPage.size).toBe(0);
  });

  it('keeps the box of the text of a page with images, where the text is drawn', async () => {
    const inv = await inventoryOf(buildTemplateSlot());
    const boxes = inv.wordBoxesByPage.get(1) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    const minX = Math.min(...boxes.map((b) => b.minX));
    const minY = Math.min(...boxes.map((b) => b.minY));
    const maxY = Math.max(...boxes.map((b) => b.maxY));
    expect(minX).toBeCloseTo(TEXT_LINE.x, 0);
    expect(minY).toBeLessThan(TEXT_LINE.y);
    expect(maxY).toBeGreaterThan(TEXT_LINE.y + TEXT_LINE.size / 2);
    expect(maxY).toBeLessThanOrEqual(TEXT_LINE.y + TEXT_LINE.size);
    // Upright text, with its length.
    expect(boxes.every((b) => Math.abs(b.angle) < 0.01)).toBe(true);
    expect(boxes.reduce((sum, b) => sum + b.chars, 0)).toBe(TEXT_LINE.text.length);
  });
});
