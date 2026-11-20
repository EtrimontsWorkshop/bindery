import { describe, expect, it } from 'vitest';
import { findCardsOnGround, takeCard } from '../../src/images/cardsOnGround.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const WIDTH = 600;
const HEIGHT = 840;

function paper(): DecodedImage {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = 247;
    rgba[at + 1] = 242;
    rgba[at + 2] = 231;
    rgba[at + 3] = 255;
  }
  return { width: WIDTH, height: HEIGHT, rgba };
}

/** A card of tan paper with lines of dark text on it, its corners given (any four-sided shape), a darker rim along its edge. */
function card(image: DecodedImage, corners: [number, number][]): void {
  const inside = (x: number, y: number): boolean => {
    let ins = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const [ax, ay] = corners[i]!;
      const [bx, by] = corners[j]!;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) ins = !ins;
    }
    return ins;
  };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (!inside(x, y)) continue;
      const rim = !inside(x - 6, y) || !inside(x + 6, y) || !inside(x, y - 6) || !inside(x, y + 6);
      const text = y % 22 < 4 && (x * 7 + y) % 13 < 9;
      const at = (y * WIDTH + x) * 4;
      const [r, g, b] = text ? [60, 50, 40] : rim ? [205, 180, 140] : [228, 210, 175];
      image.rgba[at] = r;
      image.rgba[at + 1] = g;
      image.rgba[at + 2] = b;
    }
  }
}

describe('findCardsOnGround', () => {
  it('finds cards laid on the paper, one askew over the corner of another', () => {
    const image = paper();
    // (Its bottom edge between two rows of the text of the card laid over it: a row of this test's text is a solid band.)
    card(image, [[60, 80], [440, 80], [440, 343], [60, 343]]);
    card(image, [[60, 600], [450, 600], [450, 780], [60, 780]]);
    // Laid last, so over the first card's corner: tilted by about four degrees.
    card(image, [[170, 300], [540, 274], [554, 480], [184, 506]]);
    const cards = findCardsOnGround(image);
    expect(cards).not.toBeNull();
    expect(cards!.length).toBe(3);
    const near = (c: { x: number; y: number }, x: number, y: number): boolean => Math.abs(c.x - x) <= 12 && Math.abs(c.y - y) <= 12;
    expect(cards!.some((c) => near(c.corners[0], 60, 80) && near(c.corners[2], 440, 343))).toBe(true);
    expect(cards!.some((c) => near(c.corners[1], 540, 274) && near(c.corners[3], 184, 506))).toBe(true);
    // The card laid last is over the first: the first is cut with its own paper where the other covers it, the other whole.
    const first = cards!.find((c) => near(c.corners[0], 60, 80))!;
    expect(first.coveredBy?.length).toBe(1);
    const firstTaken = takeCard(image, first);
    const corner = ((firstTaken.height - 5) * firstTaken.width + (firstTaken.width - 5)) * 4;
    expect([firstTaken.rgba[corner], firstTaken.rgba[corner + 1], firstTaken.rgba[corner + 2]]).toEqual([228, 210, 175]);
    // Cut out, a card is made a rectangle of about its size.
    const tilted = cards!.find((c) => near(c.corners[1], 540, 274))!;
    const taken = takeCard(image, tilted);
    expect(Math.abs(taken.width - 371)).toBeLessThanOrEqual(15);
    expect(Math.abs(taken.height - 206)).toBeLessThanOrEqual(15);
  });

  it('leaves a page with one card (a picture on paper, found otherwise)', () => {
    const image = paper();
    card(image, [[60, 80], [440, 80], [440, 330], [60, 330]]);
    expect(findCardsOnGround(image)).toBeNull();
  });

  it('leaves a picture without a light ground round it', () => {
    const image = paper();
    for (let at = 0; at < image.rgba.length; at += 4) {
      image.rgba[at] = 90;
      image.rgba[at + 1] = 80;
      image.rgba[at + 2] = 70;
    }
    card(image, [[60, 80], [440, 80], [440, 330], [60, 330]]);
    card(image, [[60, 600], [450, 600], [450, 780], [60, 780]]);
    expect(findCardsOnGround(image)).toBeNull();
  });
});
