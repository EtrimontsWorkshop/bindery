import { describe, expect, it } from 'vitest';
import { repairGutterCrossingLines } from '../../src/layout/gutterRepair.js';
import type { ColumnRegion } from '../../src/layout/columns.js';
import type { TextLine, LineToken } from '../../src/layout/lineCluster.js';
import type { SpanningSplit } from '../../src/layout/spanning.js';

function tok(text: string, minX: number, maxX: number): LineToken {
  return { text, bbox: { minX, minY: 700, maxX, maxY: 710 } };
}

function line(id: string, tokens: LineToken[], overrides: Partial<TextLine> = {}): TextLine {
  const bbox = tokens.reduce(
    (acc, t) => ({ minX: Math.min(acc.minX, t.bbox.minX), minY: acc.minY, maxX: Math.max(acc.maxX, t.bbox.maxX), maxY: acc.maxY }),
    { minX: Infinity, minY: 700, maxX: -Infinity, maxY: 710 },
  );
  return {
    id,
    text: tokens.map((t) => t.text).join(' '),
    bbox,
    columnIndex: -1,
    crossAxisPosition: 700,
    fonts: [{ key: 'Body@10', size: 10 }],
    dominantFont: { key: 'Body@10', size: 10 },
    syntheticBold: false,
    tokens,
    ...overrides,
  };
}

const TWO_COLUMNS: ColumnRegion[] = [
  { index: 0, bbox: { minX: 45, minY: 0, maxX: 260, maxY: 792 } },
  { index: 1, bbox: { minX: 310, minY: 0, maxX: 540, maxY: 792 } },
];

function splitWith(spanning: TextLine[], columnar: TextLine[] = []): SpanningSplit {
  return { spanning, columnar, textBlockWidth: 495 };
}

describe('repairGutterCrossingLines — falszywe sklejenie (rozetnij)', () => {
  it('linia z tokenami po obu stronach rynny, ZERO tokenow w rynnie -> rozcieta na dwa fragmenty kolumnowe', () => {
    const falseMerge = line('l0', [tok('koniec zdania lewej', 45, 200), tok('poczatek prawej sekcji', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(1);
    expect(result.split.spanning).toHaveLength(0);
    expect(result.split.columnar).toHaveLength(2);
    expect(result.split.columnar[0]!.text).toBe('koniec zdania lewej');
    expect(result.split.columnar[1]!.text).toBe('poczatek prawej sekcji');
  });

  it('id fragmentow niesie powiazanie ze zrodlowa linia (provenance)', () => {
    const falseMerge = line('p5-0-3', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(result.split.columnar[0]!.id).toContain('p5-0-3');
    expect(result.split.columnar[1]!.id).toContain('p5-0-3');
  });
});

describe('repairGutterCrossingLines — prawdziwa linia rozpinajaca (NIE ruszaj)', () => {
  it('token OBECNY wewnatrz obszaru rynny -> pozostaje w spanning, bez zmian', () => {
    // Rynna to 260-310. Token trzeci lezy DOKLADNIE w tym zakresie.
    const trueSpanning = line('l0', [tok('Naglowek', 45, 200), tok('nad', 270, 295), tok('kolumnami', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([trueSpanning]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
    expect(result.split.spanning[0]).toBe(trueSpanning);
    expect(result.split.columnar).toHaveLength(0);
  });
});

describe('repairGutterCrossingLines — bezpiecznik progu ufnosci', () => {
  it('confidence PONIZEJ progu -> nic nie rozcina, nawet gdy geometria wygladalaby na falszywe sklejenie', () => {
    const falseMerge = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.5);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('mniej niz 2 kolumny -> nic nie rozcina (brak rynny do przecinania)', () => {
    const someLine = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([someLine]), [{ index: 0, bbox: { minX: 45, minY: 0, maxX: 540, maxY: 792 } }], 1);
    expect(result.splitCount).toBe(0);
  });
});

describe('repairGutterCrossingLines — inne bezpieczniki', () => {
  it('brak danych o tokenach (tokens undefined) -> nie tnie (nie zgaduje bez pewnosci)', () => {
    const noTokenData = line('l0', [tok('a', 45, 200), tok('b', 320, 500)], { tokens: undefined });
    const result = repairGutterCrossingLines(splitWith([noTokenData]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('linia NIE przecinajaca zadnej rynny (miesci sie w jednej kolumnie) -> bez zmian', () => {
    const withinOneColumn = line('l0', [tok('a', 45, 100), tok('b', 110, 200)]);
    const result = repairGutterCrossingLines(splitWith([withinOneColumn]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('linie kolumnowe (columnar) pozostaja nietkniete, tylko spanning jest sprawdzane', () => {
    const columnarLine = line('c0', [tok('juz kolumnowa', 45, 200)]);
    const result = repairGutterCrossingLines(splitWith([], [columnarLine]), TWO_COLUMNS, 0.9);
    expect(result.split.columnar).toEqual([columnarLine]);
    expect(result.splitCount).toBe(0);
  });
});

describe('repairGutterCrossingLines — 3+ kolumny (N rynien)', () => {
  const THREE_COLUMNS: ColumnRegion[] = [
    { index: 0, bbox: { minX: 45, minY: 0, maxX: 180, maxY: 792 } },
    { index: 1, bbox: { minX: 210, minY: 0, maxX: 340, maxY: 792 } },
    { index: 2, bbox: { minX: 370, minY: 0, maxX: 540, maxY: 792 } },
  ];

  it('falszywe sklejenie WSZYSTKICH trzech kolumn -> rozciete na trzy fragmenty', () => {
    const falseMerge = line('l0', [tok('a', 45, 170), tok('b', 220, 330), tok('c', 380, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), THREE_COLUMNS, 0.9);
    expect(result.splitCount).toBe(1);
    expect(result.split.columnar).toHaveLength(3);
  });

  it('token w JEDNEJ z dwoch przecietych rynien -> NIE ruszaj (choc druga rynna jest pusta)', () => {
    const partialSpanning = line('l0', [tok('a', 45, 170), tok('nad-rynna', 190, 360), tok('c', 380, 500)]);
    const result = repairGutterCrossingLines(splitWith([partialSpanning]), THREE_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });
});

describe('repairGutterCrossingLines — determinizm', () => {
  it('dwa wywolania z tymi samymi danymi daja identyczny wynik', () => {
    const falseMerge = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const r1 = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    const r2 = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
