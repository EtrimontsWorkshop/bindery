import { describe, expect, it } from 'vitest';
import { buildVectorRegions } from '../../src/inventory/vectorRegistry.js';
import type { WalkEvent } from '../../src/inventory/walkOperators.js';

const PAGE_BOX = { minX: 0, minY: 0, maxX: 200, maxY: 200 };

describe('buildVectorRegions', () => {
  it('liczy relativeArea wzgledem strony i domyslnie groupSubtype=null', () => {
    const events: WalkEvent[] = [
      { type: 'vector', kind: 'fill', bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, ctm: [1, 0, 0, 1, 0, 0], inGroup: null, index: 0 },
    ];
    const regions = buildVectorRegions(events, 1, PAGE_BOX);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.relativeArea).toBeCloseTo(0.25); // 100*100 / 200*200
    expect(regions[0]!.groupSubtype).toBeNull();
  });

  it('[KROK-5 Z6] przenosi groupSubtype z eventu (maska luminancyjna oparta na wypelnieniu, nie obrazie)', () => {
    const events: WalkEvent[] = [
      {
        type: 'vector',
        kind: 'fill',
        bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 },
        ctm: [1, 0, 0, 1, 0, 0],
        inGroup: { subtype: 'Luminosity', depth: 1, beginIndex: 0 },
        index: 1,
      },
    ];
    const regions = buildVectorRegions(events, 1, PAGE_BOX);
    expect(regions[0]!.groupSubtype).toBe('Luminosity');
  });

  it('ignoruje eventy nie-vector', () => {
    const events: WalkEvent[] = [{ type: 'font', fontName: 'F1', sizeFromMatrix: 12, index: 0 }];
    expect(buildVectorRegions(events, 1, PAGE_BOX)).toHaveLength(0);
  });
});
