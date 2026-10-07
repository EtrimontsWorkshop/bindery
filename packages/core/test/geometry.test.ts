import { describe, expect, it } from 'vitest';
import { inscribedRotatedRectScale } from '../src/geometry.js';

/**
 * A verification INDEPENDENT of the formula in `inscribedRotatedRectScale`: for a given `s`, it
 * checks geometrically, directly (rotating the corners of the rectangle `s*width x s*height` BACK by
 * `angleRad`), that ALL 4 corners land inside the original, unrotated rectangle `width x height`
 * (with a small tolerance margin for floating-point error) — exactly the same pattern as the rest
 * of this project's tests ("don't check the production formula against itself").
 */
function fitsInsideRotatedOriginal(width: number, height: number, angleRad: number, s: number): boolean {
  const a = width / 2;
  const b = height / 2;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const EPS = 1e-6;
  const corners: Array<[number, number]> = [
    [s * a, s * b],
    [s * a, -s * b],
    [-s * a, s * b],
    [-s * a, -s * b],
  ];
  return corners.every(([x, y]) => {
    const localX = cos * x + sin * y;
    const localY = -sin * x + cos * y;
    return Math.abs(localX) <= a + EPS && Math.abs(localY) <= b + EPS;
  });
}

describe('inscribedRotatedRectScale', () => {
  it('angle=0 -> the full size (s=1), regardless of the aspect ratio', () => {
    expect(inscribedRotatedRectScale(100, 50, 0)).toBeCloseTo(1, 10);
    expect(inscribedRotatedRectScale(50, 100, 0)).toBeCloseTo(1, 10);
    expect(inscribedRotatedRectScale(100, 100, 0)).toBeCloseTo(1, 10);
  });

  it('[a known geometric result] a square rotated by 45° -> s=1/√2', () => {
    expect(inscribedRotatedRectScale(100, 100, Math.PI / 4)).toBeCloseTo(1 / Math.sqrt(2), 10);
  });

  it('[a directly computed example] a 2:1 rectangle rotated by 90° -> s=0.5 (the longest edge must fit in the shortest)', () => {
    expect(inscribedRotatedRectScale(100, 50, Math.PI / 2)).toBeCloseTo(0.5, 10);
    expect(inscribedRotatedRectScale(50, 100, Math.PI / 2)).toBeCloseTo(0.5, 10);
  });

  it('symmetric with respect to the sign of the angle (a left/right rotation by the same angle gives the same result)', () => {
    const s1 = inscribedRotatedRectScale(120, 80, 0.3);
    const s2 = inscribedRotatedRectScale(120, 80, -0.3);
    expect(s1).toBeCloseTo(s2, 10);
  });

  it('decreases monotonically with an increasing angle in the range of SMALL angles [0°, 30°] — the only range this project actually uses (the #rotateImage step is a constant 10°)', () => {
    const angles = [0, 5, 10, 15, 20, 25, 30].map((deg) => (deg * Math.PI) / 180);
    const scales = angles.map((a) => inscribedRotatedRectScale(200, 120, a));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeLessThanOrEqual(scales[i - 1]! + 1e-9);
    }
    expect(scales[0]).toBeCloseTo(1, 10);
  });

  it('[found while writing this test] it is NOT monotonic over the whole [0°,90°] for rectangles with aspect ratios far from a square — the minimum falls around 55-65°, then s INCREASES up to 90° (physically sensible: at 90° the "long" side fits easier again into the swapped dimensions of the envelope). The test documents this fact explicitly, so nobody later "fixes" the formula in reaction to a seemingly strange result.', () => {
    const s60 = inscribedRotatedRectScale(200, 120, (60 * Math.PI) / 180);
    const s90 = inscribedRotatedRectScale(200, 120, (90 * Math.PI) / 180);
    expect(s90).toBeGreaterThan(s60);
    expect(s90).toBeCloseTo(0.6, 6);
  });

  it('never exceeds 1 (degenerate/zero dimensions)', () => {
    expect(inscribedRotatedRectScale(0, 100, 0.2)).toBeLessThanOrEqual(1);
    expect(inscribedRotatedRectScale(100, 0, 0.2)).toBeLessThanOrEqual(1);
  });

  it('[independent verification] for a realistic rotation step (10°) on a typical 3:4 page, the result really fits ENTIRELY in the original', () => {
    const width = 900;
    const height = 1200;
    const angleRad = (10 * Math.PI) / 180;
    const s = inscribedRotatedRectScale(width, height, angleRad);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThan(0.7);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
    // A "tight" result — enlarging it by a thousandth should no longer fit.
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s * 1.001)).toBe(false);
  });

  it('[independent verification] also works correctly for aspect ratios wider than tall (landscape)', () => {
    const width = 1600;
    const height = 900;
    const angleRad = (25 * Math.PI) / 180;
    const s = inscribedRotatedRectScale(width, height, angleRad);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s * 1.001)).toBe(false);
  });

  describe('[a fix for a reported bug — "after 36 rotations by 10° the image shrinks" also revealed that for angles > 90° the old version gave NEGATIVE, meaningless results] angles outside [-90°,90°]', () => {
    const width = 900;
    const height = 1200;

    it('170°/190°/350° give a POSITIVE result that really fits in the original (before the fix: negative)', () => {
      for (const deg of [170, 190, 350]) {
        const angleRad = (deg * Math.PI) / 180;
        const s = inscribedRotatedRectScale(width, height, angleRad);
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
      }
    });

    it('a period of 180° (the central symmetry of a rectangle): 10°, 170°(=180-10), 190°(=180+10) and -170°(=10-180) give EXACTLY the same result as 10°', () => {
      const base = inscribedRotatedRectScale(width, height, (10 * Math.PI) / 180);
      for (const deg of [170, 190, -170, 350, -350]) {
        expect(inscribedRotatedRectScale(width, height, (deg * Math.PI) / 180)).toBeCloseTo(base, 10);
      }
    });

    it('multiple full rotations (725° = 2*360°+5°) reduce correctly to the angle 5°', () => {
      const base = inscribedRotatedRectScale(width, height, (5 * Math.PI) / 180);
      expect(inscribedRotatedRectScale(width, height, (725 * Math.PI) / 180)).toBeCloseTo(base, 10);
      expect(inscribedRotatedRectScale(width, height, (-715 * Math.PI) / 180)).toBeCloseTo(base, 10);
    });

    it('angle=360° (a full rotation) -> s=1, EXACTLY like angle=0° — key for "36 clicks of 10° returns to the original" (`#rotateImage` normalizes the total angle modulo 360° in degrees, so in practice it always passes 0°, but this function MUST also be correct directly for 360° on its own)', () => {
      expect(inscribedRotatedRectScale(width, height, 2 * Math.PI)).toBeCloseTo(1, 10);
    });
  });
});
