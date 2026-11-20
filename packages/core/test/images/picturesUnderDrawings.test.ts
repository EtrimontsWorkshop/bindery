import { describe, expect, it } from 'vitest';
import { hidePicturesUnderDrawings } from '../../src/images/extractPage.js';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const PAGE = box(0, 0, 595, 842);

describe('hidePicturesUnderDrawings', () => {
  it('hides a picture painted under a rendered line drawing, judged by its part on the page', () => {
    const drawing = { box: box(81, 34, 596, 810), index: 24309 };
    // A layer of the map under it, and a map of the same land placed half off the page under it.
    const layer = { item: { classification: 'undecided' as const }, box: box(80, 33, 597, 790), index: 6422 };
    const offPage = { item: { classification: 'undecided' as const }, box: box(50, 118, 1116, 727), index: 897 };
    hidePicturesUnderDrawings([layer, offPage], [drawing], PAGE);
    expect(layer.item.classification).toBe('decoration');
    expect(offPage.item.classification).toBe('decoration');
  });

  it('keeps a picture painted over the drawing, and one only partly under it', () => {
    const drawing = { box: box(100, 100, 400, 400), index: 50 };
    const over = { item: { classification: 'content' as const }, box: box(150, 150, 250, 250), index: 80 };
    const beside = { item: { classification: 'content' as const }, box: box(300, 300, 550, 550), index: 10 };
    hidePicturesUnderDrawings([over, beside], [drawing], PAGE);
    expect(over.item.classification).toBe('content');
    expect(beside.item.classification).toBe('content');
  });
});
