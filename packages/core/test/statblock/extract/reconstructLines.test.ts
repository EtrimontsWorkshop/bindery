import { describe, expect, it } from 'vitest';
import { reconstructLines } from '../../../src/statblock/extract/reconstructLines.js';
import type { PageTextElement } from '../../../src/statblock/extract/types.js';

function el(text: string, x: number, y: number, w = text.length * 6, h = 10, overrides: Partial<PageTextElement> = {}): PageTextElement {
  return { text, x, y, w, h, fontName: 'TestFont', fontSize: 10, bold: false, italic: false, ...overrides };
}

describe('reconstructLines', () => {
  it('empty input produces no lines', () => {
    expect(reconstructLines([])).toEqual([]);
  });

  it('a single element becomes a single line', () => {
    const lines = reconstructLines([el('HP', 0, 0)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('HP');
  });

  it('elements on the same row (overlapping Y) join left-to-right into one line, regardless of input order', () => {
    const lines = reconstructLines([el('12', 20, 0), el('HP:', 0, 0)]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('HP: 12');
  });

  it('elements on different, non-overlapping rows become separate lines, top row first (PDF space, larger y = higher on the page)', () => {
    const lines = reconstructLines([el('Bottom', 0, 0), el('Top', 0, 100)]);
    expect(lines.map((l) => l.text)).toEqual(['Top', 'Bottom']);
  });

  it('a line bbox is the union of its elements bboxes', () => {
    const lines = reconstructLines([el('HP:', 0, 0, 20, 10), el('12', 30, 0, 15, 12)]);
    expect(lines[0]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 45, maxY: 12 });
  });

  it('partial vertical overlap still counts as the same row', () => {
    // el A: y 0-10, el B: y 5-15 -- overlap [5,10], length 5 > 0
    const lines = reconstructLines([el('A', 0, 0, 10, 10), el('B', 20, 5, 10, 10)]);
    expect(lines).toHaveLength(1);
  });

  it('zero vertical overlap (touching but not overlapping) starts a new row', () => {
    // A: y 10-20, B: y 0-10 -- overlap is exactly 0, not > 0
    const lines = reconstructLines([el('A', 0, 10, 10, 10), el('B', 0, 0, 10, 10)]);
    expect(lines).toHaveLength(2);
  });

  describe('column handling — a wide gap on the same row splits into separate lines instead of one run-on string', () => {
    it('two independent label/value pairs side by side on one visual row become two lines', () => {
      // "HP: 12" then a big gap then "AC: 15", all same row.
      const elements = [el('HP:', 0, 0, 20, 10), el('12', 22, 0, 15, 10), el('AC:', 200, 0, 20, 10), el('15', 222, 0, 15, 10)];
      const lines = reconstructLines(elements);
      expect(lines.map((l) => l.text)).toEqual(['HP: 12', 'AC: 15']);
    });

    it('normal inter-word spacing within a row does NOT get split', () => {
      const elements = [el('The', 0, 0, 20, 10), el('quick', 22, 0, 30, 10), el('fox', 54, 0, 20, 10)];
      const lines = reconstructLines(elements);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.text).toBe('The quick fox');
    });

    it('a row with only two elements and no other gap to compare against uses the absolute fallback threshold', () => {
      // Gap of 30pt with nothing else in the row to compute a median from -- still above COLUMN_GAP_ABSOLUTE_MIN_PT (24).
      const elements = [el('A', 0, 0, 10, 10), el('B', 40, 0, 10, 10)];
      const lines = reconstructLines(elements);
      expect(lines).toHaveLength(2);
    });
  });

  it('reading order is top-to-bottom across rows, left-to-right within a row', () => {
    const elements = [
      el('D', 0, 0), // bottom row
      el('B', 20, 100), // top row, right
      el('A', 0, 100), // top row, left
      el('C', 0, 50), // middle row
    ];
    const lines = reconstructLines(elements);
    expect(lines.map((l) => l.text)).toEqual(['A B', 'C', 'D']);
  });
});
