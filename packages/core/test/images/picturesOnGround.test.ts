import { describe, expect, it } from 'vitest';
import { findDrawingsOnGround, findPicturesOnGround } from '../../src/images/picturesOnGround.js';

type Colour = [number, number, number];
const PAPER: Colour = [236, 228, 208];
const INK: Colour = [40, 50, 110];

/** A 400x560 page: paper, painted over by `paint` (the last rectangle that covers a pixel wins). */
function page(rects: { x: number; y: number; w: number; h: number; colour: (x: number, y: number) => Colour }[], ground: Colour = PAPER) {
  const width = 400;
  const height = 560;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let colour = ground;
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) colour = r.colour(x, y);
      rgba.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}
const photo = (x: number, y: number): Colour => [(x * 7) % 200, (y * 5) % 180, ((x + y) * 3) % 160];
const solid = (colour: Colour) => (): Colour => colour;
/** The ornamental frame of a book: thin lines just inside the page's edge. */
const frame = [
  { x: 10, y: 12, w: 380, h: 3, colour: solid(INK) },
  { x: 10, y: 545, w: 380, h: 3, colour: solid(INK) },
  { x: 10, y: 12, w: 3, h: 536, colour: solid(INK) },
  { x: 387, y: 12, w: 3, h: 536, colour: solid(INK) },
];
const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 6;

describe('findPicturesOnGround', () => {
  it('finds a map inside the frame of the page, without the frame', () => {
    const pictures = findPicturesOnGround(page([...frame, { x: 40, y: 50, w: 320, h: 440, colour: photo }]));
    expect(pictures).toHaveLength(1);
    const [map] = pictures!;
    expect(near(map!.x, 40) && near(map!.y, 50) && near(map!.width, 320) && near(map!.height, 440)).toBe(true);
  });

  it('finds two pictures on one page, in reading order, and a small one beside a large one', () => {
    const pictures = findPicturesOnGround(page([...frame, { x: 60, y: 300, w: 260, h: 170, colour: photo }, { x: 60, y: 80, w: 260, h: 170, colour: photo }, { x: 310, y: 480, w: 50, h: 50, colour: solid([90, 80, 70]) }]));
    expect(pictures?.map((p) => near(p.y, 80) || near(p.y, 300) || near(p.y, 480))).toEqual([true, true, true]);
    expect(pictures?.[0]!.y).toBeLessThan(pictures![1]!.y);
  });

  it('leaves a page that is a picture to its edge', () => {
    expect(findPicturesOnGround(page([{ x: 0, y: 0, w: 400, h: 560, colour: photo }]))).toBeNull();
  });

  it('leaves a picture on a dark ground (a night scene lit in the middle)', () => {
    expect(findPicturesOnGround(page([{ x: 100, y: 150, w: 200, h: 200, colour: photo }], [8, 8, 10]))).toBeNull();
  });

  it('leaves a picture that runs off the edge of the page', () => {
    expect(findPicturesOnGround(page([...frame, { x: 0, y: 200, w: 300, h: 200, colour: photo }]))).toBeNull();
  });

  it('leaves a blank sheet with its frame, and a drawing in thin lines', () => {
    expect(findPicturesOnGround(page(frame))).toBeNull();
    const plan = [0, 1, 2, 3, 4, 5].flatMap((k) => [
      { x: 80, y: 120 + k * 50, w: 240, h: 2, colour: solid([20, 20, 20] as Colour) },
      { x: 80 + k * 48, y: 120, w: 2, h: 250, colour: solid([20, 20, 20] as Colour) },
    ]);
    expect(findPicturesOnGround(page([...frame, ...plan]))).toBeNull();
  });
});

/** A floor plan in thin lines: an outline with walls inside it, `x`, `y` its top left corner. */
function plan(x: number, y: number, w: number, h: number) {
  const line = solid(INK);
  return [
    { x, y, w, h: 3, colour: line },
    { x, y: y + h - 3, w, h: 3, colour: line },
    { x, y, w: 3, h, colour: line },
    { x: x + w - 3, y, w: 3, h, colour: line },
    { x: x + Math.round(w / 2), y, w: 3, h: Math.round(h * 0.6), colour: line },
    { x, y: y + Math.round(h / 3), w: Math.round(w * 0.7), h: 3, colour: line },
  ];
}

describe('findDrawingsOnGround', () => {
  it('finds a floor plan in thin lines within the frame of the page, without the frame', () => {
    // The plan comes apart into pieces as solid pictures go: not one of them.
    const sheet = page([...frame, ...plan(80, 120, 240, 300)]);
    expect(findPicturesOnGround(sheet)).toBeNull();
    const drawings = findDrawingsOnGround(sheet);
    expect(drawings).toHaveLength(1);
    const [drawing] = drawings!;
    expect(near(drawing!.x, 80) && near(drawing!.y, 120) && near(drawing!.width, 240) && near(drawing!.height, 300)).toBe(true);
  });

  it('finds two plans that lie apart as two drawings, in reading order', () => {
    const drawings = findDrawingsOnGround(page([...frame, ...plan(200, 60, 140, 130), ...plan(60, 280, 260, 220)]));
    expect(drawings?.map((d) => [near(d.x, 200) || near(d.x, 60), d.y < 200])).toEqual([
      [true, true],
      [true, false],
    ]);
  });

  it('leaves a blank sheet with its frame (a page of text whose words are not in the image)', () => {
    expect(findDrawingsOnGround(page(frame))).toBeNull();
  });

  it('leaves a drawing on a page without the frame of a book', () => {
    expect(findDrawingsOnGround(page(plan(80, 120, 240, 300)))).toBeNull();
  });

  it('leaves a picture that runs off the edge of the page', () => {
    expect(findDrawingsOnGround(page([...frame, { x: 0, y: 200, w: 300, h: 200, colour: photo }]))).toBeNull();
  });

  it('does not take a strip of ornament inside the frame for a drawing', () => {
    expect(findDrawingsOnGround(page([...frame, { x: 60, y: 60, w: 280, h: 20, colour: photo }]))).toBeNull();
  });
});
