import { describe, expect, it } from 'vitest';
import { findVectorFigures, type FigureShape } from '../../src/images/vectorFigures.js';
import type { Rect } from '../../src/geometry.js';

const PAGE: Rect = { minX: 0, minY: 0, maxX: 595, maxY: 842 };
const shape = (x: number, y: number, w: number, h: number): FigureShape => ({ bbox: { minX: x, minY: y, maxX: x + w, maxY: y + h } });

/** `count` shapes of 20 x 20 pt (or `size`) in a grid of `columns` columns starting at (x, y), touching one another. */
function grid(count: number, columns: number, x: number, y: number, size = 20): FigureShape[] {
  return Array.from({ length: count }, (_, i) => shape(x + (i % columns) * size, y + Math.floor(i / columns) * size, size, size));
}

describe('findVectorFigures', () => {
  it('finds a cluster of many touching shapes that fill their box as one drawing', () => {
    const figures = findVectorFigures(grid(30, 6, 100, 200), PAGE);
    expect(figures).toHaveLength(1);
    expect(figures[0]!.shapeCount).toBe(30);
    expect(figures[0]!.bbox).toEqual({ minX: 100, minY: 200, maxX: 220, maxY: 300 });
  });

  it('keeps two drawings that lie apart as two', () => {
    const shapes = [...grid(30, 6, 100, 200), ...grid(30, 6, 300, 200)];
    expect(findVectorFigures(shapes, PAGE)).toHaveLength(2);
  });

  it('does not take a few shapes (a bullet, a flourish), an icon-sized cluster or a scatter of specks for a drawing', () => {
    expect(findVectorFigures(grid(10, 5, 100, 200), PAGE)).toEqual([]);
    expect(findVectorFigures(grid(30, 6, 100, 200, 4), PAGE)).toEqual([]); // 24 x 20 pt
    const specks = Array.from({ length: 40 }, (_, i) => shape(100 + (i % 8) * 2.5, 200 + Math.floor(i / 8) * 2.5, 1, 1));
    expect(findVectorFigures(specks, PAGE)).toEqual([]);
  });

  it('does not take a long, narrow cluster (a table, a header plate, a line of digits) for a drawing', () => {
    expect(findVectorFigures(grid(30, 30, 20, 200, 20), PAGE)).toEqual([]); // 600 x 20 pt
    expect(findVectorFigures(grid(60, 15, 20, 200, 20), PAGE)).toHaveLength(1); // 300 x 80 pt
    expect(findVectorFigures(grid(100, 25, 20, 200, 20), PAGE)).toEqual([]); // 500 x 80 pt: the width of the page's text
  });

  it('does not take a page-sized backdrop or a drawing that fills most of the page for a drawing', () => {
    expect(findVectorFigures([...grid(30, 6, 100, 200), shape(0, 0, 595, 842)], PAGE)).toHaveLength(1);
    expect(findVectorFigures(grid(2000, 50, 0, 0, 12), PAGE)).toEqual([]);
  });
});
