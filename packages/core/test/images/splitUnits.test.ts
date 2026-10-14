import { describe, expect, it } from 'vitest';
import { splitUnitsOfDistinctPictures, textCoverage, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
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

const BIG_A = entry('photoA', { minX: 40, minY: 400, maxX: 560, maxY: 750 }, 0.35);
const BIG_B = entry('photoB', { minX: 60, minY: 470, maxX: 565, maxY: 770 }, 0.32);
const NOTE = entry('note', { minX: 276, minY: 360, maxX: 567, maxY: 529 }, 0.1);
const TAPE = entry('tape', { minX: 500, minY: 740, maxX: 580, maxY: 790 }, 0.02);
const maskedAll = new Set(['photoA', 'photoB', 'note', 'tape']);

describe('splitUnitsOfDistinctPictures', () => {
  const classified = (entries: ImageEntry[]) => new Map(entries.map((e) => [e, classify(e)]));

  it('splits a unit with two or more significant masked pictures into one unit per picture, leaving out the tape', () => {
    const unit = unitOf([BIG_A, BIG_B, TAPE], BIG_A);
    const result = splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B, TAPE]), maskedAll);
    expect(result.map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB']);
    expect(result.every((u) => u.clusterMemberCount === 1 && u.memberEntries.length === 1)).toBe(true);
    expect(result[1]!.bbox).toEqual(BIG_B.occurrences[0]!.bbox);
  });

  it('keeps a unit with one picture and small decorations as it is', () => {
    const unit = unitOf([BIG_A, TAPE], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A, TAPE]), maskedAll)).toEqual([unit]);
  });

  it('keeps a unit whose significant pictures are not masked cut-outs (a composition)', () => {
    const unit = unitOf([BIG_A, BIG_B], BIG_A);
    expect(splitUnitsOfDistinctPictures([unit], classified([BIG_A, BIG_B]), new Set())).toEqual([unit]);
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
    const masked = new Set(['photoA', 'photoB', 'smallContent', 'smallUndecided']);
    expect(splitUnitsOfDistinctPictures([unit], byEntry, masked).map((u) => u.representativeEntry?.objId)).toEqual(['photoA', 'photoB', 'smallContent']);
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
