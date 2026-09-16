import { describe, expect, it } from 'vitest';
import { buildReadingOrder } from '../../src/layout/readingOrder.js';
import type { ColumnRegion } from '../../src/layout/columns.js';
import type { TextLine } from '../../src/layout/lineCluster.js';
import type { SpanningSplit } from '../../src/layout/spanning.js';

function line(id: string, minX: number, maxX: number, y: number): TextLine {
  return {
    id,
    text: id,
    bbox: { minX, minY: y, maxX, maxY: y + 12 },
    columnIndex: -1,
    crossAxisPosition: y,
    fonts: [{ key: 'Body@12', size: 12 }],
    dominantFont: { key: 'Body@12', size: 12 },
    syntheticBold: false,
  };
}

const LEFT_COL: ColumnRegion = { index: 0, bbox: { minX: 50, minY: 0, maxX: 280, maxY: 700 } };
const RIGHT_COL: ColumnRegion = { index: 1, bbox: { minX: 320, minY: 0, maxX: 550, maxY: 700 } };

describe('buildReadingOrder — dwie kolumny, bez rozpinajacych', () => {
  it('kolejnosc: lewa kolumna gora->dol, potem prawa kolumna gora->dol', () => {
    const split: SpanningSplit = {
      spanning: [],
      columnar: [
        line('L1', 50, 280, 690),
        line('L2', 50, 280, 670),
        line('R1', 320, 550, 690),
        line('R2', 320, 550, 670),
      ],
      textBlockWidth: 500,
    };
    const ordered = buildReadingOrder(split, [LEFT_COL, RIGHT_COL]);
    expect(ordered.map((o) => o.line.id)).toEqual(['L1', 'L2', 'R1', 'R2']);
    expect(ordered.filter((o) => o.line.id.startsWith('L')).every((o) => o.line.columnIndex === 0)).toBe(true);
    expect(ordered.filter((o) => o.line.id.startsWith('R')).every((o) => o.line.columnIndex === 1)).toBe(true);
  });
});

describe('buildReadingOrder — naglowek rozpinajacy dzieli strone na pasma (Z2+Z4)', () => {
  it('pasmo przed naglowkiem, potem naglowek, potem pasmo po nim — kolumny NIE mieszaja sie miedzy pasmami', () => {
    const heading = line('HEADING', 50, 550, 500); // pelnowymiarowy, w SRODKU strony
    const split: SpanningSplit = {
      spanning: [heading],
      columnar: [
        line('top-L', 50, 280, 690), // nad naglowkiem
        line('top-R', 320, 550, 690),
        line('bot-L', 50, 280, 300), // pod naglowkiem
        line('bot-R', 320, 550, 300),
      ],
      textBlockWidth: 500,
    };
    const ordered = buildReadingOrder(split, [LEFT_COL, RIGHT_COL]);
    expect(ordered.map((o) => o.line.id)).toEqual(['top-L', 'top-R', 'HEADING', 'bot-L', 'bot-R']);
    expect(ordered.find((o) => o.line.id === 'HEADING')!.line.columnIndex).toBe(-1);
  });
});

describe('buildReadingOrder — marginalia na koncu, osobna sekwencja', () => {
  it('strumienie != 0° trafiaja NA KONIEC, we WLASNEJ kolejnosci, nie wplecione w tok glowny', () => {
    const split: SpanningSplit = {
      spanning: [],
      columnar: [line('main1', 50, 280, 690), line('main2', 50, 280, 670)],
      textBlockWidth: 500,
    };
    const marginaliaLines = [line('side1', 560, 580, 690), line('side2', 560, 580, 500)];
    const ordered = buildReadingOrder(split, [LEFT_COL], [{ angle: 90, lines: marginaliaLines }]);
    expect(ordered.map((o) => o.line.id)).toEqual(['main1', 'main2', 'side1', 'side2']);
    expect(ordered.slice(2).every((o) => o.streamAngle === 90)).toBe(true);
    expect(ordered.slice(2).every((o) => o.line.columnIndex === -1)).toBe(true);
  });
});

describe('buildReadingOrder — rotacja strony 180° odwraca kolejnosc kolumn', () => {
  it('dla rotation=180, kolumny ida prawo->lewo zamiast lewo->prawo', () => {
    const split: SpanningSplit = {
      spanning: [],
      columnar: [line('L1', 50, 280, 690), line('R1', 320, 550, 690)],
      textBlockWidth: 500,
    };
    const normal = buildReadingOrder(split, [LEFT_COL, RIGHT_COL], [], 0);
    expect(normal.map((o) => o.line.id)).toEqual(['L1', 'R1']);
    const rotated = buildReadingOrder(split, [LEFT_COL, RIGHT_COL], [], 180);
    expect(rotated.map((o) => o.line.id)).toEqual(['R1', 'L1']);
  });
});

describe('buildReadingOrder — brak kolumn wykrytych (fallback jednokolumnowy)', () => {
  it('wszystkie linie kolumnowe trafiaja do jednej "kolumny" (index 0) gora->dol', () => {
    const singleCol: ColumnRegion = { index: 0, bbox: { minX: 50, minY: 0, maxX: 550, maxY: 700 } };
    const split: SpanningSplit = {
      spanning: [],
      columnar: [line('a', 50, 550, 690), line('b', 50, 550, 670)],
      textBlockWidth: 500,
    };
    const ordered = buildReadingOrder(split, [singleCol]);
    expect(ordered.map((o) => o.line.id)).toEqual(['a', 'b']);
    expect(ordered.every((o) => o.line.columnIndex === 0)).toBe(true);
  });
});
