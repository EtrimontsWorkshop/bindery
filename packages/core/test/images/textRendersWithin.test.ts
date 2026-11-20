import { describe, expect, it } from 'vitest';
import { hideTextRendersWithinRenders } from '../../src/images/extractPage.js';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

describe('hideTextRendersWithinRenders', () => {
  it('hides a render marked as holding text that lies within a larger render offered on the page', () => {
    // A map's inner layer, its labels set by the page, within the map on its card.
    const map = { item: { classification: 'content' as const }, box: box(49, 487, 575, 759) };
    const layer = { item: { classification: 'undecided' as const, textFillsBox: true }, box: box(64, 489, 561, 744) };
    hideTextRendersWithinRenders([layer, map]);
    expect(layer.item.classification).toBe('decoration');
    expect(map.item.classification).toBe('content');
  });

  it('keeps a render without text marks within another (an inset map in its frame), and one only partly within', () => {
    const map = { item: { classification: 'content' as const }, box: box(0, 0, 500, 400) };
    const inset = { item: { classification: 'undecided' as const }, box: box(300, 250, 480, 380) };
    const across = { item: { classification: 'undecided' as const, textOnPaperCard: true }, box: box(400, 300, 600, 500) };
    hideTextRendersWithinRenders([map, inset, across]);
    expect(inset.item.classification).toBe('undecided');
    expect(across.item.classification).toBe('undecided');
  });
});

describe('hideTextRendersWithinRenders on about the same region', () => {
  it('hides a render already found to hold text on about the footprint of an offered render, and leaves it hidden', () => {
    const map = { item: { classification: 'content' as const }, box: box(40, 405, 536, 732) };
    const paper = { item: { classification: 'decoration' as const, holdsText: true as boolean | undefined }, box: box(24, 389, 550, 747) };
    hideTextRendersWithinRenders([map, paper]);
    expect(paper.item.holdsText).toBeUndefined();
    expect(map.item.classification).toBe('content');
  });

  it('keeps the first of two renders offered of about the same region', () => {
    const map = { item: { classification: 'content' as const }, box: box(40, 405, 536, 732) };
    const paper = { item: { classification: 'content' as const }, box: box(24, 389, 550, 747) };
    hideTextRendersWithinRenders([map, paper]);
    expect(map.item.classification).toBe('content');
    expect(paper.item.classification).toBe('decoration');
  });
});
