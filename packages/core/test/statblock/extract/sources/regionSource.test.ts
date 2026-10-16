import { describe, expect, it } from 'vitest';
import { extractFromRegionSource, normalizeRectToBlock } from '../../../../src/statblock/extract/sources/regionSource.js';
import type { ExtractionBlock, PageTextElement } from '../../../../src/statblock/extract/types.js';

function el(text: string, x: number, y: number, w = text.length * 6, h = 10): PageTextElement {
  return { text, x, y, w, h, fontName: 'TestFont', fontSize: 10, bold: false, italic: false };
}

describe('extractFromRegionSource', () => {
  it('selects elements whose center falls within the denormalized rect', () => {
    const block: ExtractionBlock = {
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      elements: [el('inside', 10, 10, 10, 10), el('outside', 90, 90, 10, 10)],
    };
    const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 } });
    expect(result.found).toBe(true);
    expect(result.raw).toBe('inside');
  });

  it('(0,0)-(1,1) covers the whole block bbox', () => {
    const block: ExtractionBlock = {
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      elements: [el('a', 0, 0, 10, 10), el('b', 90, 90, 10, 10)],
    };
    const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
    expect(result.matchedElements).toHaveLength(2);
  });

  it('an element whose center sits exactly on the boundary is included (inclusive bounds)', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, elements: [el('x', 45, 45, 10, 10)] };
    // center at (50,50) -- exactly the edge of a 0..0.5 rect on a 0..100 bbox.
    const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 } });
    expect(result.found).toBe(true);
  });

  describe('edge case: empty region (no elements at all)', () => {
    it('reports found:false with a diagnostic when nothing falls inside the rect', () => {
      const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, elements: [el('far away', 90, 90, 10, 10)] };
      const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 } });
      expect(result.found).toBe(false);
      expect(result.raw).toBeNull();
      expect(result.diagnostics[0]!.code).toBe('STATBLOCK_REGION_EMPTY');
    });

    it('reports found:false on a completely empty block', () => {
      const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, elements: [] };
      const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
      expect(result.found).toBe(false);
    });
  });

  it('joins multiple matched lines with newline, in reading order', () => {
    const block: ExtractionBlock = {
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      elements: [el('Top line', 0, 80, 50, 10), el('Bottom line', 0, 10, 60, 10)],
    };
    const result = extractFromRegionSource(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
    expect(result.raw).toBe('Top line\nBottom line');
  });
});

describe('normalizeRectToBlock', () => {
  const block = { minX: 100, minY: 200, maxX: 300, maxY: 600 };

  it('measures a rectangle against the block, not against the page', () => {
    expect(normalizeRectToBlock({ minX: 150, minY: 300, maxX: 250, maxY: 400 }, block)).toEqual({ minX: 0.25, minY: 0.25, maxX: 0.75, maxY: 0.5 });
  });

  it('is the inverse of what a region source reads: the same selection finds the same text in the block', () => {
    const rect = { minX: 150, minY: 300, maxX: 250, maxY: 400 };
    const normalizedRect = normalizeRectToBlock(rect, block)!;
    const elements = [el('inside', 160, 340, 40, 10), el('outside', 110, 210, 40, 10)];
    const result = extractFromRegionSource({ bbox: block, elements }, { kind: 'region', normalizedRect });
    expect(result.raw).toBe('inside');
  });

  it('is null for a block without extent', () => {
    expect(normalizeRectToBlock({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: 5, minY: 5, maxX: 5, maxY: 9 })).toBeNull();
  });
});
