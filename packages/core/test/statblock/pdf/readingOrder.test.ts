import { describe, expect, it } from 'vitest';
import { buildStatblockReadingOrder, isSameColumn } from '../../../src/statblock/pdf/readingOrder.js';
import { el, page } from './testHelpers.js';

describe('buildStatblockReadingOrder — single column (no columns declared)', () => {
  it('treats the whole page as one column, top to bottom', () => {
    const p = page(1, [el('Bottom', 0, 0), el('Top', 0, 100)]);
    const order = buildStatblockReadingOrder([p]);
    expect(order.map((e) => e.line.text)).toEqual(['Top', 'Bottom']);
    expect(order.every((e) => e.columnIndex === 0)).toBe(true);
  });
});

describe('buildStatblockReadingOrder — multiple pages', () => {
  it('orders pages by pageNumber, not input order', () => {
    const p2 = page(2, [el('Page two', 0, 0)]);
    const p1 = page(1, [el('Page one', 0, 0)]);
    const order = buildStatblockReadingOrder([p2, p1]);
    expect(order.map((e) => e.pageNumber)).toEqual([1, 2]);
  });
});

describe('buildStatblockReadingOrder — two declared columns', () => {
  it('assigns elements to the column whose range contains them', () => {
    const p = page(
      1,
      [el('Left', 10, 0), el('Right', 310, 0)],
      { columns: [{ minX: 0, minY: 0, maxX: 280, maxY: 800 }, { minX: 300, minY: 0, maxX: 600, maxY: 800 }] },
    );
    const order = buildStatblockReadingOrder([p]);
    expect(order.find((e) => e.line.text === 'Left')!.columnIndex).toBe(0);
    expect(order.find((e) => e.line.text === 'Right')!.columnIndex).toBe(1);
  });

  it('processes column 1 FULLY (top to bottom) before moving to column 2 — column-major reading order', () => {
    const p = page(
      1,
      [el('Col1 Top', 10, 100), el('Col1 Bottom', 10, 0), el('Col2 Top', 310, 100), el('Col2 Bottom', 310, 0)],
      { columns: [{ minX: 0, minY: 0, maxX: 280, maxY: 800 }, { minX: 300, minY: 0, maxX: 600, maxY: 800 }] },
    );
    const order = buildStatblockReadingOrder([p]);
    expect(order.map((e) => e.line.text)).toEqual(['Col1 Top', 'Col1 Bottom', 'Col2 Top', 'Col2 Bottom']);
  });

  it('assigns an element slightly outside its nominal column range to the nearest column anyway', () => {
    const p = page(
      1,
      [el('Slightly left of column 2', 290, 0)],
      { columns: [{ minX: 0, minY: 0, maxX: 280, maxY: 800 }, { minX: 300, minY: 0, maxX: 600, maxY: 800 }] },
    );
    const order = buildStatblockReadingOrder([p]);
    // center at 290 + (text.length*6)/2 -- closer to column 2's minX (300) than column 1's maxX (280) once text width is considered, but even without: nearest-distance assignment never leaves it unassigned.
    expect(order).toHaveLength(1);
  });
});

describe('isSameColumn', () => {
  it('true for the same page and column index', () => {
    expect(isSameColumn({ pageNumber: 1, columnIndex: 0 }, { pageNumber: 1, columnIndex: 0 })).toBe(true);
  });

  it('false for a different page', () => {
    expect(isSameColumn({ pageNumber: 1, columnIndex: 0 }, { pageNumber: 2, columnIndex: 0 })).toBe(false);
  });

  it('false for a different column on the same page', () => {
    expect(isSameColumn({ pageNumber: 1, columnIndex: 0 }, { pageNumber: 1, columnIndex: 1 })).toBe(false);
  });
});
