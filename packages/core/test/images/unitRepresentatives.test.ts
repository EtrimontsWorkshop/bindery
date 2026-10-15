import { describe, expect, it } from 'vitest';
import { alternativeRepresentatives, compositionMembers, isPaperOverlay, withSolidRepresentativeOfBackdrop, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
import { isNeverWorthReviewing } from '../../src/images/finalize.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';

function entry(objId: string, area: number, maxOpacity?: number): ImageEntry {
  return {
    objId,
    occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea: area,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: 100,
    intrinsicHeight: 100,
    ...(maxOpacity !== undefined ? { maxOpacity } : {}),
  };
}

function unitOf(rep: ImageEntry, members: ImageEntry[]): ExtractionUnit {
  return { representativeEntry: rep, memberEntries: members, page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, clusterMemberCount: members.length, classification: 'content', confidence: 0.5, reason: 'Z2-moderate-area-no-mask-evidence' };
}

describe('isPaperOverlay', () => {
  it('a mostly transparent, bright raster (a faded vignette) is an overlay', () => {
    expect(isPaperOverlay({ opaqueFraction: 0.23, meanOpaqueBrightness: 207 })).toBe(true);
  });

  it('a cut-out figure (mostly transparent but dark) is not', () => {
    expect(isPaperOverlay({ opaqueFraction: 0.33, meanOpaqueBrightness: 55 })).toBe(false);
  });

  it('a photo or a sheet of paper (opaque) is not', () => {
    expect(isPaperOverlay({ opaqueFraction: 1, meanOpaqueBrightness: 210 })).toBe(false);
  });
});

describe('alternativeRepresentatives', () => {
  const shape = entry('shape', 0.27, 0.2);
  const figure = entry('figure', 0.071);
  const second = entry('second', 0.12);
  const speck = entry('speck', 0.01);

  it('lists the solid members of consequence, largest first, each as a unit of its own', () => {
    const unit = unitOf(shape, [shape, figure, second, speck]);
    expect(alternativeRepresentatives(unit).map((u) => u.representativeEntry?.objId)).toEqual(['second', 'figure']);
  });

  it('skips the representative, translucent members and small ones', () => {
    expect(alternativeRepresentatives(unitOf(figure, [figure, shape, speck]))).toEqual([]);
  });

  it('offers at most two', () => {
    const many = [entry('a', 0.2), entry('b', 0.19), entry('c', 0.18), entry('d', 0.17)];
    expect(alternativeRepresentatives(unitOf(many[0]!, many))).toHaveLength(2);
  });
});

describe('withSolidRepresentativeOfBackdrop', () => {
  const shape = entry('shape', 0.27, 0.2);
  const figure = entry('figure', 0.071);

  it('a translucent shape behind a solid figure gives way to the figure', () => {
    const unit = unitOf(shape, [shape, figure]);
    expect(withSolidRepresentativeOfBackdrop(unit).representativeEntry?.objId).toBe('figure');
  });

  it('keeps a solid representative, and a translucent one that has no solid member to give way to', () => {
    const solid = unitOf(figure, [figure, shape]);
    expect(withSolidRepresentativeOfBackdrop(solid)).toBe(solid);
    const alone = unitOf(shape, [shape]);
    expect(withSolidRepresentativeOfBackdrop(alone)).toBe(alone);
  });

  it('a faded picture (painted at 50%) is not a backdrop and keeps being the representative', () => {
    const faded = entry('faded', 0.27, 0.5);
    const unit = unitOf(faded, [faded, figure]);
    expect(withSolidRepresentativeOfBackdrop(unit)).toBe(unit);
  });

  it('the unit keeps its classification when the representative changes', () => {
    const unit = unitOf(shape, [shape, figure]);
    expect(withSolidRepresentativeOfBackdrop(unit).classification).toBe('content');
  });
});

describe('compositionMembers', () => {
  const shape = entry('shape', 0.27, 0.2);
  const figure = entry('figure', 0.071);

  it('leaves out translucent members', () => {
    expect(compositionMembers(unitOf(shape, [shape, figure]))).toEqual([figure]);
  });

  it('keeps every member of a unit that has only translucent ones', () => {
    const other = entry('other', 0.1, 0.2);
    expect(compositionMembers(unitOf(shape, [shape, other]))).toEqual([shape, other]);
  });
});

describe('isNeverWorthReviewing', () => {
  const base = { classification: 'undecided' as const, entry: entry('x', 0.1), width: 500, height: 400 };

  it('a smooth background is, a detailed picture is not', () => {
    expect(isNeverWorthReviewing({ ...base, smoothness: { coarseGradient: 0.55, fineGradient: 0.52 } })).toBe(true);
    expect(isNeverWorthReviewing({ ...base, smoothness: { coarseGradient: 8, fineGradient: 4 } })).toBe(false);
  });

  describe('black shapes (a torn black edge along the page)', () => {
    const edge = { ...base, opaqueFraction: 0.7, darkOpaqueShare: 1 };

    it('a raster whose visible pixels are all black is hidden, also when it was judged content', () => {
      expect(isNeverWorthReviewing(edge)).toBe(true);
      expect(isNeverWorthReviewing({ ...edge, classification: 'content' })).toBe(true);
    });

    it('a dark picture with bright details, a barely visible raster and one without the measures are not', () => {
      expect(isNeverWorthReviewing({ ...edge, darkOpaqueShare: 0.9 })).toBe(false);
      expect(isNeverWorthReviewing({ ...edge, opaqueFraction: 0.05 })).toBe(false);
      expect(isNeverWorthReviewing({ ...edge, darkOpaqueShare: undefined })).toBe(false);
    });
  });

  describe('white shapes (a white strip cut from a larger sheet)', () => {
    const strip = { ...base, opaqueFraction: 0.5, whiteOpaqueShare: 1 };

    it('a raster whose visible pixels are all white is hidden', () => {
      expect(isNeverWorthReviewing(strip)).toBe(true);
    });

    it('a picture with white parts, a barely visible raster and one without the measures are not', () => {
      expect(isNeverWorthReviewing({ ...strip, whiteOpaqueShare: 0.8 })).toBe(false);
      expect(isNeverWorthReviewing({ ...strip, opaqueFraction: 0.05 })).toBe(false);
      expect(isNeverWorthReviewing({ ...strip, whiteOpaqueShare: undefined })).toBe(false);
    });
  });

  describe('light paper sheets (a torn scrap under a handout)', () => {
    const scrap = { ...base, opaqueFraction: 1, meanLuminance: 212, visibleLuminanceStdDev: 16, smoothness: { coarseGradient: 3.52, fineGradient: 3.81 } };

    it('an opaque, light, flat and smooth undecided picture is hidden', () => {
      expect(isNeverWorthReviewing(scrap)).toBe(true);
    });

    it('a dark picture as smooth as the scrap (a night scene, a portrait) is not', () => {
      expect(isNeverWorthReviewing({ ...scrap, meanLuminance: 70, visibleLuminanceStdDev: 23 })).toBe(false);
    });

    it('a light picture with detail, a sparse cut-out and an unclassified-but-content picture are not', () => {
      expect(isNeverWorthReviewing({ ...scrap, visibleLuminanceStdDev: 45 })).toBe(false);
      expect(isNeverWorthReviewing({ ...scrap, smoothness: { coarseGradient: 9, fineGradient: 6 } })).toBe(false);
      expect(isNeverWorthReviewing({ ...scrap, opaqueFraction: 0.5 })).toBe(false);
      expect(isNeverWorthReviewing({ ...scrap, classification: 'content' })).toBe(false);
    });

    it('without the pixel measures the rule is skipped', () => {
      expect(isNeverWorthReviewing({ ...scrap, meanLuminance: undefined })).toBe(false);
      expect(isNeverWorthReviewing({ ...scrap, visibleLuminanceStdDev: undefined })).toBe(false);
    });
  });

  it('decoration and masks are never judged', () => {
    expect(isNeverWorthReviewing({ ...base, classification: 'decoration', smoothness: { coarseGradient: 0, fineGradient: 0 } })).toBe(false);
  });
});
