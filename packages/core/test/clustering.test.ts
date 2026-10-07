import { describe, expect, it } from 'vitest';
import { clusterByOverlap } from '../src/clustering.js';
import type { Rect } from '../src/geometry.js';

interface Item {
  id: string;
  page: number;
  bbox: Rect;
}

function item(id: string, bbox: Rect, page = 1): Item {
  return { id, page, bbox };
}

describe('clusterByOverlap', () => {
  it('without extraMergeGate: every overlap merges (behavior from before the gate was added, unchanged)', () => {
    const a = item('a', { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const b = item('b', { minX: 90, minY: 0, maxX: 190, maxY: 100 });
    const result = clusterByOverlap([a, b], (i) => i.page, (i) => i.bbox);
    expect(result.get(a)).toBe(result.get(b));
  });

  it('an extraMergeGate returning false blocks the merge despite overlapping bboxes', () => {
    const a = item('a', { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const b = item('b', { minX: 90, minY: 0, maxX: 190, maxY: 100 });
    const result = clusterByOverlap(
      [a, b],
      (i) => i.page,
      (i) => i.bbox,
      () => false,
    );
    expect(result.get(a)).not.toBe(result.get(b));
  });

  it('extraMergeGate is NOT called for pairs that don\'t overlap at all (still separate clusters)', () => {
    const a = item('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const b = item('b', { minX: 500, minY: 500, maxX: 510, maxY: 510 });
    let calls = 0;
    const result = clusterByOverlap(
      [a, b],
      (i) => i.page,
      (i) => i.bbox,
      () => {
        calls++;
        return true;
      },
    );
    expect(calls).toBe(0);
    expect(result.get(a)).not.toBe(result.get(b));
  });

  it('extraMergeGate allows a selective merge: transitivity through a third element still works', () => {
    // a-b: gate false (doesn't link), b-c: gate true (links) -> a and c should NOT fall into one
    // cluster solely through a chain of sub-pairs the gate blocked; but b-c on its own forms the cluster {b,c}.
    const a = item('a', { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const b = item('b', { minX: 90, minY: 0, maxX: 190, maxY: 100 });
    const c = item('c', { minX: 150, minY: 0, maxX: 250, maxY: 100 });
    const result = clusterByOverlap(
      [a, b, c],
      (i) => i.page,
      (i) => i.bbox,
      (x, y) => !(x.id === 'a' && y.id === 'b') && !(x.id === 'b' && y.id === 'a'),
    );
    expect(result.get(a)).not.toBe(result.get(b));
    expect(result.get(b)).toBe(result.get(c));
  });
});
