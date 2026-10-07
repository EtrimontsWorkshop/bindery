import { describe, expect, it } from 'vitest';
import { splitSpanningLines } from '../../src/layout/spanning.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

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

describe('splitSpanningLines', () => {
  it('a full-width header above two columns goes to spanning, the columns to columnar', () => {
    // Text block: x=50..550 (width 500). The header covers the full width.
    // Two columns: left x=50..280 (230, 46%), right x=320..550 (230, 46%) — both below 70%.
    const heading = line('heading', 50, 550, 700);
    const leftCol1 = line('left1', 50, 280, 650);
    const leftCol2 = line('left2', 50, 280, 630);
    const rightCol1 = line('right1', 320, 550, 650);
    const lines = [heading, leftCol1, leftCol2, rightCol1];

    const { spanning, columnar, textBlockWidth } = splitSpanningLines(lines);
    expect(textBlockWidth).toBe(500);
    expect(spanning.map((l) => l.id)).toEqual(['heading']);
    expect(columnar.map((l) => l.id).sort()).toEqual(['left1', 'left2', 'right1']);
  });

  it('a single-column layout: lines filling most of the block are "columnar", NOT "spanning" (no baseline to compare with)', () => {
    // Block = 50..540 (490), lines ~90-98% of the block's OWN width — on a truly single-column page
    // EVERY line by definition looks like that. The 70% threshold computed relative to a block built
    // from THE SAME lines is therefore tautological: if all lines landed in `spanning`, column
    // detection would get not a single columnar line and couldn't return the correct answer
    // "1 column" (verified empirically on the layout-1col fixture).
    const lines = [line('a', 50, 500, 700), line('b', 60, 540, 680)];
    const { columnar, spanning } = splitSpanningLines(lines);
    expect(spanning).toHaveLength(0);
    expect(columnar).toHaveLength(2);
  });

  it('an empty list of lines -> an empty result without an error', () => {
    const result = splitSpanningLines([]);
    expect(result).toEqual({ spanning: [], columnar: [], textBlockWidth: 0 });
  });

  it('the threshold is configurable (the widthRatio parameter)', () => {
    // Block 50..450 (400). 1 wide line (100%) + 1 medium (50%) + 6 narrow (30%, a CLEAR majority of
    // the lines) — so that even with a loose threshold the "spanning" candidates remain a MINORITY
    // (see the test above: when a majority of lines qualifies, the whole page is columnar by definition).
    const narrows = Array.from({ length: 6 }, (_, i) => line(`narrow${i}`, 50, 170, 600 - i * 20)); // 120 = 30%
    const lines = [line('wide', 50, 450, 700), line('medium', 50, 250, 680), ...narrows];
    const strict = splitSpanningLines(lines, 0.99);
    expect(strict.spanning.map((l) => l.id)).toEqual(['wide']);
    const lenient = splitSpanningLines(lines, 0.4);
    expect(lenient.spanning.map((l) => l.id).sort()).toEqual(['medium', 'wide']);
  });
});
