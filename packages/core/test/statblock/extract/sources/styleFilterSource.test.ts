import { describe, expect, it } from 'vitest';
import { extractFromStyleFilterSource } from '../../../../src/statblock/extract/sources/styleFilterSource.js';
import type { ExtractionBlock, PageTextElement } from '../../../../src/statblock/extract/types.js';

function el(text: string, x: number, overrides: Partial<PageTextElement> = {}): PageTextElement {
  return { text, x, y: 0, w: text.length * 6, h: 10, fontName: 'Body', fontSize: 10, bold: false, italic: false, ...overrides };
}

function block(elements: PageTextElement[]): ExtractionBlock {
  return { bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements };
}

describe('extractFromStyleFilterSource — basic criteria', () => {
  it('filters by bold', () => {
    const b = block([el('Bold', 0, { bold: true }), el('Plain', 40)]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { bold: true } });
    expect(result.raw).toBe('Bold');
  });

  it('filters by italic', () => {
    const b = block([el('Italic', 0, { italic: true }), el('Plain', 40)]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { italic: true } });
    expect(result.raw).toBe('Italic');
  });

  it('filters by font name pattern (regex)', () => {
    const b = block([el('Heading', 0, { fontName: 'HeadingFont-Bold' }), el('Body', 40, { fontName: 'BodyFont' })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { fontNamePattern: '^Heading' } });
    expect(result.raw).toBe('Heading');
  });

  it('filters by minFontSize/maxFontSize', () => {
    const b = block([el('Small', 0, { fontSize: 8 }), el('Medium', 40, { fontSize: 12 }), el('Large', 80, { fontSize: 20 })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { minFontSize: 10, maxFontSize: 15 } });
    expect(result.raw).toBe('Medium');
  });

  it('combines multiple criteria (AND semantics)', () => {
    const b = block([el('BoldLarge', 0, { bold: true, fontSize: 20 }), el('BoldSmall', 40, { bold: true, fontSize: 8 }), el('PlainLarge', 80, { fontSize: 20 })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { bold: true, minFontSize: 15 } });
    expect(result.raw).toBe('BoldLarge');
  });
});

describe('extractFromStyleFilterSource — largestFontInBlock', () => {
  it('selects only the element(s) with the maximum font size in the block', () => {
    const b = block([el('Small', 0, { fontSize: 8 }), el('Title', 40, { fontSize: 24 }), el('Medium', 80, { fontSize: 12 })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { largestFontInBlock: true } });
    expect(result.raw).toBe('Title');
  });

  it('composes with other criteria: "largest BOLD font in block" ignores a larger non-bold font', () => {
    const b = block([el('BiggestPlain', 0, { fontSize: 30, bold: false }), el('BiggestBold', 40, { fontSize: 18, bold: true }), el('SmallBold', 80, { fontSize: 10, bold: true })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { bold: true, largestFontInBlock: true } });
    expect(result.raw).toBe('BiggestBold');
  });

  it('selects multiple elements tied for the largest size, in reading order', () => {
    const b = block([el('First', 0, { fontSize: 20 }), el('Second', 35, { fontSize: 20 }), el('Smaller', 120, { fontSize: 10 })]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { largestFontInBlock: true } });
    expect(result.raw).toBe('First Second');
  });
});

describe('extractFromStyleFilterSource — edge case: no match', () => {
  it('reports found:false with a diagnostic when nothing matches the filter', () => {
    const b = block([el('Plain', 0)]);
    const result = extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { bold: true } });
    expect(result.found).toBe(false);
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_STYLE_FILTER_NO_MATCH');
  });

  it('reports found:false on a completely empty block', () => {
    const result = extractFromStyleFilterSource(block([]), { kind: 'styleFilter', filter: { bold: true } });
    expect(result.found).toBe(false);
  });

  it('an invalid fontNamePattern regex is treated as "no match" rather than throwing', () => {
    const b = block([el('Body', 0)]);
    expect(() => extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { fontNamePattern: '(unterminated' } })).not.toThrow();
    expect(extractFromStyleFilterSource(b, { kind: 'styleFilter', filter: { fontNamePattern: '(unterminated' } }).found).toBe(false);
  });
});
