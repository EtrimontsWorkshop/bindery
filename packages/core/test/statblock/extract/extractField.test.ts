import { describe, expect, it } from 'vitest';
import { extractField } from '../../../src/statblock/extract/extractField.js';
import type { TransformStep } from '../../../src/statblock/extract/transforms/types.js';
import type { ExtractionBlock, PageTextElement } from '../../../src/statblock/extract/types.js';

function el(text: string, x: number, y: number, w = text.length * 6, h = 10): PageTextElement {
  return { text, x, y, w, h, fontName: 'TestFont', fontSize: 10, bold: false, italic: false };
}

describe('extractField — end-to-end: label source + transform chain + cast', () => {
  it('extracts and parses a numeric field from a label', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('HP:', 0, 0, 20, 10), el('12', 22, 0, 15, 10)] };
    const steps: TransformStep[] = [{ kind: 'trim' }, { kind: 'parseNumber' }];
    const result = extractField(block, { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' }, steps, { dataType: 'number' });
    expect(result.found).toBe(true);
    expect(result.value).toBe(12);
    expect(result.raw).toBe('12');
    expect(result.sourceBbox).not.toBeNull();
  });

  it('extracts a current/max pair via nthNumber then parseNumber', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('HP:', 0, 0, 20, 10), el('12/20', 22, 0, 30, 10)] };
    const steps: TransformStep[] = [{ kind: 'nthNumber', n: 2 }, { kind: 'parseNumber' }];
    const result = extractField(block, { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' }, steps, { dataType: 'number' });
    expect(result.value).toBe(20);
  });
});

describe('extractField — edge case: label not found', () => {
  it('reports found:false with the source diagnostic, no transform/cast diagnostics added', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('AC:', 0, 0, 20, 10)] };
    const result = extractField(block, { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' }, [{ kind: 'parseNumber' }], { dataType: 'number' });
    expect(result.found).toBe(false);
    expect(result.raw).toBeNull();
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toEqual([{ severity: 'warning', code: 'STATBLOCK_LABEL_NOT_FOUND', params: { labelPattern: 'HP:' } }]);
  });
});

describe('extractField — edge case: empty text', () => {
  it('a label with nothing after it, then parseNumber failing, then defaultValue catching it', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('HP:', 0, 0, 20, 10)] };
    const steps: TransformStep[] = [{ kind: 'parseNumber' }, { kind: 'defaultValue', value: 0 }];
    const result = extractField(block, { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' }, steps, { dataType: 'number' });
    expect(result.found).toBe(true);
    expect(result.value).toBe(0);
    // the source itself DID find the label (raw === ''), it's the transform chain that needed the default
    expect(result.raw).toBe('');
  });

  it('without a defaultValue step, an empty capture that fails to parse ends up not found', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('HP:', 0, 0, 20, 10)] };
    const result = extractField(block, { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' }, [{ kind: 'parseNumber' }], { dataType: 'number' });
    expect(result.found).toBe(false);
    expect(result.raw).toBe('');
  });
});

describe('extractField — edge case: wrapped lines', () => {
  it('joins a hyphen-wrapped multi-line capture into flowing text', () => {
    const block: ExtractionBlock = {
      bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
      elements: [el('Notes:', 0, 20, 30, 10), el('unbeliev-', 0, 10, 60, 10), el('able power.', 0, 0, 70, 10)],
    };
    const steps: TransformStep[] = [{ kind: 'joinWrappedLines' }];
    const result = extractField(
      block,
      { kind: 'label', labelPattern: 'Notes:', labelIsRegex: false, stopAt: 'endOfBlock' },
      steps,
      { dataType: 'string' },
    );
    expect(result.value).toBe('unbelievable power.');
  });
});

describe('extractField — edge case: weird minus sign end-to-end', () => {
  it('extracts a negative modifier written with a Unicode minus sign', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('DB:', 0, 0, 20, 10), el('−2', 22, 0, 15, 10)] };
    const result = extractField(block, { kind: 'label', labelPattern: 'DB:', labelIsRegex: false, stopAt: 'endOfLine' }, [{ kind: 'parseNumber' }], { dataType: 'number' });
    expect(result.value).toBe(-2);
  });
});

describe('extractField — region source end-to-end', () => {
  it('extracts a value map result from a region capture', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, elements: [el('Large', 10, 10, 30, 10)] };
    const steps: TransformStep[] = [{ kind: 'valueMap', valueMap: { id: 'v1', kind: 'lookupTable', params: { entries: { Large: 'L' } } } }];
    const result = extractField(block, { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 } }, steps, { dataType: 'choices', choices: ['L', 'S'] });
    expect(result.value).toBe('L');
    expect(result.diagnostics).toEqual([]);
  });
});

describe('extractField — a type mismatch after the chain is dropped with a diagnostic', () => {
  it('a field expecting a number, whose chain never actually parsed one, is not found', () => {
    const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: [el('Name:', 0, 0, 30, 10), el('Goblin', 32, 0, 30, 10)] };
    const result = extractField(block, { kind: 'label', labelPattern: 'Name:', labelIsRegex: false, stopAt: 'endOfLine' }, [{ kind: 'trim' }], { dataType: 'number' });
    expect(result.found).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'STATBLOCK_CAST_NOT_NUMBER')).toBe(true);
    // raw is still reported for debugging, even though the final value was rejected
    expect(result.raw).toBe('Goblin');
  });
});
