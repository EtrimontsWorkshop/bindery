import { describe, expect, it } from 'vitest';
import { findSingleCardOnGround } from '../../src/images/singleCardOnGround.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const WIDTH = 600;
const HEIGHT = 840;
const PAPER: [number, number, number] = [247, 242, 231];

function page(paint: (x: number, y: number) => [number, number, number] | null): DecodedImage {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = paint(x, y) ?? PAPER;
      const at = (y * WIDTH + x) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return { width: WIDTH, height: HEIGHT, rgba };
}

/** The book's frame: a dark band along each edge of the page. */
const frame = (x: number, y: number): [number, number, number] | null => (x < 12 || y < 12 || x >= WIDTH - 12 || y >= HEIGHT - 12 ? [40, 50, 90] : null);

describe('findSingleCardOnGround', () => {
  it('finds a sheet of tan paper laid upright on the page, with lines of print on it', () => {
    const image = page((x, y) => {
      const f = frame(x, y);
      if (f) return f;
      if (x >= 80 && x < 520 && y >= 140 && y < 700) return y % 24 < 4 && x > 100 && x < 500 ? [50, 40, 30] : [228, 210, 175];
      return null;
    });
    const sheet = findSingleCardOnGround(image)!;
    expect(sheet).not.toBeNull();
    expect(Math.abs(sheet.x - 80)).toBeLessThanOrEqual(6);
    expect(Math.abs(sheet.y - 140)).toBeLessThanOrEqual(6);
    expect(Math.abs(sheet.x + sheet.width - 520)).toBeLessThanOrEqual(6);
    expect(Math.abs(sheet.y + sheet.height - 700)).toBeLessThanOrEqual(6);
  });

  it('leaves a page of plain paper, a sheet running off the page, and a small card', () => {
    expect(findSingleCardOnGround(page(frame))).toBeNull();
    const offEdge = page((x, y) => (x >= 80 && x < 520 && y < 700 ? [228, 210, 175] : frame(x, y)));
    expect(findSingleCardOnGround(offEdge)).toBeNull();
    const small = page((x, y) => frame(x, y) ?? (x >= 250 && x < 350 && y >= 380 && y < 460 ? [228, 210, 175] : null));
    expect(findSingleCardOnGround(small)).toBeNull();
  });
});
