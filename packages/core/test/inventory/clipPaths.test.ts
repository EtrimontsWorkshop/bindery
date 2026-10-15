import { describe, expect, it } from 'vitest';
import { clipCoverage, clipPathBBox, flattenPath, pointInClipPath, restrictingClips } from '../../src/inventory/clipPaths.js';

const M = 0;
const L = 1;
const C = 2;
const Z = 4;
const rect = (x0: number, y0: number, x1: number, y1: number) => [M, x0, y0, L, x1, y0, L, x1, y1, L, x0, y1, Z];
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

describe('flattenPath', () => {
  it('turns a rectangle into one polygon of its four corners', () => {
    const path = flattenPath(rect(10, 20, 110, 70), IDENTITY);
    expect(path).toHaveLength(1);
    expect(path[0]).toEqual([10, 20, 110, 20, 110, 70, 10, 70]);
  });

  it('transforms the points by the CTM', () => {
    const path = flattenPath(rect(0, 0, 1, 1), [100, 0, 0, 50, 10, 20]);
    expect(path[0]).toEqual([10, 20, 110, 20, 110, 70, 10, 70]);
  });

  it('keeps several subpaths apart', () => {
    const path = flattenPath([...rect(0, 0, 10, 10), ...rect(20, 20, 30, 30)], IDENTITY);
    expect(path).toHaveLength(2);
  });

  it('flattens a curve into straight segments that end at its end point', () => {
    const path = flattenPath([M, 0, 0, C, 0, 10, 10, 10, 10, 0, L, 5, -5, Z], IDENTITY);
    expect(path).toHaveLength(1);
    const polygon = path[0]!;
    expect(polygon.length / 2).toBeGreaterThan(5);
    expect(polygon[polygon.length - 4]).toBeCloseTo(10);
  });

  it('drops a degenerate subpath of fewer than three points', () => {
    expect(flattenPath([M, 0, 0, L, 5, 5, Z], IDENTITY)).toHaveLength(0);
  });
});

describe('clip path geometry', () => {
  const square = flattenPath(rect(0, 0, 100, 100), IDENTITY);

  it('bbox of a path', () => {
    expect(clipPathBBox(square)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(clipPathBBox([])).toBeNull();
  });

  it('point in path (even-odd: a hole is outside)', () => {
    const withHole = flattenPath([...rect(0, 0, 100, 100), ...rect(40, 40, 60, 60)], IDENTITY);
    expect(pointInClipPath(square, 50, 50)).toBe(true);
    expect(pointInClipPath(square, 150, 50)).toBe(false);
    expect(pointInClipPath(withHole, 50, 50)).toBe(false);
    expect(pointInClipPath(withHole, 10, 10)).toBe(true);
  });

  it('a clip whose bbox contains the picture does not restrict it', () => {
    const page = flattenPath(rect(0, 0, 612, 792), IDENTITY);
    expect(restrictingClips([page], { minX: 100, minY: 100, maxX: 300, maxY: 300 })).toHaveLength(0);
    expect(restrictingClips([square], { minX: 50, minY: 50, maxX: 300, maxY: 300 })).toHaveLength(1);
  });

  it('coverage is the share of the picture inside the clip', () => {
    const half = flattenPath(rect(0, 0, 50, 100), IDENTITY);
    expect(clipCoverage([half], [100, 0, 0, 100, 0, 0])).toBeCloseTo(0.5, 1);
    expect(clipCoverage([square], [100, 0, 0, 100, 0, 0])).toBeCloseTo(1, 1);
    expect(clipCoverage([half, flattenPath(rect(0, 0, 100, 25), IDENTITY)], [100, 0, 0, 100, 0, 0])).toBeCloseTo(0.125, 1);
  });
});
