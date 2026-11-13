import { describe, expect, it } from 'vitest';
import { areMosaicTiles, clearOfCrossingText, joinMosaicTiles, seamDifference, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { Rect } from '../../src/geometry.js';

const box = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });

/** A content fingerprint of one even shade. */
const shade = (level: number): number[] => Array.from({ length: 64 }, () => level);

function unit(objId: string, bbox: Rect, relativeArea: number, classification: ExtractionUnit['classification'] = 'undecided', fingerprint: number[] = shade(40)): ExtractionUnit {
  const entry = { objId, maxRelativeArea: relativeArea, occurrences: [{ page: 1, bbox, index: 0 }], contentFingerprint: fingerprint } as unknown as ImageEntry;
  return { representativeEntry: entry, memberEntries: [entry], page: 1, bbox, clusterMemberCount: 1, classification, confidence: 0.5, reason: 'test' };
}

describe('areMosaicTiles', () => {
  it('takes pictures that abut along a whole side, with a seam of a point or two, for tiles of one picture', () => {
    expect(areMosaicTiles(box(265, 66, 1003, 722), box(120, 66, 267, 722))).toBe(true);
    expect(areMosaicTiles(box(265, 66, 1003, 722), box(1001, 66, 1191, 736))).toBe(true);
    expect(areMosaicTiles(box(100, 100, 300, 200), box(100, 201, 300, 400))).toBe(true);
  });

  it('does not take pictures with a gutter between them, or that touch along a small part of a side, for tiles', () => {
    expect(areMosaicTiles(box(100, 100, 300, 300), box(310, 100, 500, 300))).toBe(false);
    expect(areMosaicTiles(box(100, 100, 300, 300), box(300, 250, 500, 450))).toBe(false);
    expect(areMosaicTiles(box(100, 100, 300, 300), box(150, 150, 250, 250))).toBe(false);
    expect(areMosaicTiles(box(100, 100, 300, 500), box(300, 100, 400, 200))).toBe(false); // a small picture set against a big one
  });
});

describe('joinMosaicTiles', () => {
  it('joins the tiles of a page into one unit, represented by the largest tile', () => {
    const joined = joinMosaicTiles([unit('ground', box(120, 66, 267, 722), 0.07), unit('plan', box(265, 66, 1003, 722), 0.5, 'content'), unit('legend', box(1001, 66, 1191, 736), 0.08)]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.representativeEntry!.objId).toBe('plan');
    expect(joined[0]!.bbox).toEqual(box(120, 66, 1191, 736));
    expect(joined[0]!.memberEntries).toHaveLength(3);
    expect(joined[0]!.classification).toBe('content');
  });

  it('does not join two pictures of their own set edge to edge (frames of a strip), whose content changes across the seam', () => {
    const frames = [unit('upper', box(0, 400, 253, 596), 0.1, 'undecided', shade(30)), unit('lower', box(0, 205, 253, 402), 0.1, 'undecided', shade(200))];
    expect(joinMosaicTiles(frames)).toHaveLength(2);
  });

  it('joins tiles laid like bricks, whose seams are not in line from row to row, when together they fill a rectangle', () => {
    const bricks = [unit('top-left', box(12, 437, 298, 711), 0.16, 'content'), unit('top-right', box(297, 437, 584, 711), 0.16, 'content'), unit('bottom-left', box(12, 197, 334, 437), 0.15, 'content'), unit('bottom-right', box(333, 197, 584, 437), 0.12, 'content')];
    const joined = joinMosaicTiles(bricks);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.bbox).toEqual(box(12, 197, 584, 711));
    expect(joined[0]!.memberEntries).toHaveLength(4);
  });

  it('takes in a strip of the picture that was left out of the units, but only as a tile of it', () => {
    const tiles = [unit('left', box(12, 437, 298, 711), 0.16, 'content'), unit('right', box(297, 437, 584, 711), 0.16, 'content')];
    const strip = (bbox: Rect) => ({ entry: unit('strip', bbox, 0.04).representativeEntry!, classification: 'decoration' as const, reason: 'Z18-form-page-element', confidence: 0.7 });
    const joined = joinMosaicTiles(tiles, [strip(box(12, 712, 584, 752))]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.bbox).toEqual(box(12, 437, 584, 752));
    expect(joined[0]!.representativeEntry!.objId).toBe('left');
    // A strip that does not fill out a rectangle with the tiles is not taken in, nor offered.
    const apart = joinMosaicTiles(tiles, [strip(box(12, 712, 200, 752))]);
    expect(apart).toHaveLength(1);
    expect(apart[0]!.bbox).toEqual(box(12, 437, 584, 711));
    // Nor a squat piece that would fill it (a piece of a box of text set under a picture).
    const squat = [unit('picture', box(229, 369, 369, 564), 0.11, 'content')];
    expect(joinMosaicTiles(squat, [strip(box(229, 230, 369, 369))])[0]!.bbox).toEqual(box(229, 369, 369, 564));
  });

  it('leaves out of the tiles a strip of the design that runs on from them but leaves a hole in the rectangle', () => {
    const tiles = [unit('top-left', box(12, 437, 298, 711), 0.16, 'content'), unit('top-right', box(297, 437, 584, 711), 0.16, 'content'), unit('bottom-left', box(12, 197, 334, 437), 0.15, 'content'), unit('bottom-right', box(333, 197, 584, 437), 0.12, 'content')];
    // The ends of the frame under a box of text: beneath the picture at its two sides, nothing between them.
    const side = (bbox: Rect) => ({ entry: unit('side', bbox, 0.01).representativeEntry!, classification: 'undecided' as const, reason: 'test', confidence: 0.5 });
    const joined = joinMosaicTiles(tiles, [side(box(12, 95, 48, 198)), side(box(548, 95, 584, 198))]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.bbox).toEqual(box(12, 197, 584, 711));
    expect(joined[0]!.memberEntries).toHaveLength(4);
  });

  it('makes one picture of a grid of small tiles of one size, none of them offered by itself', () => {
    const tile = (col: number, row: number) => ({ entry: unit(`t${col}${row}`, box(59 + col * 102, 501 + row * 33, 161 + col * 102, 534 + row * 33), 0.007).representativeEntry!, classification: 'decoration' as const, reason: 'Z16-tiny-undecided', confidence: 0.7 });
    const grid = Array.from({ length: 9 }, (_, row) => Array.from({ length: 5 }, (_, col) => tile(col, row))).flat();
    const joined = joinMosaicTiles([], grid);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.bbox).toEqual(box(59, 501, 569, 798));
    expect(joined[0]!.memberEntries).toHaveLength(45);
    expect(joined[0]!.classification).toBe('undecided');
    // A few of them (a row of icons) are no picture.
    expect(joinMosaicTiles([], grid.slice(0, 5))).toHaveLength(0);
  });

  it('cuts a box clear of the text that runs across its edge, and leaves the text inside it', () => {
    const picture = box(59, 501, 571, 794);
    expect(clearOfCrossingText(picture, [box(80, 480, 300, 512)])).toEqual(box(59, 512, 571, 794)); // a name over its foot
    expect(clearOfCrossingText(picture, [box(100, 600, 300, 620)])).toEqual(picture);
    expect(clearOfCrossingText(picture, [box(80, 400, 300, 700)])).toEqual(picture); // a column beside it, not a name over its edge
    // Only its sides: a page number across its left edge is cut off, a caption across its foot is not.
    expect(clearOfCrossingText(picture, [box(40, 600, 80, 620)], 'sides')).toEqual(box(80, 501, 571, 794));
    expect(clearOfCrossingText(picture, [box(80, 480, 300, 512)], 'sides')).toEqual(picture);
  });

  it('does not join pictures that touch but leave part of their bounding rectangle empty', () => {
    const steps = [unit('a', box(0, 0, 200, 100), 0.1), unit('b', box(100, 100, 300, 200), 0.1)];
    expect(joinMosaicTiles(steps)).toHaveLength(2);
  });

  it('leaves pictures apart, and hidden ones, as they are', () => {
    const apart = [unit('a', box(100, 100, 300, 300), 0.1), unit('b', box(320, 100, 500, 300), 0.1)];
    expect(joinMosaicTiles(apart)).toHaveLength(2);
    const hidden = [unit('a', box(100, 100, 300, 300), 0.1), unit('b', box(300, 100, 500, 300), 0.1, 'decoration')];
    expect(joinMosaicTiles(hidden)).toHaveLength(2);
  });
});

describe('seamDifference', () => {
  it('compares the cells of the two fingerprints along the seam', () => {
    // The left tile is light in its last column, the right tile light in its first: they run on across the seam.
    const left = Array.from({ length: 64 }, (_, i) => (i % 8 === 7 ? 200 : 20));
    const right = Array.from({ length: 64 }, (_, i) => (i % 8 === 0 ? 200 : 20));
    expect(seamDifference({ box: box(0, 0, 100, 100), fingerprint: left }, { box: box(100, 0, 200, 100), fingerprint: right })).toBe(0);
    expect(seamDifference({ box: box(0, 100, 100, 200), fingerprint: shade(200) }, { box: box(0, 0, 100, 100), fingerprint: shade(20) })).toBe(180);
  });

  it('is null without a fingerprint or for boxes that do not meet', () => {
    expect(seamDifference({ box: box(0, 0, 100, 100) }, { box: box(100, 0, 200, 100), fingerprint: shade(0) })).toBeNull();
    expect(seamDifference({ box: box(0, 0, 100, 100), fingerprint: shade(0) }, { box: box(150, 0, 200, 100), fingerprint: shade(0) })).toBeNull();
  });
});

describe('joinMosaicTiles — tiles laid like bricks', () => {
  const PAGE = new Map([[1, box(0, 0, 420, 595)]]);
  // A raster of 4.17 px/pt over its box, as one export cuts a scene into bricks.
  const brick = (objId: string, b: Rect, area = 0.02): ImageEntry =>
    ({ objId, maxRelativeArea: area, intrinsicWidth: Math.round((b.maxX - b.minX) * 4.17), intrinsicHeight: Math.round((b.maxY - b.minY) * 4.17), occurrences: [{ page: 1, bbox: b, index: 0 }] }) as unknown as ImageEntry;
  const leftover = (e: ImageEntry) => ({ entry: e, classification: 'decoration' as const, confidence: 0.5, reason: 'Z18-form-page-element' });
  const asUnit = (e: ImageEntry): ExtractionUnit => ({ representativeEntry: e, memberEntries: [e], page: 1, bbox: e.occurrences[0]!.bbox, clusterMemberCount: 1, classification: 'undecided', confidence: 0.5, reason: 'test' });
  const scene = () => {
    const top = [brick('a', box(36, 144, 162, 284), 0.07), brick('b', box(162, 144, 289, 284), 0.07), brick('c', box(289, 74, 384, 284), 0.08)];
    const below = [brick('d', box(36, 39, 137, 144)), brick('e', box(137, 39, 204, 144)), brick('f', box(204, 39, 289, 144)), brick('g', box(289, 39, 384, 74))];
    return { top, below };
  };

  it('joins an offered brick with the small bricks that fill the rectangle with it', () => {
    const { top, below } = scene();
    const joined = joinMosaicTiles(top.map(asUnit), below.map(leftover), PAGE);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.bbox).toEqual(box(36, 39, 384, 284));
    expect(joined[0]!.memberEntries).toHaveLength(7);
  });

  it('leaves the bricks apart when they leave a hole, or when a piece of the paper at the page edge would be needed', () => {
    const { top, below } = scene();
    expect(joinMosaicTiles(top.map(asUnit), below.slice(1).map(leftover), PAGE)).toHaveLength(3);
    const corner = brick('corner', box(0, 0, 36, 284));
    expect(joinMosaicTiles(top.map(asUnit), [...below, corner].map(leftover), PAGE)[0]!.bbox).toEqual(box(36, 39, 384, 284));
  });

  it('does not join rasters of another pixel density', () => {
    const { top, below } = scene();
    const coarse = below.map((e) => ({ ...e, intrinsicWidth: e.intrinsicWidth! * 2, intrinsicHeight: e.intrinsicHeight! * 2 }) as ImageEntry);
    expect(joinMosaicTiles(top.map(asUnit), coarse.map(leftover), PAGE)).toHaveLength(3);
  });
});
