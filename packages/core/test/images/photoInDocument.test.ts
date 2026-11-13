import { describe, expect, it } from 'vitest';
import { findPhotoInDocument } from '../../src/images/photoInDocument.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const W = 900;
const H = 1200;

/** A page of light paper with `lines` lines of letter-sized marks of one height, from `fromY` down, in the columns `fromX`..`toX`. */
function document(lines = 30, fromX = 40, toX = 860): DecodedImage {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(240);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const image = { width: W, height: H, rgba };
  for (let line = 0; line < lines; line++) {
    for (let x = fromX; x + 6 <= toX; x += 20) paint(image, x, 60 + line * 36, 6, 12, () => 20);
  }
  return image;
}

function paint(image: DecodedImage, x: number, y: number, w: number, h: number, level: (px: number, py: number) => number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const v = level(xx, yy); const i = (yy * image.width + xx) * 4; image.rgba[i] = v; image.rgba[i + 1] = v; image.rgba[i + 2] = v; }
}

/** A photograph's tones: a smooth gradient with a pattern over it, dark enough to stand out from the paper. */
const photoTones = (x: number, y: number): number => 40 + ((x + y) % 120) + (Math.floor(x / 25) % 2) * 30;

describe('findPhotoInDocument', () => {
  it('finds a photograph laid on a page of documents', () => {
    const page = document();
    paint(page, 500, 600, 300, 350, photoTones);
    const box = findPhotoInDocument(page)!;
    expect(box).not.toBeNull();
    // Within a cell or two of the grid and the blur around it.
    expect(Math.abs(box.x - 500)).toBeLessThan(30);
    expect(Math.abs(box.y - 600)).toBeLessThan(30);
    expect(Math.abs(box.width - 300)).toBeLessThan(60);
    expect(Math.abs(box.height - 350)).toBeLessThan(60);
  });

  it('finds none in a page of documents alone, nor in a flat black bar (a redaction)', () => {
    expect(findPhotoInDocument(document())).toBeNull();
    const redacted = document();
    paint(redacted, 300, 400, 400, 200, () => 10);
    expect(findPhotoInDocument(redacted)).toBeNull();
  });

  it('finds none when what is left is not a page of documents (a picture with a few labels)', () => {
    const picture = document(4);
    paint(picture, 100, 300, 700, 700, photoTones);
    expect(findPhotoInDocument(picture)).toBeNull();
  });
});
