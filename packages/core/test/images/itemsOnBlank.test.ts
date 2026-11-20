import { describe, expect, it } from 'vitest';
import { areNamedItems, findItemsOnBlank, withoutBoxes } from '../../src/images/itemsOnBlank.js';

const WIDTH = 400;
const HEIGHT = 500;

function sheet(paper: [number, number, number] = [250, 248, 244]) {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) rgba.set([...paper, 255], i * 4);
  return { width: WIDTH, height: HEIGHT, rgba };
}

function paint(image: ReturnType<typeof sheet>, x: number, y: number, w: number, h: number, colour: [number, number, number] = [120, 80, 50]): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) image.rgba.set([...colour, 255], (yy * WIDTH + xx) * 4);
}

/** An item: a long shaft with a head, and its name in small letters under it. */
function item(image: ReturnType<typeof sheet>, x: number, y: number): void {
  paint(image, x, y + 20, 300, 12);
  paint(image, x + 250, y, 40, 60);
  for (let n = 0; n < 6; n++) paint(image, x + n * 9, y + 70, 6, 8, [60, 60, 60]);
}

const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 8;

describe('findItemsOnBlank', () => {
  it('cuts a sheet of items apart, each with its name', () => {
    const image = sheet();
    item(image, 40, 30);
    item(image, 40, 190);
    item(image, 40, 350);
    const items = findItemsOnBlank(image);
    expect(items).toHaveLength(3);
    // Each item reaches down over its name.
    expect(items!.map((r) => near(r.y, [30, 190, 350][items!.indexOf(r)]!) && near(r.y + r.height, [108, 268, 428][items!.indexOf(r)]!))).toEqual([true, true, true]);
  });

  it("parts two items that lie beside each other at different heights, each without the other's ink", () => {
    const image = sheet();
    paint(image, 20, 40, 160, 180);
    // The second item is an L: its rectangle has room where the first one's tip reaches in.
    paint(image, 340, 140, 40, 200);
    paint(image, 220, 300, 160, 40);
    paint(image, 180, 190, 80, 8);
    const items = findItemsOnBlank(image);
    expect(items).toHaveLength(2);
    const second = items!.find((r) => r.x > 150)!;
    const first = items!.find((r) => r.x < 150)!;
    // The tip lies in the second item's rectangle: marked to be painted over there, and the first has nothing of the second.
    expect(second.x).toBeLessThan(260);
    expect(second.foreign.some((b) => b.x < 262 && b.y + b.height > 190 && b.y < 198)).toBe(true);
    expect(first.foreign).toEqual([]);
  });

  it('leaves a single picture, and one whose edge is not blank paper', () => {
    const single = sheet();
    paint(single, 50, 60, 300, 380);
    expect(findItemsOnBlank(single)).toBeNull();
    const framed = sheet();
    paint(framed, 0, 0, WIDTH, 6);
    paint(framed, 0, HEIGHT - 6, WIDTH, 6);
    paint(framed, 0, 0, 6, HEIGHT);
    paint(framed, WIDTH - 6, 0, 6, HEIGHT);
    paint(framed, 40, 40, 140, 140);
    paint(framed, 220, 300, 140, 140);
    expect(findItemsOnBlank(framed)).toBeNull();
  });

  it('leaves a card with a few lines of writing on it', () => {
    const card = sheet();
    for (let line = 0; line < 3; line++) for (let n = 0; n < 12; n++) paint(card, 40 + n * 12, 60 + line * 120, 8, 10, [40, 40, 40]);
    expect(findItemsOnBlank(card)).toBeNull();
  });

  it('takes a small detail of a scene for part of it, not an item', () => {
    const scene = sheet();
    paint(scene, 120, 100, 260, 160);
    paint(scene, 30, 160, 40, 40);
    expect(findItemsOnBlank(scene)).toBeNull();
  });

  it("paints the page's words over in the colour of the paper, leaving the drawing", () => {
    const image = sheet();
    item(image, 40, 30);
    const clean = withoutBoxes(image, [{ x: 38, y: 98, width: 60, height: 12 }]);
    const at = (x: number, y: number) => [...clean.rgba.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3)];
    expect(at(42, 102)).toEqual([250, 248, 244]);
    expect(at(100, 55)).toEqual([120, 80, 50]);
    // The image given is left as it was.
    expect([...image.rgba.slice((102 * WIDTH + 42) * 4, (102 * WIDTH + 42) * 4 + 3)]).toEqual([60, 60, 60]);
  });
});

describe('areNamedItems', () => {
  const item = (x: number, y: number, inkShare = 0.3) => ({ x, y, width: 100, height: 60, foreign: [], inkShare });
  const word = (x: number, y: number) => ({ x, y, width: 60, height: 10 });

  it('takes items with their names by them for a sheet of items', () => {
    expect(areNamedItems([item(0, 0), item(0, 200), item(0, 400)], [word(0, 65), word(0, 265)], 500)).toBe(true);
  });

  it('leaves pieces without names (a title cut into its words, a row of logos)', () => {
    expect(areNamedItems([item(0, 0), item(200, 0)], [], 500)).toBe(false);
    expect(areNamedItems([item(0, 0), item(0, 200), item(0, 400)], [word(0, 65)], 500)).toBe(false);
  });

  it('leaves a sheet with a nearly blank piece (a box of a form)', () => {
    expect(areNamedItems([item(0, 0), item(0, 200, 0.01)], [word(0, 65), word(0, 265)], 500)).toBe(false);
  });
});
