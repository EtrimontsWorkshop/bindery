import { describe, expect, it } from 'vitest';
import { findNearestImage, type ImageCandidate } from '../../../src/statblock/import/nearestImage.js';
import type { DetectionRegion } from '../../../src/statblock/pdf/types.js';

function region(pageNumber: number, bbox = { minX: 100, minY: 100, maxX: 200, maxY: 200 }): DetectionRegion {
  return { pageNumber, bbox };
}

function image(id: string, pageNumber: number, bbox: ImageCandidate['bbox']): ImageCandidate {
  return { id, pageNumber, bbox };
}

describe('findNearestImage', () => {
  it('picks the closest image on the same page', () => {
    const images = [image('far', 1, { minX: 500, minY: 500, maxX: 600, maxY: 600 }), image('near', 1, { minX: 210, minY: 100, maxX: 250, maxY: 150 })];
    expect(findNearestImage([region(1)], images)).toBe('near');
  });

  it('ignores images on a different page, even if numerically closer', () => {
    const images = [image('other-page', 2, { minX: 100, minY: 100, maxX: 101, maxY: 101 }), image('same-page', 1, { minX: 300, minY: 300, maxX: 400, maxY: 400 })];
    expect(findNearestImage([region(1)], images)).toBe('same-page');
  });

  it('returns undefined when there is no image at all', () => {
    expect(findNearestImage([region(1)], [])).toBeUndefined();
  });

  it('returns undefined when no image is on the instance\'s own page', () => {
    expect(findNearestImage([region(1)], [image('wrong-page', 2, { minX: 0, minY: 0, maxX: 10, maxY: 10 })])).toBeUndefined();
  });

  it('returns undefined for a candidate with no regions at all', () => {
    expect(findNearestImage([], [image('a', 1, { minX: 0, minY: 0, maxX: 10, maxY: 10 })])).toBeUndefined();
  });

  it('uses the FIRST region when a candidate spans several (same precedent as computeCandidateConfidence)', () => {
    const regions = [region(1, { minX: 0, minY: 0, maxX: 10, maxY: 10 }), region(2, { minX: 0, minY: 0, maxX: 10, maxY: 10 })];
    const images = [image('page1', 1, { minX: 20, minY: 0, maxX: 30, maxY: 10 }), image('page2', 2, { minX: 20, minY: 0, maxX: 30, maxY: 10 })];
    expect(findNearestImage(regions, images)).toBe('page1');
  });
});
