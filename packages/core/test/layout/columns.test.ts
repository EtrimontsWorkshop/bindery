import { describe, expect, it } from 'vitest';
import { detectColumns, validateColumnStabilityAcrossPages } from '../../src/layout/columns.js';
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

/** Builds N lines uniformly spread vertically in [minX,maxX], covering the whole block height (0..height). */
function fillColumn(prefix: string, minX: number, maxX: number, count: number, height: number): TextLine[] {
  return Array.from({ length: count }, (_, i) => line(`${prefix}${i}`, minX, maxX, (height / count) * i));
}

describe('detectColumns — no clear valleys', () => {
  it('one column, confidence=1, when there is no gutter at all (a single-column layout)', () => {
    const lines = fillColumn('p', 50, 550, 20, 600);
    const result = detectColumns(lines, 1);
    expect(result.columns).toHaveLength(1);
    expect(result.confidence).toBe(1);
    expect(result.columns[0]!.bbox.minX).toBe(50);
    expect(result.columns[0]!.bbox.maxX).toBe(550);
  });

  it('an empty list of columnar lines -> an empty result (e.g. the whole page is a spanning heading)', () => {
    const result = detectColumns([], 1);
    expect(result.columns).toHaveLength(0);
  });
});

describe('detectColumns — two columns with a real gutter', () => {
  it('detects two columns with a gutter empty over the WHOLE height of the block', () => {
    const left = fillColumn('l', 50, 280, 20, 600);
    const right = fillColumn('r', 320, 550, 20, 600);
    const result = detectColumns([...left, ...right], 1);
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0]!.bbox.maxX).toBeLessThanOrEqual(280 + 2); // the boundary ~where the left column ends
    expect(result.columns[1]!.bbox.minX).toBeGreaterThanOrEqual(320 - 2);
    expect(result.confidence).toBeGreaterThan(0.9); // a gutter completely empty over 100% of the height
  });

  it('columns sorted in reading order (left->right) regardless of the input order', () => {
    const left = fillColumn('l', 50, 280, 10, 600);
    const right = fillColumn('r', 320, 550, 10, 600);
    const result = detectColumns([...right, ...left], 1); // the right one given first
    expect(result.columns.map((c) => c.index)).toEqual([0, 1]);
    expect(result.columns[0]!.bbox.minX).toBeLessThan(result.columns[1]!.bbox.minX);
  });
});

describe('detectColumns — vertical validation (a gutter only in the upper quarter is NOT a column)', () => {
  it('a gutter with a LOW density (by line count) but covered by a tall line over a large part of the height is rejected', () => {
    // 30 short lines of the left "column" (x=50..280) + 30 short ones of the right (x=320..550) — many
    // lines, high density on both sides of the 280-320 gutter. ONE extra full-width line (x=50..550)
    // crosses the gutter, but it is tall (bbox 0..400 of a total height of 0..590) — its HEIGHT covers
    // >30% of the block, so vertical validation (the 70% emptiness threshold) rejects this gutter,
    // even though the density BY LINE COUNT in the gutter is very low (1 of ~31).
    const topLeft = Array.from({ length: 30 }, (_, i) => line(`tl${i}`, 50, 280, i * 20));
    const topRight = Array.from({ length: 30 }, (_, i) => line(`tr${i}`, 320, 550, i * 20));
    const tallCrossing: TextLine = { ...line('cross', 50, 550, 0), bbox: { minX: 50, minY: 0, maxX: 550, maxY: 400 } };
    const result = detectColumns([...topLeft, ...topRight, tallCrossing], 1);
    expect(result.columns).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === 'COLUMN_VALLEY_REJECTED_VERTICAL')).toBe(true);
  });
});

describe('validateColumnStabilityAcrossPages', () => {
  it('a page with ALL (both) neighbors disagreeing gets a Diagnostic, doesn\'t force agreement', () => {
    const perPage = [
      { pageNumber: 1, columnCount: 2 },
      { pageNumber: 2, columnCount: 2 },
      { pageNumber: 3, columnCount: 1 }, // differs from both neighbors
      { pageNumber: 4, columnCount: 2 },
      { pageNumber: 5, columnCount: 2 },
    ];
    const diagnostics = validateColumnStabilityAcrossPages(perPage);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.pageNumber).toBe(3);
    expect(diagnostics[0]!.code).toBe('COLUMN_COUNT_UNSTABLE');
  });

  it('a page agreeing with AT LEAST one neighbor gets no diagnostic', () => {
    const perPage = [
      { pageNumber: 1, columnCount: 2 },
      { pageNumber: 2, columnCount: 2 },
      { pageNumber: 3, columnCount: 1 }, // differs from p.2, but it is the end of the range (no next one)
    ];
    const diagnostics = validateColumnStabilityAcrossPages(perPage);
    expect(diagnostics).toHaveLength(1); // only page 3 (differs from its only neighbor, p.2)
    expect(diagnostics[0]!.pageNumber).toBe(3);
  });

  it('a single page without neighbors never gets a diagnostic', () => {
    expect(validateColumnStabilityAcrossPages([{ pageNumber: 1, columnCount: 3 }])).toHaveLength(0);
  });
});
