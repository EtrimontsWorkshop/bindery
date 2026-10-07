import { describe, expect, it } from 'vitest';
import { computeRenderPlan, MAX_OUTPUT_EDGE_PX } from '../../src/images/regionRenderer.js';
import type { Rect } from '../../src/geometry.js';

/** An identity viewport at scale 1 (corresponds to MediaBox [0,0,W,H] without rotation). */
function identityViewportTransform(scale: number): readonly number[] {
  return [scale, 0, 0, -scale, 0, 0]; // Y flipped like in a real pdf.js viewport (PDF: Y up, canvas: Y down)
}

describe('computeRenderPlan', () => {
  it('scales so that the longer edge of the bbox reaches targetLongEdgePx', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 50 }; // width 100 > height 50
    const plan = computeRenderPlan(identityViewportTransform, bbox, 1000);
    expect(plan.outWidth).toBe(1000);
    expect(plan.outHeight).toBe(500);
  });

  it('preserves the proportions when the height is greater than the width', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 50, maxY: 200 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 800);
    expect(plan.outWidth).toBe(200);
    expect(plan.outHeight).toBe(800);
  });

  it('clamps to MAX_OUTPUT_EDGE_PX when targetLongEdgePx exceeds it', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 10000);
    expect(plan.outWidth).toBeLessThanOrEqual(MAX_OUTPUT_EDGE_PX);
    expect(plan.outHeight).toBeLessThanOrEqual(MAX_OUTPUT_EDGE_PX);
    expect(Math.max(plan.outWidth, plan.outHeight)).toBe(MAX_OUTPUT_EDGE_PX);
  });

  it('the offset corresponds to the top-left corner of the bbox in device space at the computed scale', () => {
    const bbox: Rect = { minX: 10, minY: 10, maxX: 110, maxY: 60 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 1000);
    // Y flipped: the top edge of the page (Y=60, larger Y in PDF) maps to a SMALLER device Y.
    expect(plan.offsetX).toBeCloseTo(10 * plan.scale, 5);
    expect(plan.offsetY).toBeCloseTo(-60 * plan.scale, 5);
  });

  it('throws a readable error for a bbox degenerated to a point (zero length and width)', () => {
    const bbox: Rect = { minX: 10, minY: 10, maxX: 10, maxY: 10 };
    expect(() => computeRenderPlan(identityViewportTransform, bbox, 1000)).toThrow(/zero or negative/);
  });

  it('the result >= 1px even for a very small bbox at a low targetLongEdgePx', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 0.0001);
    expect(plan.outWidth).toBeGreaterThanOrEqual(1);
    expect(plan.outHeight).toBeGreaterThanOrEqual(1);
  });
});
