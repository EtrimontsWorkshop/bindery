import { describe, expect, it } from 'vitest';
import { findVectorFigures, type FigureShape } from '../../src/images/vectorFigures.js';
import { findVectorFigureUnits } from '../../src/images/buildImageExtraction.js';
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

  it('sees only what lies on the page: shapes past its edge are left out, a drawing across it is cut at it', () => {
    expect(findVectorFigures(grid(30, 6, 620, 200), PAGE)).toEqual([]);
    const across = findVectorFigures(grid(60, 12, 400, 200), PAGE);
    expect(across).toHaveLength(1);
    expect(across[0]!.bbox.maxX).toBe(595);
    expect(across[0]!.shapeCount).toBe(50);
  });

  it('does not take a narrow band of shapes running past the edge of the page (a chapter tab, a bleeding backdrop) for a drawing', () => {
    expect(findVectorFigures(grid(30, 6, 525, 200), PAGE)).toEqual([]); // 70 pt of it on the page
    expect(findVectorFigures(grid(30, 6, 475, 200), PAGE)).toHaveLength(1); // the same, 120 pt from the edge but not past it
  });

  it('does not take an ornament running past two edges of the page (its corner) or a wider swirl past one edge for a drawing', () => {
    expect(findVectorFigures(grid(48, 8, 465, 752), PAGE)).toEqual([]); // past the right and the top edge
    expect(findVectorFigures(grid(48, 8, -10, 400), PAGE)).toEqual([]); // 150 pt of it on the page, past its left edge
    expect(findVectorFigures(grid(48, 8, 40, 400), PAGE)).toHaveLength(1); // the same, inside the page
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

  it('leaves out the plate that a drawing lies on (a patch of paper that holds all its shapes and is several times their area)', () => {
    const drawing = grid(30, 6, 100, 200);
    const figures = findVectorFigures([shape(60, 160, 200, 200), ...drawing], PAGE);
    expect(figures).toHaveLength(1);
    expect(figures[0]!.shapeCount).toBe(30);
    expect(figures[0]!.bbox).toEqual({ minX: 100, minY: 200, maxX: 220, maxY: 300 });
  });

  it('keeps a shape that is only a little larger than the others, and does not join one that lies apart from them', () => {
    const drawing = grid(30, 6, 100, 200);
    expect(findVectorFigures([shape(95, 195, 130, 110), ...drawing], PAGE)[0]!.shapeCount).toBe(31);
    expect(findVectorFigures([shape(300, 160, 200, 200), ...drawing], PAGE)[0]!.shapeCount).toBe(30);
  });
});

/** Thirty shapes of 14 to 20 pt in a 6-column block at (100, 200), close enough to touch: a drawing, its shapes of different sizes. */
const drawing = Array.from({ length: 30 }, (_, i) => {
  const side = 14 + (i % 7);
  const x = 100 + (i % 6) * 16;
  const y = 200 + Math.floor(i / 6) * 16;
  return { page: 1, bbox: { minX: x, minY: y, maxX: x + side, maxY: y + side } };
});

describe('findVectorFigureUnits — words on the drawing', () => {
  const shapes = drawing;
  const pageBoxes = new Map([[1, PAGE]]);

  it('offers a drawing that no word lies on', () => {
    const units = findVectorFigureUnits(shapes, [], pageBoxes, new Map(), new Map([[1, [{ minX: 300, minY: 200, maxX: 500, maxY: 210 }]]]));
    expect(units).toHaveLength(1);
  });

  it('does not offer one with the page\'s words over it (a table on striped rows)', () => {
    // Three rows of words across the drawing's box: a tenth of it and more.
    const words = [205, 235, 265].map((y) => ({ minX: 105, minY: y, maxX: 190, maxY: y + 10 }));
    expect(findVectorFigureUnits(shapes, [], pageBoxes, new Map(), new Map([[1, words]]))).toEqual([]);
  });
});

describe('findVectorFigureUnits — a running ornament', () => {
  const page = (n: number): Map<number, Rect> => new Map(Array.from({ length: n }, (_, i) => [i + 1, PAGE]));
  it('does not offer a drawing found at the same place on three pages, drawn with a few shapes more or less', () => {
    // Shapes of two sizes (a grid of boxes of one size is left out for another reason).
    const drawing = (count: number): FigureShape[] => grid(count, 6, 100, 200).map((s, i) => (i % 2 === 0 ? s : { bbox: { ...s.bbox, maxY: s.bbox.maxY - 3 } }));
    const shapes = [1, 2, 3].flatMap((p) => drawing(32 + p).map((s) => ({ page: p, ...s })));
    expect(findVectorFigureUnits(shapes, [], page(3), new Map())).toEqual([]);
    expect(findVectorFigureUnits(shapes.filter((s) => s.page < 3), [], page(3), new Map())).toHaveLength(2);
  });
});

describe('findVectorFigureUnits — a grid of boxes', () => {
  const pageBoxes = new Map([[1, PAGE]]);

  it('does not offer a grid of boxes of one size (the tick boxes of a character sheet)', () => {
    const boxes = grid(20, 10, 45, 460, 18).map((s) => ({ page: 1, bbox: s.bbox }));
    expect(findVectorFigureUnits(boxes, [], pageBoxes, new Map(), new Map())).toEqual([]);
  });

  it('offers a cluster of shapes of different sizes', () => {
    expect(findVectorFigureUnits(drawing, [], pageBoxes, new Map(), new Map())).toHaveLength(1);
  });
});
