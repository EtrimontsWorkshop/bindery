import { describe, expect, it } from 'vitest';
import { computeTargetLongEdgePx } from '../../src/images/renderResolution.js';

describe('computeTargetLongEdgePx', () => {
  it('a purely vector region (no image) uses the default value from the settings, without a category minimum', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [],
      representativeMaxRelativeArea: null,
      defaultLongEdgePx: 1500,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(1500);
  });

  it('a purely vector region clamped to the ceiling from the settings', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [],
      representativeMaxRelativeArea: null,
      defaultLongEdgePx: 5000,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(4096);
  });

  it('a "scene-like" image (a large area) with a native resolution BELOW the minimum -> raised to the scene minimum', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [800],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(2048); // MIN_SCENE_LONG_EDGE_PX
  });

  it('a "scene-like" image with a native resolution ABOVE the minimum -> a reflection of the source (with a margin), not a constant', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [3000],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBeGreaterThan(3000); // 3000 * SAFETY_MARGIN (1.15) = 3450
    expect(px).toBeLessThanOrEqual(4096);
  });

  it('a "handout-like" image (a medium area) gets a lower minimum than "scene-like"', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [500],
      representativeMaxRelativeArea: 0.2,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(1024); // MIN_HANDOUT_LONG_EDGE_PX
  });

  it('a "portrait-like" image (a small area) gets the lowest minimum', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [300],
      representativeMaxRelativeArea: 0.02,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(512); // MIN_PORTRAIT_LONG_EDGE_PX
  });

  it('a very high native resolution is clamped to the ceiling from the settings (a guard against an absurd size)', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [8000],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(4096);
  });

  it('uses the LARGEST of the native edges in the region (a cluster of many images)', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [500, 3500, 900],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBeGreaterThan(3500);
  });
});
