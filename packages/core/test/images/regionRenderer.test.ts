import { describe, expect, it } from 'vitest';
import { computeRenderPlan, MAX_OUTPUT_EDGE_PX } from '../../src/images/regionRenderer.js';
import type { Rect } from '../../src/geometry.js';

/** Viewport identycznosciowy przy skali 1 (odpowiada MediaBox [0,0,W,H] bez rotacji). */
function identityViewportTransform(scale: number): readonly number[] {
  return [scale, 0, 0, -scale, 0, 0]; // Y odwrocone jak w prawdziwym viewport pdf.js (PDF: Y w gore, canvas: Y w dol)
}

describe('computeRenderPlan', () => {
  it('skaluje tak, ze dluzsza krawedz bboksa osiaga targetLongEdgePx', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 50 }; // szerokosc 100 > wysokosc 50
    const plan = computeRenderPlan(identityViewportTransform, bbox, 1000);
    expect(plan.outWidth).toBe(1000);
    expect(plan.outHeight).toBe(500);
  });

  it('zachowuje proporcje gdy wysokosc jest dluzsza niz szerokosc', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 50, maxY: 200 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 800);
    expect(plan.outWidth).toBe(200);
    expect(plan.outHeight).toBe(800);
  });

  it('przycina do MAX_OUTPUT_EDGE_PX gdy targetLongEdgePx go przekracza', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 10000);
    expect(plan.outWidth).toBeLessThanOrEqual(MAX_OUTPUT_EDGE_PX);
    expect(plan.outHeight).toBeLessThanOrEqual(MAX_OUTPUT_EDGE_PX);
    expect(Math.max(plan.outWidth, plan.outHeight)).toBe(MAX_OUTPUT_EDGE_PX);
  });

  it('offset odpowiada lewemu-gornemu rogowi bboksa w przestrzeni urzadzenia przy obliczonej skali', () => {
    const bbox: Rect = { minX: 10, minY: 10, maxX: 110, maxY: 60 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 1000);
    // Y odwrocone: gorna krawedz strony (Y=60, wieksze Y w PDF) mapuje sie na MNIEJSZE Y urzadzenia.
    expect(plan.offsetX).toBeCloseTo(10 * plan.scale, 5);
    expect(plan.offsetY).toBeCloseTo(-60 * plan.scale, 5);
  });

  it('rzuca czytelny blad dla bboksa zdegenerowanego do punktu (zerowa dlugosc i szerokosc)', () => {
    const bbox: Rect = { minX: 10, minY: 10, maxX: 10, maxY: 10 };
    expect(() => computeRenderPlan(identityViewportTransform, bbox, 1000)).toThrow(/zerowa lub ujemna/);
  });

  it('wynik >= 1px nawet dla bardzo malego bboksa przy niskim targetLongEdgePx', () => {
    const bbox: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const plan = computeRenderPlan(identityViewportTransform, bbox, 0.0001);
    expect(plan.outWidth).toBeGreaterThanOrEqual(1);
    expect(plan.outHeight).toBeGreaterThanOrEqual(1);
  });
});
