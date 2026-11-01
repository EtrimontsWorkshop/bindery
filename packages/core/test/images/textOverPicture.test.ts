import { describe, expect, it } from 'vitest';
import { isSmallPieceBesideRepresentative, isTextOverPicture, textCrossingShare, topOccurrenceOnPage, looksLikePlainTextCard, pickUnitRepresentative } from '../../src/images/buildImageExtraction.js';
import { isTranslucentEverywhere, type ClassifiedImage } from '../../src/images/classify.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { Rect } from '../../src/geometry.js';

function entry(objId: string, maxRelativeArea: number, maxOpacity?: number): ImageEntry {
  return {
    objId,
    occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: 100,
    intrinsicHeight: 100,
    ...(maxOpacity === undefined ? {} : { maxOpacity }),
  };
}

const box: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const textHalf: Rect[] = [{ minX: 0, minY: 0, maxX: 100, maxY: 50 }];
const textNone: Rect[] = [{ minX: 200, minY: 0, maxX: 300, maxY: 50 }];

describe('isTextOverPicture', () => {
  it('text covering 30% or more of an ordinary picture is part of it (a paper note)', () => {
    expect(isTextOverPicture('Z2-moderate-area-no-mask-evidence', entry('a', 0.2), box, textHalf)).toBe(true);
    expect(isTextOverPicture('Z2-moderate-area-no-mask-evidence', entry('a', 0.2), box, textNone)).toBe(false);
  });

  it('a Z10 picture (text over the centre) always counts', () => {
    expect(isTextOverPicture('Z10-high-center-text-coverage', entry('a', 0.2), box, textNone)).toBe(true);
  });

  it('text over a watermark (translucent everywhere) is the page text, not the picture', () => {
    expect(isTextOverPicture('Z1-no-strong-signal', entry('w', 0.07, 0.15), box, textHalf)).toBe(false);
    expect(isTextOverPicture('Z10-high-center-text-coverage', entry('w', 0.27, 0.08), box, textHalf)).toBe(false);
  });

  it('a picture only mildly translucent (above the watermark range) keeps the rule', () => {
    expect(isTextOverPicture('Z10-high-center-text-coverage', entry('p', 0.26, 0.66), box, textHalf)).toBe(true);
  });

  it('a kept picture that bleeds off the page is not a note, whatever covers its box', () => {
    expect(isTextOverPicture('Z12-bleeding-no-center-text-evidence', entry('b', 0.49), box, textHalf)).toBe(false);
  });

  it('a full-bleed background forced to content is not text over a picture', () => {
    expect(isTextOverPicture('Z1-full-bleed-forced-content', entry('f', 0.9), box, textHalf)).toBe(false);
  });
});

describe('isTranslucentEverywhere', () => {
  it('is true up to opacity 0.65 (PDF stores 0.6 as 0.600006) and false when mostly opaque or unknown', () => {
    expect(isTranslucentEverywhere(entry('a', 0.1, 0.6))).toBe(true);
    expect(isTranslucentEverywhere(entry('a', 0.1, 0.600006))).toBe(true);
    expect(isTranslucentEverywhere(entry('a', 0.1, 0.66))).toBe(false);
    expect(isTranslucentEverywhere(entry('a', 0.1, 0.89))).toBe(false);
    expect(isTranslucentEverywhere(entry('a', 0.1))).toBe(false);
  });
});

describe('pickUnitRepresentative', () => {
  const classified = (e: ImageEntry): ClassifiedImage => ({ entry: e, classification: 'undecided', reason: 'Z1-no-strong-signal', confidence: 0.2 });
  const watermark = entry('watermark', 0.083, 0.2);
  const photo = entry('photo', 0.067);
  const tape = entry('tape', 0.007);
  const group = [tape, watermark, photo].map(classified);

  it('a watermark behind a masked photo of consequence gives way to the photo', () => {
    expect(pickUnitRepresentative(group, new Set(['photo'])).entry.objId).toBe('photo');
  });

  it('keeps the watermark when the photo is not a masked picture (a composition)', () => {
    expect(pickUnitRepresentative(group, new Set()).entry.objId).toBe('watermark');
  });

  it('keeps the watermark when the solid picture is below the significant share of the page', () => {
    expect(pickUnitRepresentative([watermark, entry('speck', 0.02)].map(classified), new Set(['speck'])).entry.objId).toBe('watermark');
  });

  it('keeps the largest member when it is painted solid, even if a smaller masked picture exists', () => {
    expect(pickUnitRepresentative([entry('big', 0.2), watermark, photo].map(classified), new Set(['photo'])).entry.objId).toBe('big');
  });

  it('keeps a translucent member that was judged content (an emblem with pieces laid over it)', () => {
    const emblem: ClassifiedImage = { entry: entry('emblem', 0.253, 0.2), classification: 'content', reason: 'Z2-moderate-area-no-mask-evidence', confidence: 0.5 };
    expect(pickUnitRepresentative([emblem, classified(photo)], new Set(['photo'])).entry.objId).toBe('emblem');
  });

  it('a single member is its own representative', () => {
    expect(pickUnitRepresentative([classified(watermark)], new Set()).entry.objId).toBe('watermark');
  });
});

describe('looksLikePlainTextCard', () => {
  it('a smooth opaque panel is a card of the page text; a textured one, a translucent one and an unknown one are not', () => {
    expect(looksLikePlainTextCard({ luminanceStdDev: 20 }, 1)).toBe(true);
    expect(looksLikePlainTextCard({ luminanceStdDev: 45 }, 1)).toBe(false);
    expect(looksLikePlainTextCard({ luminanceStdDev: 20 }, 0.6)).toBe(false);
    expect(looksLikePlainTextCard(null, 1)).toBe(false);
    expect(looksLikePlainTextCard({ luminanceStdDev: 20 }, null)).toBe(false);
  });
});

describe('isSmallPieceBesideRepresentative', () => {
  const rep: Rect = { minX: 0, minY: 100, maxX: 500, maxY: 700 };
  it('an ornament that mostly sticks out of the bottom of a large picture is decoration beside it', () => {
    expect(isSmallPieceBesideRepresentative({ minX: 200, minY: 40, maxX: 400, maxY: 110 }, 0.026, rep, 0.46)).toBe(true);
    expect(isSmallPieceBesideRepresentative({ minX: 200, minY: 300, maxX: 300, maxY: 400 }, 0.02, rep, 0.46)).toBe(false);
  });

  it('a piece with more than half of its box on the picture is a part of it (tape on a photo)', () => {
    expect(isSmallPieceBesideRepresentative({ minX: 450, minY: 650, maxX: 550, maxY: 750 }, 0.02, rep, 0.46)).toBe(true);
    expect(isSmallPieceBesideRepresentative({ minX: 420, minY: 600, maxX: 520, maxY: 720 }, 0.02, rep, 0.46)).toBe(false);
  });

  it('keeps pieces of consequence and small representatives out of the rule', () => {
    expect(isSmallPieceBesideRepresentative({ minX: 200, minY: 0, maxX: 400, maxY: 50 }, 0.06, rep, 0.46)).toBe(false);
    expect(isSmallPieceBesideRepresentative({ minX: 200, minY: 0, maxX: 400, maxY: 50 }, 0.02, rep, 0.1)).toBe(false);
  });
});

describe('textCrossingShare', () => {
  const region: Rect = { minX: 100, minY: 0, maxX: 200, maxY: 100 };
  it('counts the part of a block that the region cuts, not a block that lies wholly inside it', () => {
    expect(textCrossingShare(region, [{ minX: 50, minY: 0, maxX: 150, maxY: 50 }])).toBeCloseTo(0.25);
    expect(textCrossingShare(region, [{ minX: 120, minY: 10, maxX: 180, maxY: 50 }])).toBe(0);
    expect(textCrossingShare(region, [{ minX: 300, minY: 0, maxX: 400, maxY: 50 }])).toBe(0);
    expect(textCrossingShare(region, undefined)).toBe(0);
  });
});

describe('topOccurrenceOnPage', () => {
  const painting = (page: number, index: number, quarterTurns?: 1 | 2 | 3): ImageEntry['occurrences'][number] => ({
    page,
    index,
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    ...(quarterTurns === undefined ? {} : { placement: { rotated: true, quarterTurns } }),
  });

  it('is the painting that lies on top on that page: the last in the paint order', () => {
    const e = { ...entry('a', 0.4), occurrences: [painting(3, 5, 2), painting(3, 9), painting(4, 1, 1)] };
    expect(topOccurrenceOnPage(e, 3)?.index).toBe(9);
    expect(topOccurrenceOnPage(e, 3)?.placement).toBeUndefined();
    expect(topOccurrenceOnPage(e, 4)?.placement?.quarterTurns).toBe(1);
    expect(topOccurrenceOnPage(e, 5)).toBeUndefined();
  });
});

