import { describe, expect, it } from 'vitest';
import { connectedGroups, placedInksOverlap, placedMasksOverlap, type OpaqueMask, type PlacedMask } from '../../src/images/opaqueOverlap.js';

/** A mask whose cells are opaque where `rows` has a `#` (row 0 is the top of the raster). */
function maskOf(rows: string[]): OpaqueMask {
  const height = rows.length;
  const width = rows[0]!.length;
  const opaque = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((c, x) => (opaque[y * width + x] = c === '#' ? 1 : 0)));
  return { width, height, opaque };
}

const placed = (box: PlacedMask['box'], rows: string[], flipX = false, flipY = false): PlacedMask => ({ box, flipX, flipY, mask: maskOf(rows) });

describe('placedMasksOverlap', () => {
  it('pictures whose boxes overlap but whose visible pixels do not are not overlapping', () => {
    // A full-width head on top of a thin handle, and a blade standing beside the handle under the head.
    const axe = placed({ minX: 0, minY: 0, maxX: 40, maxY: 100 }, ['########', '########', '..#.....', '..#.....', '..#.....', '..#.....', '..#.....', '..#.....']);
    const blade = placed({ minX: 30, minY: 0, maxX: 50, maxY: 60 }, ['.#..', '.#..', '.#..', '.#..', '.#..', '.#..']);
    expect(placedMasksOverlap(axe, blade)).toBe(false);
  });

  it('pictures whose visible pixels lie over one another overlap', () => {
    const a = placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, ['####', '####', '####', '####']);
    const b = placed({ minX: 20, minY: 20, maxX: 60, maxY: 60 }, ['####', '####', '####', '####']);
    expect(placedMasksOverlap(a, b)).toBe(true);
  });

  it('boxes that do not meet never overlap', () => {
    const a = placed({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, ['##', '##']);
    const b = placed({ minX: 20, minY: 0, maxX: 30, maxY: 10 }, ['##', '##']);
    expect(placedMasksOverlap(a, b)).toBe(false);
  });

  it('a mirrored picture is read from the other side', () => {
    // The visible column is on the left of the raster; mirrored, it lies on the right of the box.
    const column = ['#...', '#...', '#...', '#...'];
    const right = placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, ['...#', '...#', '...#', '...#']);
    expect(placedMasksOverlap(placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, column, true), right)).toBe(true);
    expect(placedMasksOverlap(placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, column, false), right)).toBe(false);
    // Top to bottom: row 0 of the raster is the bottom of the box.
    const top = ['####', '....', '....', '....'];
    const bottom = placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, ['....', '....', '....', '####']);
    expect(placedMasksOverlap(placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, top, false, true), bottom)).toBe(true);
    expect(placedMasksOverlap(placed({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, top, false, false), bottom)).toBe(false);
  });
});

describe('connectedGroups', () => {
  it('groups indices transitively, in order of their first member', () => {
    const edges = new Set(['0-1', '1-3']);
    const groups = connectedGroups(5, (i, j) => edges.has(`${i}-${j}`));
    expect(groups).toEqual([[0, 1, 3], [2], [4]]);
  });
});

describe('placedInksOverlap', () => {
  const ink = (rows: number, columns: number): string[] => Array.from({ length: rows }, () => '#'.repeat(columns));

  it('two drawings whose soft edges meet over a fraction of their inked area do not overlap, though they share more than a few points', () => {
    // Two drawings of 40x100 points, with their boxes overlapping by 10 points and only the edge columns inked in the overlap.
    const left = placed({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, Array.from({ length: 10 }, () => '#########.'));
    const right = placed({ minX: 99, minY: 0, maxX: 199, maxY: 100 }, Array.from({ length: 10 }, () => '.#########'));
    expect(placedMasksOverlap(left, right)).toBe(false);
    const edgeLeft = placed({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, Array.from({ length: 10 }, () => '#########.'));
    const edgeRight = placed({ minX: 90, minY: 0, maxX: 190, maxY: 100 }, Array.from({ length: 10 }, () => '#.........'));
    expect(placedInksOverlap(edgeLeft, edgeRight)).toBe(false);
  });

  it('a drawing laid over another one by a real share of its ink overlaps', () => {
    const a = placed({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, ink(10, 10));
    const b = placed({ minX: 50, minY: 0, maxX: 150, maxY: 100 }, ink(10, 10));
    expect(placedInksOverlap(a, b)).toBe(true);
  });
});
