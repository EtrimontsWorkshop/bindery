import { describe, expect, it } from 'vitest';
import {
  computeClusterMemberCounts,
  computeMaskedObjIds,
  decideExtractionStrategy,
} from '../../src/images/strategy.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';

function entry(overrides: Partial<ImageEntry> = {}): ImageEntry {
  return {
    objId: 'img1',
    occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea: 0.1,
    isMaskLayer: false,
    maskEvidence: null,
    ...overrides,
  };
}

describe('decideExtractionStrategy', () => {
  it('pojedynczy obraz, brak maski, brak klastra -> direct', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: false, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('direct');
    expect(decision.reason).toBe('Z2-single-clean-image');
  });

  it('obraz z maska -> region-render (bezposrednia ekstrakcja dalaby wersje bez maski)', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: true, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-masked-direct-would-omit-mask');
  });

  it('klaster nakladajacych sie obrazow -> region-render (kompozycja to tresc)', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: false, clusterMemberCount: 4 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-cluster-composition-is-content');
  });

  it('brak obrazu (region czysto wektorowy) -> region-render', () => {
    const decision = decideExtractionStrategy({ entry: null, isMasked: false, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-vector-only-no-image');
  });

  it('maska ma pierwszenstwo nad klastrem, gdy oba sygnaly obecne', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: true, clusterMemberCount: 3 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-masked-direct-would-omit-mask');
  });
});

describe('computeMaskedObjIds', () => {
  it('zbiera objId z masksImageObjId TYLKO dla wpisow z twardym dowodem maski', () => {
    const maskEntry = entry({ objId: 'mask1', maskEvidence: 'group', masksImageObjId: 'target1' });
    const weakEvidenceEntry = entry({ objId: 'mask2', maskEvidence: 'geometry', masksImageObjId: 'target2' });
    const result = computeMaskedObjIds([maskEntry, weakEvidenceEntry]);
    expect(result.has('target1')).toBe(true);
    expect(result.has('target2')).toBe(false);
  });

  it('pusty zbior gdy brak wpisow maskujacych', () => {
    const result = computeMaskedObjIds([entry()]);
    expect(result.size).toBe(0);
  });
});

describe('computeClusterMemberCounts', () => {
  it('wpisy dzielace clusterId licza sie razem, wliczajac siebie', () => {
    const a = entry({ objId: 'a', clusterId: 'p1-c0' });
    const b = entry({ objId: 'b', clusterId: 'p1-c0' });
    const c = entry({ objId: 'c', clusterId: 'p1-c0' });
    const result = computeClusterMemberCounts([a, b, c]);
    expect(result.get(a)).toBe(3);
    expect(result.get(b)).toBe(3);
    expect(result.get(c)).toBe(3);
  });

  it('wpis bez clusterId lub jedyny w swoim klastrze liczy sie jako 1', () => {
    const solo = entry({ objId: 'solo', clusterId: 'p1-c1' });
    const noCluster = entry({ objId: 'nc', clusterId: undefined });
    const result = computeClusterMemberCounts([solo, noCluster]);
    expect(result.get(solo)).toBe(1);
    expect(result.get(noCluster)).toBe(1);
  });
});
