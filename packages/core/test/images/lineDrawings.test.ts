import { describe, expect, it } from 'vitest';
import { findLineDrawings, findRuleFrame } from '../../src/images/vectorFigures.js';
import { withLineDrawings, type ExtractionUnit } from '../../src/images/buildImageExtraction.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { VectorShape } from '../../src/inventory/vectorRegistry.js';
import type { Rect } from '../../src/geometry.js';

const PAGE: Rect = { minX: 0, minY: 0, maxX: 612, maxY: 791 };
const box = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });

/** The walls of a plan: `count` short strokes in a row of rows over `area`, each touching the next. */
function plan(area: Rect, count = 60): VectorShape[] {
  const columns = 10;
  const w = (area.maxX - area.minX) / columns;
  const rows = Math.ceil(count / columns);
  const h = (area.maxY - area.minY) / rows;
  return Array.from({ length: count }, (_, i) => {
    const x = area.minX + (i % columns) * w;
    const y = area.minY + Math.floor(i / columns) * h;
    return { page: 1, bbox: box(x, y, x + w + 1, y + h + 1), relativeArea: 0 };
  });
}

function unit(objId: string, bbox: Rect): ExtractionUnit {
  const entry = { objId, maxRelativeArea: ((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) / (612 * 791), occurrences: [{ page: 1, bbox, index: 0 }] } as unknown as ImageEntry;
  return { representativeEntry: entry, memberEntries: [entry], page: 1, bbox, clusterMemberCount: 1, classification: 'undecided', confidence: 0.5, reason: 'test' };
}

describe('findLineDrawings', () => {
  it('finds a cluster of many touching lines as a drawing', () => {
    const drawings = findLineDrawings(plan(box(100, 100, 300, 400)), PAGE);
    expect(drawings).toHaveLength(1);
    expect(drawings[0]!.bbox).toEqual(box(100, 100, 301, 401));
  });

  it('does not take a few lines, or the rules of the layout, for a drawing', () => {
    expect(findLineDrawings(plan(box(100, 100, 300, 400), 20), PAGE)).toEqual([]);
    // Two plans joined only by a long straight rule of the page's frame stay two drawings.
    const rule: VectorShape = { page: 1, bbox: box(50, 450, 560, 450), relativeArea: 0 };
    const two = findLineDrawings([...plan(box(100, 300, 250, 449)), ...plan(box(350, 300, 500, 449)), rule], PAGE);
    expect(two).toHaveLength(2);
  });

  it('leaves out the lines mostly past the edge of the page', () => {
    const offPage = plan(box(-300, 100, -10, 400)).map((l) => ({ ...l, bbox: { ...l.bbox, maxX: l.bbox.maxX + 12 } }));
    expect(findLineDrawings(offPage, PAGE)).toEqual([]);
  });
});

describe('withLineDrawings', () => {
  it('replaces the tiles a plan is drawn over by one unit, its region the drawing and the tile it covers for the most part, and hides the bare tiles it left', () => {
    const lower = unit('lower', box(64, 162, 385, 526));
    const upper = unit('upper', box(64, 523, 548, 669));
    const out = withLineDrawings([lower, upper], plan(box(89, 177, 368, 595)), new Map([[1, PAGE]]));
    const drawings = out.filter((u) => u.reason === 'Z23-line-drawing-on-pictures');
    expect(drawings).toHaveLength(1);
    expect(drawings[0]!.bbox).toEqual(box(64, 162, 385, 596));
    expect(drawings[0]!.classification).toBe('content');
    // The upper tile is covered by less than half: it stays, as a tile to hide when it is a bare texture.
    expect(out.filter((u) => u.reason === 'Z23-tile-beside-line-drawing').map((u) => u.representativeEntry!.objId)).toEqual(['upper']);
  });

  it('keeps a drawing on each tile when each has one of its own, though their lines touch', () => {
    const top = unit('top', box(65, 192, 548, 669));
    const bottom = unit('bottom', box(198, 31, 538, 194));
    const out = withLineDrawings([top, bottom], [...plan(box(80, 200, 540, 650)), ...plan(box(210, 40, 330, 205))], new Map([[1, PAGE]]));
    expect(out.filter((u) => u.reason === 'Z23-line-drawing-on-pictures')).toHaveLength(2);
  });

  it('leaves the units without lines on them as they are', () => {
    const photo = unit('photo', box(100, 100, 300, 300));
    expect(withLineDrawings([photo], plan(box(350, 400, 550, 700)), new Map([[1, PAGE]]))).toEqual([photo]);
  });
});

describe('findRuleFrame', () => {
  const CARD_PAGE: Rect = { minX: 0, minY: 0, maxX: 612, maxY: 397 };
  const rule = (minX: number, minY: number, maxX: number, maxY: number) => ({ bbox: box(minX, minY, maxX, maxY) });

  it('finds the frame of rules a card is drawn in: rules of one width at its top and bottom, between two vertical rules', () => {
    const frame = findRuleFrame([rule(39, 45, 573, 45), rule(39, 266, 573, 266), rule(39, 349, 593, 349), rule(40, -9, 40, 405), rule(573, -9, 573, 405), rule(-9, 383, 621, 383)], CARD_PAGE);
    expect(frame).toEqual(box(39, 45, 573, 349));
  });

  it('finds none without the vertical rules, or for a rule or two of a layout', () => {
    expect(findRuleFrame([rule(39, 45, 573, 45), rule(39, 349, 573, 349)], CARD_PAGE)).toBeNull();
    expect(findRuleFrame([rule(39, 45, 573, 45), rule(40, -9, 40, 405), rule(573, -9, 573, 405)], CARD_PAGE)).toBeNull();
    expect(findRuleFrame([rule(39, 45, 200, 45), rule(39, 349, 200, 349), rule(39, 0, 39, 397), rule(200, 0, 200, 397)], CARD_PAGE)).toBeNull();
  });
});
