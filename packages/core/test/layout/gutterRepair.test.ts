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

describe('repairGutterCrossingLines — a false merge (split it)', () => {
  it('a line with tokens on both sides of the gutter, ZERO tokens in the gutter -> split into two columnar fragments', () => {
    const falseMerge = line('l0', [tok('koniec zdania lewej', 45, 200), tok('poczatek prawej sekcji', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(1);
    expect(result.split.spanning).toHaveLength(0);
    expect(result.split.columnar).toHaveLength(2);
    expect(result.split.columnar[0]!.text).toBe('koniec zdania lewej');
    expect(result.split.columnar[1]!.text).toBe('poczatek prawej sekcji');
  });

  it('the fragment ids carry the link to the source line (provenance)', () => {
    const falseMerge = line('p5-0-3', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(result.split.columnar[0]!.id).toContain('p5-0-3');
    expect(result.split.columnar[1]!.id).toContain('p5-0-3');
  });
});

describe('repairGutterCrossingLines — a true spanning line (do NOT touch)', () => {
  it('a token PRESENT inside the gutter area -> stays in spanning, unchanged', () => {
    // The gutter is 260-310. The third token lies EXACTLY in that range.
    const trueSpanning = line('l0', [tok('Naglowek', 45, 200), tok('nad', 270, 295), tok('kolumnami', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([trueSpanning]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
    expect(result.split.spanning[0]).toBe(trueSpanning);
    expect(result.split.columnar).toHaveLength(0);
  });
});

describe('repairGutterCrossingLines — the confidence-threshold safeguard', () => {
  it('confidence BELOW the threshold -> splits nothing, even when the geometry would look like a false merge', () => {
    const falseMerge = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.5);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('fewer than 2 columns -> splits nothing (no gutter to cross)', () => {
    const someLine = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const result = repairGutterCrossingLines(splitWith([someLine]), [{ index: 0, bbox: { minX: 45, minY: 0, maxX: 540, maxY: 792 } }], 1);
    expect(result.splitCount).toBe(0);
  });
});

describe('repairGutterCrossingLines — other safeguards', () => {
  it('no token data (tokens undefined) -> doesn\'t cut (doesn\'t guess without certainty)', () => {
    const noTokenData = line('l0', [tok('a', 45, 200), tok('b', 320, 500)], { tokens: undefined });
    const result = repairGutterCrossingLines(splitWith([noTokenData]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('a line NOT crossing any gutter (fits in one column) -> unchanged', () => {
    const withinOneColumn = line('l0', [tok('a', 45, 100), tok('b', 110, 200)]);
    const result = repairGutterCrossingLines(splitWith([withinOneColumn]), TWO_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });

  it('columnar lines stay untouched, only spanning is checked', () => {
    const columnarLine = line('c0', [tok('juz kolumnowa', 45, 200)]);
    const result = repairGutterCrossingLines(splitWith([], [columnarLine]), TWO_COLUMNS, 0.9);
    expect(result.split.columnar).toEqual([columnarLine]);
    expect(result.splitCount).toBe(0);
  });
});

describe('repairGutterCrossingLines — 3+ columns (N gutters)', () => {
  const THREE_COLUMNS: ColumnRegion[] = [
    { index: 0, bbox: { minX: 45, minY: 0, maxX: 180, maxY: 792 } },
    { index: 1, bbox: { minX: 210, minY: 0, maxX: 340, maxY: 792 } },
    { index: 2, bbox: { minX: 370, minY: 0, maxX: 540, maxY: 792 } },
  ];

  it('a false merge of ALL three columns -> split into three fragments', () => {
    const falseMerge = line('l0', [tok('a', 45, 170), tok('b', 220, 330), tok('c', 380, 500)]);
    const result = repairGutterCrossingLines(splitWith([falseMerge]), THREE_COLUMNS, 0.9);
    expect(result.splitCount).toBe(1);
    expect(result.split.columnar).toHaveLength(3);
  });

  it('a token in ONE of two crossed gutters -> do NOT touch (even though the other gutter is empty)', () => {
    const partialSpanning = line('l0', [tok('a', 45, 170), tok('nad-rynna', 190, 360), tok('c', 380, 500)]);
    const result = repairGutterCrossingLines(splitWith([partialSpanning]), THREE_COLUMNS, 0.9);
    expect(result.splitCount).toBe(0);
    expect(result.split.spanning).toHaveLength(1);
  });
});

describe('repairGutterCrossingLines — determinism', () => {
  it('two calls with the same data give an identical result', () => {
    const falseMerge = line('l0', [tok('a', 45, 200), tok('b', 320, 500)]);
    const r1 = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    const r2 = repairGutterCrossingLines(splitWith([falseMerge]), TWO_COLUMNS, 0.9);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
