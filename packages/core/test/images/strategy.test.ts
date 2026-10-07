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
  it('a single image, no mask, no cluster -> direct', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: false, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('direct');
    expect(decision.reason).toBe('Z2-single-clean-image');
  });

  it('an image with a mask -> region-render (direct extraction would give a version without the mask)', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: true, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-masked-direct-would-omit-mask');
  });

  it('a cluster of overlapping images -> region-render (the composition is the content)', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: false, clusterMemberCount: 4 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-cluster-composition-is-content');
  });

  it('no image (a purely vector region) -> region-render', () => {
    const decision = decideExtractionStrategy({ entry: null, isMasked: false, clusterMemberCount: 1 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-vector-only-no-image');
  });

  it('the mask takes precedence over the cluster when both signals are present', () => {
    const decision = decideExtractionStrategy({ entry: entry(), isMasked: true, clusterMemberCount: 3 });
    expect(decision.strategy).toBe('region-render');
    expect(decision.reason).toBe('Z2-masked-direct-would-omit-mask');
  });
});

describe('computeMaskedObjIds', () => {
  it('collects the objId from masksImageObjId ONLY for entries with hard mask evidence', () => {
    const maskEntry = entry({ objId: 'mask1', maskEvidence: 'group', masksImageObjId: 'target1' });
    const weakEvidenceEntry = entry({ objId: 'mask2', maskEvidence: 'geometry', masksImageObjId: 'target2' });
    const result = computeMaskedObjIds([maskEntry, weakEvidenceEntry]);
    expect(result.has('target1')).toBe(true);
    expect(result.has('target2')).toBe(false);
  });

  it('an empty set when there are no masking entries', () => {
    const result = computeMaskedObjIds([entry()]);
    expect(result.size).toBe(0);
  });
});

describe('computeClusterMemberCounts', () => {
  it('entries sharing a clusterId count together, including themselves', () => {
    const a = entry({ objId: 'a', clusterId: 'p1-c0' });
    const b = entry({ objId: 'b', clusterId: 'p1-c0' });
    const c = entry({ objId: 'c', clusterId: 'p1-c0' });
    const result = computeClusterMemberCounts([a, b, c]);
    expect(result.get(a)).toBe(3);
    expect(result.get(b)).toBe(3);
    expect(result.get(c)).toBe(3);
  });

  it('an entry without a clusterId, or the only one in its cluster, counts as 1', () => {
    const solo = entry({ objId: 'solo', clusterId: 'p1-c1' });
    const noCluster = entry({ objId: 'nc', clusterId: undefined });
    const result = computeClusterMemberCounts([solo, noCluster]);
    expect(result.get(solo)).toBe(1);
    expect(result.get(noCluster)).toBe(1);
  });
});
