import { describe, expect, it } from 'vitest';
import { opaqueBounds, tightenToVisible } from '../../src/images/opaqueBounds.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function canvas(width: number, height: number): DecodedImage {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
}
function fillOpaque(image: DecodedImage, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.rgba[(y * image.width + x) * 4 + 3] = 255;
}

describe('opaqueBounds', () => {
  it('gives the box of the visible part as fractions of the image', () => {
    const image = canvas(100, 50);
    fillOpaque(image, 10, 5, 90, 45);
    const b = opaqueBounds(image)!;
    expect(b.x0).toBeCloseTo(0.1);
    expect(b.x1).toBeCloseTo(0.9);
    expect(b.y0).toBeCloseTo(0.1);
    expect(b.y1).toBeCloseTo(0.9);
  });

  it('leaves out a streak along the edge that is visible over a smaller share of the lines than the body', () => {
    const image = canvas(100, 100);
    fillOpaque(image, 20, 10, 90, 90); // the body: 80% of every column in it
    fillOpaque(image, 5, 10, 12, 40); // a streak: 30% of every column in it
    const b = opaqueBounds(image)!;
    expect(b.x0).toBeCloseTo(0.2);
  });

  it('is null when nothing is visible', () => {
    expect(opaqueBounds(canvas(10, 10))).toBeNull();
  });
});

describe('tightenToVisible', () => {
  const placed = { minX: 100, minY: 200, maxX: 300, maxY: 400 };

  it('maps the visible part onto the placement box (the page y axis runs up, the image rows down)', () => {
    const tight = tightenToVisible(placed, { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.6 })!;
    expect(tight).toEqual({ minX: 150, maxX: 250, minY: 280, maxY: 380 });
  });

  it('mirrors the bounds back for a picture that is mirrored on the page', () => {
    const tight = tightenToVisible(placed, { x0: 0.0, y0: 0.1, x1: 0.5, y1: 0.6 }, { flipX: true })!;
    expect(tight.minX).toBeCloseTo(200);
    expect(tight.maxX).toBeCloseTo(300);
  });

  it('is null for a turned picture and when the visible part is almost the whole box', () => {
    expect(tightenToVisible(placed, { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, { rotated: true })).toBeNull();
    expect(tightenToVisible(placed, { x0: 0.01, y0: 0.01, x1: 0.99, y1: 0.99 })).toBeNull();
  });
});
