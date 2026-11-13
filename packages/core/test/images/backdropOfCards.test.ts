import { describe, expect, it } from 'vitest';
import { isBackdropOfCardsAbove } from '../../src/images/buildImageExtraction.js';
import type { Rect } from '../../src/geometry.js';

const box = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });
/** Words of 5 characters in rows over `area`. */
function words(area: Rect): (Rect & { chars: number })[] {
  const out: (Rect & { chars: number })[] = [];
  for (let y = area.minY + 2; y + 8 <= area.maxY; y += 12) for (let x = area.minX + 2; x + 30 <= area.maxX; x += 36) out.push({ ...box(x, y, x + 30, y + 8), chars: 5 });
  return out;
}

describe('isBackdropOfCardsAbove', () => {
  const backdrop = box(0, 0, 300, 600);
  const card = box(70, 260, 550, 740);
  const photo = box(70, 30, 390, 240);

  it('takes a texture under a card of text and a photograph, its words all on the card, for their backdrop', () => {
    expect(isBackdropOfCardsAbove(backdrop, [card, photo], words(box(80, 270, 290, 590)))).toBe(true);
  });

  it('does not take a picture with a box of text in its corner, or one with words of its own, for one', () => {
    const corner = box(200, 500, 300, 600);
    expect(isBackdropOfCardsAbove(backdrop, [corner], words(corner))).toBe(false);
    expect(isBackdropOfCardsAbove(backdrop, [card, photo], [...words(box(80, 270, 290, 590)), ...words(box(5, 0, 65, 600))])).toBe(false);
  });

  it('does not judge a picture without the page\'s words over it, or without anything painted over it', () => {
    expect(isBackdropOfCardsAbove(backdrop, [card, photo], [])).toBe(false);
    expect(isBackdropOfCardsAbove(backdrop, [], words(box(80, 270, 290, 590)))).toBe(false);
  });
});
