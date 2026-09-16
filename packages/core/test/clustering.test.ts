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
  it('bez extraMergeGate: kazde nakladanie sie laczy (zachowanie sprzed KROK-16 Z2, niezmienione)', () => {
    const a = item('a', { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const b = item('b', { minX: 90, minY: 0, maxX: 190, maxY: 100 });
    const result = clusterByOverlap([a, b], (i) => i.page, (i) => i.bbox);
    expect(result.get(a)).toBe(result.get(b));
  });

  it('extraMergeGate zwracajacy false blokuje polaczenie mimo nakladania sie bboksow', () => {
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

  it('extraMergeGate NIE jest wolany dla par ktore sie w ogole nie nakladaja (nadal osobne klastry)', () => {
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

  it('extraMergeGate pozwala na selektywne polaczenie: transytywnosc przez trzeci element nadal dziala', () => {
    // a-b: gate false (nie laczy), b-c: gate true (laczy) -> a i c NIE powinny wpasc w jeden klaster
    // wylacznie przez zbitke pod-par ktorych gate zablokowal; ale b-c samo w sobie tworzy klaster {b,c}.
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
