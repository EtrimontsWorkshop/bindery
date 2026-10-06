import { describe, expect, it } from 'vitest';
import { extractFromLabelSource } from '../../../../src/statblock/extract/sources/labelSource.js';
import type { LabelSource } from '../../../../src/statblock/extract/sources/types.js';
import type { ExtractionBlock, PageTextElement } from '../../../../src/statblock/extract/types.js';

function el(text: string, x: number, y: number, w = text.length * 6, h = 10): PageTextElement {
  return { text, x, y, w, h, fontName: 'TestFont', fontSize: 10, bold: false, italic: false };
}

function block(elements: PageTextElement[]): ExtractionBlock {
  return { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements };
}

const baseSource: LabelSource = { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'endOfLine' };

describe('extractFromLabelSource — plain text label, stopAt: endOfLine', () => {
  it('captures the remainder of the line after the label', () => {
    const b = block([el('HP:', 0, 0, 20, 10), el('12', 22, 0, 15, 10)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.found).toBe(true);
    expect(result.raw).toBe('12');
  });

  it('captures multiple remaining words on the same line', () => {
    const b = block([el('Notes:', 0, 0, 30, 10), el('none', 32, 0, 20, 10), el('yet', 54, 0, 15, 10)]);
    const result = extractFromLabelSource(b, { ...baseSource, labelPattern: 'Notes:' });
    expect(result.raw).toBe('none yet');
  });

  it('does NOT include a value sitting in a different column on the same row (wide gap)', () => {
    const b = block([el('HP:', 0, 0, 20, 10), el('12', 22, 0, 15, 10), el('AC:', 200, 0, 20, 10), el('15', 222, 0, 15, 10)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.raw).toBe('12');
  });

  it('ignores subsequent lines entirely, even if stopAt is endOfLine and more text follows below', () => {
    const b = block([el('HP:', 0, 10, 20, 10), el('12', 22, 10, 15, 10), el('More text below', 0, 0, 80, 10)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.raw).toBe('12');
  });
});

describe('extractFromLabelSource — edge case: label not found', () => {
  it('reports found:false with a diagnostic when the label text never appears', () => {
    const b = block([el('AC:', 0, 0, 20, 10), el('15', 22, 0, 15, 10)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.found).toBe(false);
    expect(result.raw).toBeNull();
    expect(result.diagnostics).toEqual([{ severity: 'warning', code: 'STATBLOCK_LABEL_NOT_FOUND', params: { labelPattern: 'HP:' } }]);
  });

  it('reports found:false on a completely empty block (no elements at all)', () => {
    const result = extractFromLabelSource(block([]), baseSource);
    expect(result.found).toBe(false);
  });

  it('plain-text matching requires an EXACT trimmed match, not a substring', () => {
    // "HPX:" contains "HP" but is not exactly "HP:" -- must not match.
    const b = block([el('HPX:', 0, 0, 30, 10), el('12', 32, 0, 15, 10)]);
    expect(extractFromLabelSource(b, baseSource).found).toBe(false);
  });
});

describe('extractFromLabelSource — edge case: empty value after the label', () => {
  it('a label with nothing after it on its line is found:true with raw:"" plus an info diagnostic', () => {
    const b = block([el('HP:', 0, 0, 20, 10)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.found).toBe(true);
    expect(result.raw).toBe('');
    expect(result.diagnostics).toContainEqual({ severity: 'info', code: 'STATBLOCK_LABEL_VALUE_EMPTY', params: { labelPattern: 'HP:' } });
  });
});

describe('extractFromLabelSource — stopAt: endOfBlock', () => {
  it('accumulates every line after the label, joined by newline', () => {
    const b = block([
      el('Notes:', 0, 20, 30, 10),
      el('First line.', 0, 10, 60, 10),
      el('Second line.', 0, 0, 60, 10),
    ]);
    const result = extractFromLabelSource(b, { ...baseSource, labelPattern: 'Notes:', stopAt: 'endOfBlock' });
    expect(result.raw).toBe('First line.\nSecond line.');
  });

  it('the label can be alone on its own line, with the value starting on the NEXT line', () => {
    const b = block([el('Notes:', 0, 10, 30, 10), el('Below the label.', 0, 0, 70, 10)]);
    const result = extractFromLabelSource(b, { ...baseSource, labelPattern: 'Notes:', stopAt: 'endOfBlock' });
    expect(result.raw).toBe('Below the label.');
  });
});

describe('extractFromLabelSource — stopAt: nextLabel', () => {
  const source: LabelSource = {
    kind: 'label',
    labelPattern: 'Notes:',
    labelIsRegex: false,
    stopAt: 'nextLabel',
    nextLabelPattern: '^[A-Z][a-zA-Z]*:$',
    nextLabelIsRegex: true,
  };

  it('stops accumulating once a line matches the next-label pattern, excluding it', () => {
    const b = block([
      el('Notes:', 0, 20, 30, 10),
      el('Some notes here.', 0, 10, 70, 10),
      el('Attacks:', 0, 0, 40, 10),
    ]);
    const result = extractFromLabelSource(b, source);
    expect(result.raw).toBe('Some notes here.');
  });

  it('without a matching next label, falls through to the end of the block (same as endOfBlock)', () => {
    const b = block([el('Notes:', 0, 10, 30, 10), el('All of this counts.', 0, 0, 80, 10)]);
    const result = extractFromLabelSource(b, source);
    expect(result.raw).toBe('All of this counts.');
  });

  it('reports an error diagnostic and found:false when nextLabelPattern is missing entirely', () => {
    const badSource: LabelSource = { kind: 'label', labelPattern: 'Notes:', labelIsRegex: false, stopAt: 'nextLabel' };
    const b = block([el('Notes:', 0, 0, 30, 10)]);
    const result = extractFromLabelSource(b, badSource);
    expect(result.found).toBe(false);
    expect(result.diagnostics).toEqual([{ severity: 'error', code: 'STATBLOCK_MISSING_NEXT_LABEL_PATTERN', params: {} }]);
  });
});

describe('extractFromLabelSource — regex label matching', () => {
  it('matches a label via regex instead of exact text', () => {
    const b = block([el('HP', 0, 0, 15, 10), el('12', 17, 0, 15, 10)]);
    const result = extractFromLabelSource(b, { kind: 'label', labelPattern: '^HP:?$', labelIsRegex: true, stopAt: 'endOfLine' });
    expect(result.found).toBe(true);
    expect(result.raw).toBe('12');
  });

  it('an invalid regex pattern produces a clear diagnostic instead of throwing', () => {
    const b = block([el('HP:', 0, 0, 20, 10)]);
    expect(() => extractFromLabelSource(b, { kind: 'label', labelPattern: '(unterminated', labelIsRegex: true, stopAt: 'endOfLine' })).not.toThrow();
    const result = extractFromLabelSource(b, { kind: 'label', labelPattern: '(unterminated', labelIsRegex: true, stopAt: 'endOfLine' });
    expect(result.found).toBe(false);
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_INVALID_REGEX');
  });
});

describe('extractFromLabelSource — sourceBbox', () => {
  it('is the union of the label element and every captured value element', () => {
    const b = block([el('HP:', 0, 0, 20, 10), el('12', 22, 0, 15, 12)]);
    const result = extractFromLabelSource(b, baseSource);
    expect(result.sourceBbox).toEqual({ minX: 0, minY: 0, maxX: 37, maxY: 12 });
  });
});
