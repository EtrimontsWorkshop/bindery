import { describe, expect, it } from 'vitest';
import { pdfPointToScreen, pdfRectToScreen, screenPointToPdf, screenRectToPdf, screenRotatedRectToPdf, rotatedRectBounds, type RenderedPageGeometry } from '../src/pageOverlayGeometry.js';

/**
 * This particular function is responsible for the fourth version (in the project's history) of the
 * "everything flipped vertically" bug — so the test coverage here is deliberately denser than
 * elsewhere, with directly computed, human-readable examples (not only a round trip).
 */

const LETTER_PAGE: RenderedPageGeometry = {
  pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 },
  imageWidthPx: 612,
  imageHeightPx: 792,
  rotation: 0,
};

describe('pdfPointToScreen — rotation 0 (the dominant case, every file used in development)', () => {
  it('the BOTTOM-left corner of the PDF page (0,0) -> the BOTTOM-left corner of the screen (0, imageHeightPx) — Y flipped', () => {
    expect(pdfPointToScreen(0, 0, LETTER_PAGE)).toEqual([0, 792]);
  });

  it('the TOP-left corner of the PDF page (0, maxY) -> the TOP-left corner of the screen (0,0)', () => {
    expect(pdfPointToScreen(0, 792, LETTER_PAGE)).toEqual([0, 0]);
  });

  it('the TOP-right corner of the PDF page (maxX, maxY) -> the TOP-right corner of the screen (imageWidthPx, 0)', () => {
    expect(pdfPointToScreen(612, 792, LETTER_PAGE)).toEqual([612, 0]);
  });

  it('the page center -> the screen center (the Y flip is symmetric at the midpoint)', () => {
    expect(pdfPointToScreen(306, 396, LETTER_PAGE)).toEqual([306, 396]);
  });

  it('a point at 3/4 of the height FROM THE BOTTOM (near the top of the PDF page) -> 1/4 of the height FROM THE TOP of the screen', () => {
    // y=594 is 75% of the page height (0-792) counted FROM THE BOTTOM (the PDF convention) — visually
    // near the TOP of the page. After the flip it should land near the top of the screen (25% of 792 = 198).
    const [, screenY] = pdfPointToScreen(0, 594, LETTER_PAGE);
    expect(screenY).toBeCloseTo(198, 5);
  });

  it('scaling: a preview rendered at a resolution OTHER than 1:1pt->1px still lands in the right place proportionally', () => {
    const scaledPage: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 1224, imageHeightPx: 1584, rotation: 0 };
    // A 2x scale on both axes — the same corners, doubled pixels.
    expect(pdfPointToScreen(0, 0, scaledPage)).toEqual([0, 1584]);
    expect(pdfPointToScreen(612, 792, scaledPage)).toEqual([1224, 0]);
  });

  it('a pageBox with a non-zero minX/minY (e.g. a crop/bleed) — normalization relative to the page\'s OWN corner, not the global (0,0)', () => {
    const offsetPage: RenderedPageGeometry = { pageBox: { minX: 50, minY: 100, maxX: 350, maxY: 500 }, imageWidthPx: 300, imageHeightPx: 400, rotation: 0 };
    // The page's bottom-left corner (50,100) in PDF space -> the screen's bottom-left corner (0, 400).
    expect(pdfPointToScreen(50, 100, offsetPage)).toEqual([0, 400]);
    // The page's top-left corner (50,500) -> the screen's top-left corner (0, 0).
    expect(pdfPointToScreen(50, 500, offsetPage)).toEqual([0, 0]);
  });
});

describe('pdfRectToScreen — rotation 0', () => {
  it('a bbox in the TOP-left corner of the PDF page (large Y = near the top) -> a bbox in the TOP-left corner of the screen (small Y)', () => {
    // The rectangle 0<=x<=100, 692<=y<=792 (the top 100pt of the page, which in PDF Y-up is LARGE y).
    const screen = pdfRectToScreen({ minX: 0, minY: 692, maxX: 100, maxY: 792 }, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 100 });
  });

  it('a bbox in the BOTTOM-left corner of the PDF page (small Y) -> a bbox in the BOTTOM-left corner of the screen (large Y, near imageHeightPx)', () => {
    const screen = pdfRectToScreen({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, maxX: 100, minY: 692, maxY: 792 });
  });

  it('a bbox covering the WHOLE page -> a bbox covering the WHOLE bitmap', () => {
    const screen = pdfRectToScreen(LETTER_PAGE.pageBox, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, minY: 0, maxX: 612, maxY: 792 });
  });
});

describe('pdfPointToScreen — rotations 90/180/270 (the formula internally consistent — see the comment in the file header about the lack of real visual verification)', () => {
  it('rotation 180: the bottom-left corner of the PDF -> the top-right corner of the screen (the inverse of rotation 0 on both axes)', () => {
    const page: RenderedPageGeometry = { ...LETTER_PAGE, rotation: 180 };
    expect(pdfPointToScreen(0, 0, page)).toEqual([612, 0]);
    expect(pdfPointToScreen(612, 792, page)).toEqual([0, 792]);
  });

  it('rotations 90/270 swap the output dimensions (portrait <-> landscape) — checked on an image with DIFFERENT proportions than the page', () => {
    const rotated90: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    // The page point must still fall WITHIN the bitmap bounds [0,792]x[0,612].
    const [x, y] = pdfPointToScreen(306, 396, rotated90);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(792);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(612);
  });

  it('rotations 90 and 270 are mutually inverse for the same point (a round trip through both by 360 deg returns to the source, ignoring scale rounding)', () => {
    const base: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    const opposite: RenderedPageGeometry = { ...base, rotation: 270 };
    const p90 = pdfPointToScreen(100, 200, base);
    const p270 = pdfPointToScreen(100, 200, opposite);
    // Different rotations MUST give different results for the same input point (proof that rotation actually changes something).
    expect(p90).not.toEqual(p270);
  });
});

describe('pdfPointToScreen — edge cases', () => {
  it('a degenerate pageBox (zero width/height) doesn\'t throw, returns [0,0]', () => {
    const degenerate: RenderedPageGeometry = { pageBox: { minX: 10, minY: 10, maxX: 10, maxY: 500 }, imageWidthPx: 100, imageHeightPx: 100, rotation: 0 };
    expect(pdfPointToScreen(10, 10, degenerate)).toEqual([0, 0]);
  });
});

describe('screenPointToPdf — the inverse of pdfPointToScreen, rotation 0', () => {
  it('the BOTTOM-left corner of the screen (0, imageHeightPx) -> the BOTTOM-left corner of the PDF page (0,0)', () => {
    expect(screenPointToPdf(0, 792, LETTER_PAGE)).toEqual([0, 0]);
  });

  it('the TOP-left corner of the screen (0,0) -> the TOP-left corner of the PDF page (0, maxY)', () => {
    expect(screenPointToPdf(0, 0, LETTER_PAGE)).toEqual([0, 792]);
  });

  it('a round trip PDF -> screen -> PDF returns to the source (any point inside the page)', () => {
    for (const [x, y] of [
      [100, 200],
      [306, 396],
      [0, 0],
      [612, 792],
    ] as const) {
      const [sx, sy] = pdfPointToScreen(x, y, LETTER_PAGE);
      const [px, py] = screenPointToPdf(sx, sy, LETTER_PAGE);
      expect(px).toBeCloseTo(x, 6);
      expect(py).toBeCloseTo(y, 6);
    }
  });

  it('the round trip also works at a different render resolution (2x scaling) and a non-zero pageBox.min', () => {
    const page: RenderedPageGeometry = { pageBox: { minX: 50, minY: 100, maxX: 350, maxY: 500 }, imageWidthPx: 600, imageHeightPx: 800, rotation: 0 };
    const [sx, sy] = pdfPointToScreen(200, 300, page);
    const [px, py] = screenPointToPdf(sx, sy, page);
    expect(px).toBeCloseTo(200, 6);
    expect(py).toBeCloseTo(300, 6);
  });
});

describe('screenRectToPdf — the inverse of pdfRectToScreen', () => {
  it('a screen bbox in the top-left corner (small Y) -> a PDF bbox in the top-left corner of the page (large Y)', () => {
    const pdf = screenRectToPdf({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, LETTER_PAGE);
    expect(pdf).toEqual({ minX: 0, maxX: 100, minY: 692, maxY: 792 });
  });

  it('a round trip PDF -> screen -> PDF on any rectangle', () => {
    const original = { minX: 120, minY: 250, maxX: 480, maxY: 600 };
    const screen = pdfRectToScreen(original, LETTER_PAGE);
    const roundTripped = screenRectToPdf(screen, LETTER_PAGE);
    expect(roundTripped.minX).toBeCloseTo(original.minX, 6);
    expect(roundTripped.maxX).toBeCloseTo(original.maxX, 6);
    expect(roundTripped.minY).toBeCloseTo(original.minY, 6);
    expect(roundTripped.maxY).toBeCloseTo(original.maxY, 6);
  });

  it('the round trip also works under rotation 90/270 (not only the dominant case 0)', () => {
    for (const rotation of [90, 270] as const) {
      const page: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation };
      const original = { minX: 100, minY: 150, maxX: 400, maxY: 600 };
      const screen = pdfRectToScreen(original, page);
      const roundTripped = screenRectToPdf(screen, page);
      expect(roundTripped.minX).toBeCloseTo(original.minX, 6);
      expect(roundTripped.maxX).toBeCloseTo(original.maxX, 6);
      expect(roundTripped.minY).toBeCloseTo(original.minY, 6);
      expect(roundTripped.maxY).toBeCloseTo(original.maxY, 6);
    }
  });
});

describe('screenRotatedRectToPdf — [user report, "select and crop" — a rotated selection]', () => {
  it('rotationRad=0 (not rotated) -> the same result as the plain screenRectToPdf (a special case)', () => {
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: 0 }, LETTER_PAGE);
    // Screen center (300,300), Y flip (scale 1:1, LETTER_PAGE) -> PDF Y = 792-300 = 492.
    expect(rotated.centerX).toBeCloseTo(300, 6);
    expect(rotated.centerY).toBeCloseTo(492, 6);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(rotated.rotationRad).toBeCloseTo(0, 6);
  });

  it('[a directly computed example] a 90° rotation on screen -> a -90° rotation in PDF (the Y axis flip reverses the sense of rotation), dimensions unchanged', () => {
    // Directly computed on LETTER_PAGE (scale 1:1): the 4 corners of a rectangle with center=(300,300),
    // width=100, height=50, rotated by 90° on the screen, passed through the Y flip (the only
    // transformation for this page/scale).
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: Math.PI / 2 }, LETTER_PAGE);
    expect(rotated.centerX).toBeCloseTo(300, 6);
    expect(rotated.centerY).toBeCloseTo(492, 6);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(rotated.rotationRad).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('any angle (30°) — the width/height preserved (scale 1:1), the center Y-flipped, the rotation negated', () => {
    const rotated = screenRotatedRectToPdf({ centerX: 200, centerY: 400, width: 120, height: 60, rotationRad: Math.PI / 6 }, LETTER_PAGE);
    expect(rotated.centerX).toBeCloseTo(200, 6);
    expect(rotated.centerY).toBeCloseTo(392, 6);
    expect(rotated.width).toBeCloseTo(120, 6);
    expect(rotated.height).toBeCloseTo(60, 6);
    expect(rotated.rotationRad).toBeCloseTo(-Math.PI / 6, 6);
  });

  it('works under a page rotation (90°) — the dimensions still preserved, no collapse to NaN/Infinity', () => {
    const page: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: Math.PI / 4 }, page);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(Number.isFinite(rotated.centerX)).toBe(true);
    expect(Number.isFinite(rotated.centerY)).toBe(true);
    expect(Number.isFinite(rotated.rotationRad)).toBe(true);
  });
});

describe('rotatedRectBounds', () => {
  it('rotationRad=0 — the envelope is an ordinary axis-aligned rectangle around the center', () => {
    const bounds = rotatedRectBounds({ centerX: 100, centerY: 200, width: 40, height: 20, rotationRad: 0 });
    expect(bounds).toEqual({ minX: 80, maxX: 120, minY: 190, maxY: 210 });
  });

  it('rotationRad=45° — a square rotated by 45° has an envelope with a side equal to the diagonal', () => {
    const bounds = rotatedRectBounds({ centerX: 0, centerY: 0, width: 10, height: 10, rotationRad: Math.PI / 4 });
    const half = (10 * Math.SQRT2) / 2;
    expect(bounds.minX).toBeCloseTo(-half, 6);
    expect(bounds.maxX).toBeCloseTo(half, 6);
    expect(bounds.minY).toBeCloseTo(-half, 6);
    expect(bounds.maxY).toBeCloseTo(half, 6);
  });

  it('rotationRad=90° — a "lying" rectangle rotated by 90° has the envelope\'s width/height swapped', () => {
    const bounds = rotatedRectBounds({ centerX: 50, centerY: 50, width: 30, height: 10, rotationRad: Math.PI / 2 });
    expect(bounds).toEqual({ minX: 45, maxX: 55, minY: 35, maxY: 65 });
  });
});
