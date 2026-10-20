import { describe, expect, it } from 'vitest';
import { extendToEdgeOrnaments, splitUnitsOfDistinctPictures, textCoverage, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
import type { ClassifiedImage } from '../../src/images/classify.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { Rect } from '../../src/geometry.js';

function entry(objId: string, bbox: Rect, maxRelativeArea: number): ImageEntry {
  return {
    objId,
    occurrences: [{ page: 1, bbox, index: 0 }],
    pageRefs: [1],
    maxRelativeArea,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: 500,
    intrinsicHeight: 400,
  };
}

const classify = (e: ImageEntry, classification: ClassifiedImage['classification'] = 'content'): ClassifiedImage => ({ entry: e, classification, reason: 'Z2-moderate-area-no-mask-evidence', confidence: 0.5 });

function unitOf(members: ImageEntry[], rep: ImageEntry): ExtractionUnit {
  const bbox = members.map((m) => m.occurrences[0]!.bbox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
  return { representativeEntry: rep, memberEntries: members, page: 1, bbox, clusterMemberCount: members.length, classification: 'content', confidence: 0.5, reason: 'Z2-moderate-area-no-mask-evidence' };
}

const maskedAll = new Set(['photoA', 'photoB', 'note', 'tape', 'smallContent', 'smallUndecided', 'backdrop']);
const BIG_A = entry('photoA', { minX: 40, minY: 400, maxX: 560, maxY: 750 }, 0.35);
const BIG_B = entry('photoB', { minX: 60, minY: 470, maxX: 565, maxY: 770 }, 0.32);
const NOTE = entry('note', { minX: 276, minY: 360, maxX: 567, maxY: 529 }, 0.1);
const TAPE = entry('tape', { minX: 500, minY: 740, maxX: 580, maxY: 790 }, 0.02);

describe('splitUnitsOfDistinctPictures', () => {
  const classified = (entries: ImageEntry[]) => new Map(entries.map((e) => [e, classify(e)]));

  it('splits a unit with two or more significant solid pictures into one unit per picture, leaving out the tape', () => {
    const unit = unitOf([BIG_A, BIG_B, TAPE], BIG_A);
    const result = splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B, TAPE]), maskedAll);
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB']);
    expect(result.every((u) => u.clusterMemberCount === 1 && u.memberEntries.length === 1)).toBe(true);
    expect(result[1]!.bbox).toEqual(BIG_B.occurrences[0]!.bbox);
  });

  it('splits a full-page illustration from the pieces of its title banner even when the pieces are just under 5% of the page (they grow with the title)', () => {
    const illustration = entry('illustration', { minX: 30, minY: 30, maxX: 582, maxY: 698 }, 0.76);
    const plaque = entry('plaque', { minX: 143, minY: 645, maxX: 469, maxY: 776 }, 0.08);
    const capLeft = entry('capLeft', { minX: 100, minY: 645, maxX: 150, maxY: 776 }, 0.0498);
    const capRight = entry('capRight', { minX: 460, minY: 645, maxX: 510, maxY: 776 }, 0.0495);
    const masked = new Set(['plaque', 'capLeft', 'capRight']);
    const unit = unitOf([illustration, plaque, capLeft, capRight], illustration);
    const result = splitUnitsOfDistinctPictures([unit], classified([illustration, plaque, capLeft, capRight]), masked);
    expect(result[0]!.representativeEntry?.objId).toBe('illustration');
    expect(result[0]!.memberEntries).toHaveLength(1);
    // The same pieces under a smaller picture (a photo with a note and tape) do not split the unit.
    const photo = entry('photo', { minX: 40, minY: 400, maxX: 300, maxY: 700 }, 0.22);
    const note = entry('note', { minX: 250, minY: 600, maxX: 400, maxY: 700 }, 0.0453);
    const photoUnit = unitOf([photo, note], photo);
    expect(splitUnitsOfDistinctPictures([photoUnit], classified([photo, note]), new Set(['photo', 'note']))).toEqual([photoUnit]);
  });

  it('splits a card of text from a portrait that it only partly covers, and keeps a card whole when the picture lies on it (a photo on a newspaper)', () => {
    const portrait = entry('portrait', { minX: 68, minY: 303, maxX: 294, maxY: 608 }, 0.142);
    const card = entry('card', { minX: 53, minY: 90, maxX: 307, maxY: 367 }, 0.145);
    const text = new Map([[1, [{ minX: 60, minY: 100, maxX: 300, maxY: 200 }]]]);
    const unit = unitOf([portrait, card], card);
    const result = splitUnitsOfDistinctPictures([unit], classified([portrait, card]), new Set(), text);
    expect(result.map((u) => u.representativeEntry?.objId).sort()).toEqual(['card', 'portrait']);
    const photo = entry('photo', { minX: 70, minY: 200, maxX: 290, maxY: 350 }, 0.12);
    const clipping = unitOf([photo, card], card);
    expect(splitUnitsOfDistinctPictures([clipping], classified([photo, card]), new Set(), text)).toEqual([clipping]);
    // Without the text boxes of the page nothing tells a card from a picture.
    expect(splitUnitsOfDistinctPictures([unit], classified([portrait, card]), new Set())).toEqual([unit]);
  });

  it('keeps a unit with one picture and small decorations as it is', () => {
    const unit = unitOf([BIG_A, TAPE], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A, TAPE]), maskedAll)).toEqual([unit]);
  });

  it('keeps a unit whose pictures are not masked cut-outs (a composition) as it is', () => {
    const unit = unitOf([BIG_A, BIG_B], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B]), new Set())).toEqual([unit]);
  });

  it('splits pictures that are not masked cut-outs when faint backdrops show a layout of figures on panels', () => {
    const backdrop = { ...entry('backdrop', { minX: 30, minY: 390, maxX: 570, maxY: 760 }, 0.3), maxOpacity: 0.2 };
    const unit = unitOf([BIG_A, BIG_B, backdrop], backdrop);
    const result = splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B, backdrop]), new Set());
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB']);
  });

  it('does not count or offer faint backdrops: a backdrop behind one figure is not a second picture', () => {
    const backdrop = { ...entry('backdrop', { minX: 30, minY: 390, maxX: 570, maxY: 760 }, 0.3), maxOpacity: 0.2 };
    const unit = unitOf([BIG_A, backdrop], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A, backdrop]), maskedAll)).toEqual([unit]);
  });

  it('leaves faint backdrops out of the units when the solid pictures are split', () => {
    const backdrop = { ...entry('backdrop', { minX: 30, minY: 390, maxX: 570, maxY: 760 }, 0.3), maxOpacity: 0.2 };
    const unit = unitOf([BIG_A, BIG_B, backdrop], backdrop);
    const result = splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B, backdrop]), maskedAll);
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB']);
  });

  it('offers a split-off picture below 10% of the page only when it is content', () => {
    const smallContent = entry('smallContent', { minX: 100, minY: 100, maxX: 250, maxY: 220 }, 0.07);
    const smallUndecided = entry('smallUndecided', { minX: 300, minY: 100, maxX: 450, maxY: 220 }, 0.07);
    const unit = unitOf([BIG_A, BIG_B, smallContent, smallUndecided], BIG_A);
    const byEntry = new Map<ImageEntry, ClassifiedImage>([
      [BIG_A, classify(BIG_A)],
      [BIG_B, classify(BIG_B)],
      [smallContent, classify(smallContent)],
      [smallUndecided, classify(smallUndecided, 'undecided')],
    ]);
    expect(splitUnitsOfDistinctPictures([unit], byEntry, maskedAll).map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB', 'smallContent']);
  });

  it('gives a split-off picture its own classification', () => {
    const unit = unitOf([BIG_A, NOTE], BIG_A);
    const byEntry = new Map<ImageEntry, ClassifiedImage>([[BIG_A, classify(BIG_A)], [NOTE, classify(NOTE, 'undecided')]]);
    const result = splitUnitsOfDistinctPictures([unit], byEntry, maskedAll);
    expect(result.map((u) => u.classification)).toEqual(['content', 'undecided']);
  });

  it('passes a unit with a single member through', () => {
    const unit = unitOf([BIG_A], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A]), maskedAll)).toEqual([unit]);
  });
});

describe('textCoverage', () => {
  const box: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('is the share of the box covered by text', () => {
    expect(textCoverage(box, [{ minX: 0, minY: 0, maxX: 100, maxY: 30 }])).toBeCloseTo(0.3);
  });

  it('counts text lying inside the box (unlike the crossing check) and sums several blocks', () => {
    expect(textCoverage(box, [{ minX: 10, minY: 10, maxX: 60, maxY: 30 }, { minX: 10, minY: 50, maxX: 60, maxY: 70 }])).toBeCloseTo(0.2);
  });

  it('ignores text outside the box, and is capped at 1', () => {
    expect(textCoverage(box, [{ minX: 200, minY: 0, maxX: 300, maxY: 100 }])).toBe(0);
    expect(textCoverage(box, [box, box])).toBe(1);
  });

  it('is 0 without text or for an empty box', () => {
    expect(textCoverage(box, undefined)).toBe(0);
    expect(textCoverage({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, [box])).toBe(0);
  });
});

describe('extendToEdgeOrnaments', () => {
  const card: Rect = { minX: 53, minY: 78, maxX: 307, maxY: 224 };

  it('takes in the pieces of a frame that straddle the top or bottom edge of a card (a title plaque, a flourish)', () => {
    const plaque: Rect = { minX: 41, minY: 206, maxX: 319, maxY: 247 };
    const flourish: Rect = { minX: 41, minY: 62, maxX: 319, maxY: 103 };
    expect(extendToEdgeOrnaments(card, [plaque, flourish], { minX: 0, minY: 0, maxX: 595, maxY: 842 })).toEqual({ minX: 41, minY: 62, maxX: 319, maxY: 247 });
  });

  it('leaves out what lies inside the card, what only grazes it, what lies beside it and what reaches far past it', () => {
    const inside: Rect = { minX: 100, minY: 100, maxX: 200, maxY: 150 };
    const grazing: Rect = { minX: 212, minY: -3, maxX: 400, maxY: 85 };
    const beside: Rect = { minX: 300, minY: 200, maxX: 420, maxY: 250 };
    const tall: Rect = { minX: 60, minY: 150, maxX: 300, maxY: 400 };
    const footerBand: Rect = { minX: 0, minY: 60, maxX: 595, maxY: 100 };
    expect(extendToEdgeOrnaments(card, [inside, grazing, beside, tall, footerBand], { minX: 0, minY: 0, maxX: 595, maxY: 842 })).toEqual(card);
    // A flourish that would reach into the page margin (a running footer) stays out as well.
    const lowCard: Rect = { minX: 53, minY: 40, maxX: 307, maxY: 200 };
    const footerFlourish: Rect = { minX: 41, minY: 20, maxX: 319, maxY: 61 };
    expect(extendToEdgeOrnaments(lowCard, [footerFlourish], { minX: 0, minY: 0, maxX: 595, maxY: 842 })).toEqual(lowCard);
  });
});
