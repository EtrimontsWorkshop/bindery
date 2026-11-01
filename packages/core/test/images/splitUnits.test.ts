import { describe, expect, it } from 'vitest';
import { areSeamedTiles, extendToEdgeOrnaments, isBackdropOfTextBesideRepresentative, isLongStrip, isFlushCardOfText, isPanelBehindFigure, isSmallCardOfText, isTextPanel, splitUnitsOfDistinctPictures, textCoverage, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
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

  it('offers a split-off picture below 10% of the page when it is content or lies clear of the pictures, but not an undecided one that sits on them', () => {
    const smallContent = entry('smallContent', { minX: 100, minY: 100, maxX: 250, maxY: 220 }, 0.07);
    const smallUndecided = entry('smallUndecided', { minX: 300, minY: 450, maxX: 450, maxY: 570 }, 0.07);
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

describe('splitUnitsOfDistinctPictures — pictures in frames of their own', () => {
  const framed = (objId: string, raster: Rect, frame: Rect): ImageEntry => ({
    ...entry(objId, raster, 0.14),
    occurrences: [{ page: 1, bbox: raster, index: 0, clip: { paths: [[[frame.minX, frame.minY, frame.maxX, frame.minY, frame.maxX, frame.maxY, frame.minX, frame.maxY]]], ctm: [1, 0, 0, 1, 0, 0] } }],
  });
  const classified = (entries: ImageEntry[]) => new Map(entries.map((e) => [e, classify(e)]));

  it('splits three plans whose rasters overlap but whose frames do not', () => {
    const top = framed('top', { minX: 255, minY: 35, maxX: 569, maxY: 253 }, { minX: 255, minY: 35, maxX: 568, maxY: 236 });
    const middle = framed('middle', { minX: 265, minY: 208, maxX: 579, maxY: 423 }, { minX: 266, minY: 241, maxX: 578, maxY: 406 });
    const bottom = framed('bottom', { minX: 272, minY: 379, maxX: 584, maxY: 555 }, { minX: 273, minY: 412, maxX: 583, maxY: 546 });
    const result = splitUnitsOfDistinctPictures([unitOf([top, middle, bottom], top)], classified([top, middle, bottom]), new Set());
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['top', 'middle', 'bottom']);
  });

  it('compares the outlines of the frames, not their boxes: a figure in a frame with a cut corner beside two pictures in plain frames', () => {
    const outline = (objId: string, raster: Rect, polygon: number[]): ImageEntry => ({
      ...entry(objId, raster, 0.2),
      occurrences: [{ page: 1, bbox: raster, index: 0, clip: { paths: [[polygon]], ctm: [1, 0, 0, 1, 0, 0] } }],
    });
    // The frame of the figure has its upper left corner cut away along a slant; the box of the frame reaches over the pictures at the left.
    const figure = outline('figure', { minX: 78, minY: 0, maxX: 592, maxY: 421 }, [438, 420, 79, 96, 79, 0, 591, 0, 591, 420]);
    const forest = framed('forest', { minX: 51, minY: 340, maxX: 288, maxY: 496 }, { minX: 51, minY: 352, maxX: 282, maxY: 482 });
    const result = splitUnitsOfDistinctPictures([unitOf([figure, forest], figure)], classified([figure, forest]), new Set());
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['figure', 'forest']);
  });

  it('splits a picture without a frame off the framed ones when its box does not overlap them, and keeps pictures whose outlines overlap together', () => {
    const a = framed('a', { minX: 0, minY: 0, maxX: 300, maxY: 200 }, { minX: 0, minY: 0, maxX: 300, maxY: 200 });
    const b = framed('b', { minX: 0, minY: 100, maxX: 300, maxY: 300 }, { minX: 0, minY: 100, maxX: 300, maxY: 300 });
    // The frames overlap by half: one picture.
    expect(splitUnitsOfDistinctPictures([unitOf([a, b], a)], classified([a, b]), new Set())).toHaveLength(1);
    // A picture without a frame, apart from the framed one: two pictures; and on top of it: one.
    const apart = entry('apart', { minX: 0, minY: 250, maxX: 300, maxY: 450 }, 0.14);
    const over = entry('over', { minX: 0, minY: 20, maxX: 300, maxY: 180 }, 0.14);
    expect(splitUnitsOfDistinctPictures([unitOf([a, apart], a)], classified([a, apart]), new Set())).toHaveLength(2);
    expect(splitUnitsOfDistinctPictures([unitOf([a, over], a)], classified([a, over]), new Set())).toHaveLength(1);
  });

  it('tolerates a slight overlap of the outlines (a quarter of the smaller picture) and keeps the pictures that overlap each other as one group', () => {
    const creature = framed('creature', { minX: 200, minY: 444, maxX: 613, maxY: 780 }, { minX: 200, minY: 444, maxX: 613, maxY: 780 });
    // Two layers of one drawing, one inside the other, laid slightly under the creature's frame.
    const swirlsOuter = entry('swirlsOuter', { minX: 248, minY: 313, maxX: 532, maxY: 460 }, 0.12);
    const swirlsInner = framed('swirlsInner', { minX: 248, minY: 313, maxX: 437, maxY: 480 }, { minX: 248, minY: 313, maxX: 437, maxY: 480 });
    const result = splitUnitsOfDistinctPictures([unitOf([creature, swirlsOuter, swirlsInner], creature)], classified([creature, swirlsOuter, swirlsInner]), new Set());
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.memberEntries.length).sort()).toEqual([1, 2]);
  });
});

describe('pictures that touch, and the faded panel behind figures', () => {
  const classified = (entries: ImageEntry[]) => new Map(entries.map((e) => [e, classify(e)]));
  const figureA = entry('figureA', { minX: 19, minY: 37, maxX: 323, maxY: 437 }, 0.25);
  const figureB = entry('figureB', { minX: 312, minY: 79, maxX: 558, maxY: 504 }, 0.215);
  const panel = { ...entry('panel', { minX: 6, minY: 132, maxX: 453, maxY: 579 }, 0.413), maxOpacity: 0.4 };

  it('splits two figures whose rasters only touch (a few points of overlap), and leaves out the faded panel behind them', () => {
    const unit = unitOf([panel, figureA, figureB], figureA);
    const result = splitUnitsOfDistinctPictures([unit], classified([panel, figureA, figureB]), new Set());
    expect(result.map((u) => u.representativeEntry?.objId).sort()).toEqual(['figureA', 'figureB']);
  });

  it('splits off an undecided picture that is nearly as large as the one split off beside it (the second figure of a pair), not a smaller leftover that sits on the first', () => {
    const first = entry('figureA', { minX: 33, minY: 83, maxX: 172, maxY: 449 }, 0.105);
    const second = entry('figureB', { minX: 175, minY: 83, maxX: 292, maxY: 452 }, 0.089);
    const leftover = entry('leftover', { minX: 40, minY: 100, maxX: 100, maxY: 220 }, 0.06);
    const masked = new Set(['figureA', 'figureB', 'leftover']);
    const unit = unitOf([first, second, leftover], first);
    const pictures = new Map<ImageEntry, ClassifiedImage>([[first, classify(first)], [second, classify(second, 'undecided')], [leftover, classify(leftover, 'undecided')]]);
    const result = splitUnitsOfDistinctPictures([unit], pictures, masked);
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['figureA', 'figureB']);
  });

  it('splits off a picture of consequence that lies clear of the ones split off (an armor beside the others), but not one that sits on them or a card of text', () => {
    const first = entry('first', { minX: 205, minY: 479, maxX: 405, maxY: 738 }, 0.107);
    const clear = entry('clear', { minX: 382, minY: 541, maxX: 566, maxY: 736 }, 0.074);
    const sitting = entry('sitting', { minX: 300, minY: 560, maxX: 420, maxY: 700 }, 0.07);
    const card = entry('card', { minX: 40, minY: 100, maxX: 200, maxY: 200 }, 0.06);
    const masked = new Set(['first', 'clear', 'sitting', 'card']);
    const unit = unitOf([first, clear, sitting, card], first);
    const pictures = new Map<ImageEntry, ClassifiedImage>([[first, classify(first)], [clear, classify(clear, 'undecided')], [sitting, classify(sitting, 'undecided')], [card, classify(card, 'undecided')]]);
    const text = new Map([[1, [{ minX: 40, minY: 100, maxX: 200, maxY: 200 }]]]);
    const result = splitUnitsOfDistinctPictures([unit], pictures, masked, text);
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['first', 'clear']);
  });

  it('splits a unit that holds a panel of text laid over pictures into one unit per picture, leaving out the specks', () => {
    const panel = { ...entry('panel', { minX: 52, minY: 369, maxX: 307, maxY: 754 }, 0.195), maxOpacity: 0.9 };
    const figureA = entry('figureA', { minX: 331, minY: 26, maxX: 596, maxY: 802 }, 0.411);
    const figureB = entry('figureB', { minX: 174, minY: 26, maxX: 596, maxY: 739 }, 0.6);
    const strip = entry('strip', { minX: 331, minY: 34, maxX: 338, maxY: 796 }, 0.011);
    const reasons = new Map<ImageEntry, ClassifiedImage>([
      [panel, { ...classify(panel, 'undecided'), reason: 'Z10-high-center-text-coverage' }],
      [figureA, classify(figureA, 'undecided')],
      [figureB, classify(figureB, 'undecided')],
      [strip, classify(strip, 'undecided')],
    ]);
    const unit = unitOf([panel, figureA, figureB, strip], figureB);
    const result = splitUnitsOfDistinctPictures([unit], reasons, new Set(['panel']));
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['panel', 'figureA', 'figureB']);
    expect(result.every((u) => u.memberEntries.length === 1)).toBe(true);
  });

  it('keeps two pictures together when their rasters overlap substantially', () => {
    const over = entry('over', { minX: 100, minY: 100, maxX: 400, maxY: 400 }, 0.2);
    const under = entry('under', { minX: 150, minY: 150, maxX: 450, maxY: 450 }, 0.2);
    expect(splitUnitsOfDistinctPictures([unitOf([over, under], over)], classified([over, under]), new Set())).toHaveLength(1);
  });

  it('a faded layer is a panel only beside an opaque picture of consequence, and only a large one of at most half of the page at 45% opacity or less', () => {
    const unit = unitOf([panel, figureA], figureA);
    expect(isPanelBehindFigure(panel, unit)).toBe(true);
    expect(isPanelBehindFigure(panel, unitOf([panel], panel))).toBe(false);
    expect(isPanelBehindFigure({ ...panel, maxOpacity: 0.65 }, unit)).toBe(false);
    expect(isPanelBehindFigure({ ...panel, maxRelativeArea: 0.7 }, unit)).toBe(false);
    expect(isPanelBehindFigure({ ...panel, maxRelativeArea: 0.05 }, unit)).toBe(false);
  });
});

describe('pieces of a unit that belong to the layout of the page', () => {
  it('a strip is long when it is at least three times as long as it is wide', () => {
    expect(isLongStrip({ minX: -1, minY: 0, maxX: 327, maxY: 1146 })).toBe(true);
    expect(isLongStrip({ minX: 0, minY: 0, maxX: 300, maxY: 100 })).toBe(true);
    expect(isLongStrip({ minX: 0, minY: 0, maxX: 300, maxY: 150 })).toBe(false);
    expect(isLongStrip({ minX: 5, minY: 5, maxX: 5, maxY: 100 })).toBe(false);
  });

  it('a picture mostly outside the representative with page text over it is the backdrop of that text; one with no text, or one inside the representative, is not', () => {
    const representative = { minX: -1, minY: 229, maxX: 299, maxY: 793 };
    const corner = { minX: -1, minY: -1, maxX: 384, maxY: 336 };
    expect(isBackdropOfTextBesideRepresentative(corner, representative, 0.25)).toBe(true);
    expect(isBackdropOfTextBesideRepresentative(corner, representative, 0.02)).toBe(false);
    const inside = { minX: 20, minY: 300, maxX: 250, maxY: 700 };
    expect(isBackdropOfTextBesideRepresentative(inside, representative, 0.5)).toBe(false);
  });
});

describe('isSmallCardOfText', () => {
  const paper = { meanLuminance: 222, luminanceStdDev: 9 };

  it('is a small, light, plain, opaque raster with some text over it', () => {
    expect(isSmallCardOfText(0.072, paper, 1, 0.045)).toBe(true);
  });

  it('is not an illustration (large, dark or with a spread of luminance), a cut-out figure or a raster with no text over it', () => {
    expect(isSmallCardOfText(0.335, { meanLuminance: 156, luminanceStdDev: 26 }, 1, 0.1)).toBe(false);
    expect(isSmallCardOfText(0.072, { meanLuminance: 222, luminanceStdDev: 45 }, 1, 0.1)).toBe(false);
    expect(isSmallCardOfText(0.072, paper, 0.4, 0.1)).toBe(false);
    expect(isSmallCardOfText(0.072, paper, 1, 0.01)).toBe(false);
    expect(isSmallCardOfText(0.072, null, 1, 0.1)).toBe(false);
  });
});

describe('isFlushCardOfText', () => {
  it('is a plain, opaque raster with a good share of its box covered by text (a stat block on parchment)', () => {
    expect(isFlushCardOfText({ luminanceStdDev: 10.5 }, 0.92, 0.31)).toBe(true);
    expect(isFlushCardOfText({ luminanceStdDev: 9.7 }, 0.9, 0.54)).toBe(true);
  });

  it('is not an illustration, a cut-out picture or a raster that carries little text', () => {
    expect(isFlushCardOfText({ luminanceStdDev: 60 }, 1, 0.4)).toBe(false);
    expect(isFlushCardOfText({ luminanceStdDev: 10 }, 0.5, 0.4)).toBe(false);
    expect(isFlushCardOfText({ luminanceStdDev: 10 }, 1, 0.05)).toBe(false);
    expect(isFlushCardOfText(null, 1, 0.4)).toBe(false);
  });
});

describe('isTextPanel', () => {
  it('is a render with at least 15% of its box covered by page text; a raw picture or a render with little text is not', () => {
    expect(isTextPanel('region-render', 0.42)).toBe(true);
    expect(isTextPanel('region-render', 0.15)).toBe(true);
    expect(isTextPanel('region-render', 0.06)).toBe(false);
    expect(isTextPanel('objs', 0.6)).toBe(false);
  });
});


describe('areSeamedTiles', () => {
  const tile = (minX: number, minY: number, maxX: number, maxY: number, pixelWidth = (maxX - minX) * 2.09, pixelHeight = (maxY - minY) * 2.09) => ({ box: { minX, minY, maxX, maxY }, pixelWidth, pixelHeight });

  it('joins rasters that meet at a seam with the same pixel density, side by side and stacked', () => {
    expect(areSeamedTiles(tile(0, 666, 175.2, 842), tile(174.9, 666, 350.4, 842))).toBe(true);
    expect(areSeamedTiles(tile(0, 666, 175.2, 842), tile(0, 490.9, 175.2, 666.7))).toBe(true);
    // A narrow strip beside two tiles of the column shares the whole height of the shorter one.
    expect(areSeamedTiles(tile(350, 666, 525.5, 842), tile(525.2, 420.8, 595.7, 842))).toBe(true);
  });

  it('keeps apart rasters with a gap, with a deep overlap, or with an edge that is not aligned', () => {
    expect(areSeamedTiles(tile(0, 0, 100, 100), tile(110, 0, 210, 100))).toBe(false);
    expect(areSeamedTiles(tile(0, 0, 100, 100), tile(70, 0, 170, 100))).toBe(false);
    expect(areSeamedTiles(tile(0, 0, 100, 100), tile(100, 60, 200, 160))).toBe(false);
  });

  it('keeps apart rasters of different pixel density that touch', () => {
    expect(areSeamedTiles(tile(0, 0, 100, 100), tile(100, 0, 200, 100, 800, 800))).toBe(false);
  });
});

describe('splitUnitsOfDistinctPictures: tiles of one picture', () => {
  const tile = (objId: string, minX: number, maxX: number, pixelsPerPoint = 2): ImageEntry => ({ ...entry(objId, { minX, minY: 0, maxX, maxY: 200 }, 0.08), intrinsicWidth: (maxX - minX) * pixelsPerPoint, intrinsicHeight: 200 * pixelsPerPoint });

  it('keeps rasters that lie edge to edge in one unit', () => {
    const [a, b, c] = [tile('tileA', 0, 200.2), tile('tileB', 199.9, 400.2), tile('tileC', 399.9, 600)];
    const classified = new Map([a, b, c].map((m) => [m, classify(m, 'undecided')]));
    expect(splitUnitsOfDistinctPictures([unitOf([a, b, c], a)], classified, new Set())).toHaveLength(1);
  });

  it('still tells apart neighbors that touch but were made at another resolution', () => {
    const [a, b] = [tile('tileA', 0, 200.2), tile('tileB', 199.9, 400.2, 6)];
    const classified = new Map([a, b].map((m) => [m, classify(m, 'undecided')]));
    expect(splitUnitsOfDistinctPictures([unitOf([a, b], a)], classified, new Set())).toHaveLength(2);
  });
});

describe('splitUnitsOfDistinctPictures: a card of text the classifier found', () => {
  const classifiedAs = (e: ImageEntry, reason: string): ClassifiedImage => ({ entry: e, classification: 'undecided', reason, confidence: 0.4 });

  it('tells a figure from a card of text whose coverage is just below the card limit, when the classifier found the text on it, and drops a repainted copy of the figure', () => {
    const figure = { ...entry('figure', { minX: 148, minY: 97, maxX: 613, maxY: 747 }, 0.62), intrinsicWidth: 969, intrinsicHeight: 1355 };
    const repainted = { ...entry('figureAgain', { minX: 148.2, minY: 97.1, maxX: 613.1, maxY: 746.9 }, 0.62), intrinsicWidth: 969, intrinsicHeight: 1355 };
    const card = entry('card', { minX: 53, minY: 90, maxX: 307, maxY: 536 }, 0.23);
    const classified = new Map<ImageEntry, ClassifiedImage>([[figure, classify(figure)], [repainted, classify(repainted)], [card, classifiedAs(card, 'Z10-high-center-text-coverage')]]);
    // The text blocks cover 29% of the card (below the 30% card limit) and 25% of the figure's box.
    const text = new Map([[1, [{ minX: 53, minY: 90, maxX: 307, maxY: 90 + 0.29 * 446 }]]]);
    const units = splitUnitsOfDistinctPictures([unitOf([figure, repainted, card], figure)], classified, new Set(), text);
    expect(units.map((u) => u.representativeEntry?.objId).sort()).toEqual(['card', 'figure']);
  });
});

describe('splitUnitsOfDistinctPictures: the same picture painted twice', () => {
  it('is one picture, so a figure and its repaint stay a unit of one', () => {
    const figure = { ...entry('figure', { minX: 0, minY: 0, maxX: 388, maxY: 640 }, 0.5), intrinsicWidth: 812, intrinsicHeight: 1335 };
    const repainted = { ...entry('figureAgain', { minX: 0.3, minY: 0.2, maxX: 388.4, maxY: 640.1 }, 0.5), intrinsicWidth: 812, intrinsicHeight: 1335 };
    const classified = new Map([figure, repainted].map((m) => [m, classify(m, 'undecided')]));
    const [unit] = splitUnitsOfDistinctPictures([unitOf([figure, repainted], figure)], classified, new Set());
    expect(unit!.memberEntries.map((m) => m.objId)).toEqual(['figure']);
    expect(unit!.clusterMemberCount).toBe(1);
  });

  it('keeps two rasters of the same size that lie at different places', () => {
    const left = { ...entry('left', { minX: 0, minY: 0, maxX: 200, maxY: 200 }, 0.3), intrinsicWidth: 500, intrinsicHeight: 500 };
    const right = { ...entry('right', { minX: 150, minY: 0, maxX: 350, maxY: 200 }, 0.3), intrinsicWidth: 500, intrinsicHeight: 500 };
    const classified = new Map([left, right].map((m) => [m, classify(m, 'undecided')]));
    const units = splitUnitsOfDistinctPictures([unitOf([left, right], left)], classified, new Set());
    expect(units.flatMap((u) => u.memberEntries).map((m) => m.objId).sort()).toEqual(['left', 'right']);
  });

  it('a figure that runs to the page edge is not a card of text however much text lies over its box, and a card on it is told apart from it', () => {
    const figure = entry('figure', { minX: 0, minY: 0, maxX: 612, maxY: 640 }, 0.59);
    const card = entry('card', { minX: 305, minY: 366, maxX: 560, maxY: 500 }, 0.07);
    const classified = new Map<ImageEntry, ClassifiedImage>([
      [figure, { entry: figure, classification: 'undecided', reason: 'Z12-flush-no-center-text-evidence', confidence: 0.4 }],
      [card, { entry: card, classification: 'undecided', reason: 'Z10-high-center-text-coverage', confidence: 0.4 }],
    ]);
    const text = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 640 * 0.4 }]]]);
    const units = splitUnitsOfDistinctPictures([unitOf([figure, card], figure)], classified, new Set(), text);
    expect(units.map((u) => u.representativeEntry?.objId)).toEqual(['figure']);
    expect(units[0]!.memberEntries.map((m) => m.objId)).toEqual(['figure']);
  });
});
