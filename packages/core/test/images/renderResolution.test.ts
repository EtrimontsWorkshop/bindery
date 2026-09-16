import { describe, expect, it } from 'vitest';
import { computeTargetLongEdgePx } from '../../src/images/renderResolution.js';

describe('computeTargetLongEdgePx', () => {
  it('region czysto wektorowy (brak obrazu) uzywa wartosci domyslnej z ustawien, bez minimum kategorii', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [],
      representativeMaxRelativeArea: null,
      defaultLongEdgePx: 1500,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(1500);
  });

  it('region czysto wektorowy przycinany do sufitu z ustawien', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [],
      representativeMaxRelativeArea: null,
      defaultLongEdgePx: 5000,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(4096);
  });

  it('obraz "scene-like" (duza powierzchnia) z natywna rozdzielczoscia PONIZEJ minimum -> podniesione do minimum sceny', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [800],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(2048); // MIN_SCENE_LONG_EDGE_PX
  });

  it('obraz "scene-like" z natywna rozdzielczoscia POWYZEJ minimum -> odwzorowanie zrodla (z marginesem), nie stala', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [3000],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBeGreaterThan(3000); // 3000 * SAFETY_MARGIN (1.15) = 3450
    expect(px).toBeLessThanOrEqual(4096);
  });

  it('obraz "handout-like" (powierzchnia srednia) dostaje nizsze minimum niz "scene-like"', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [500],
      representativeMaxRelativeArea: 0.2,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(1024); // MIN_HANDOUT_LONG_EDGE_PX
  });

  it('obraz "portrait-like" (mala powierzchnia) dostaje najnizsze minimum', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [300],
      representativeMaxRelativeArea: 0.02,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(512); // MIN_PORTRAIT_LONG_EDGE_PX
  });

  it('bardzo wysoka natywna rozdzielczosc jest przycinana do sufitu z ustawien (ochrona przed absurdalnym rozmiarem)', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [8000],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBe(4096);
  });

  it('uzywa NAJWIEKSZEJ z natywnych krawedzi w regionie (klaster wielu obrazow)', () => {
    const px = computeTargetLongEdgePx({
      intrinsicLongEdgesPx: [500, 3500, 900],
      representativeMaxRelativeArea: 0.6,
      defaultLongEdgePx: 2048,
      maxLongEdgePx: 4096,
    });
    expect(px).toBeGreaterThan(3500);
  });
});
