import { describe, expect, it } from 'vitest';
import { eraseNumberMarkers } from '../../src/images/numberMarkers.js';

/** A white W x H picture; `paint(image)` draws on it. */
function blank(width: number, height: number) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, rgba };
}
function setPixel(img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number, v: number): void {
  img.rgba.set([v, v, v, 255], (y * img.width + x) * 4);
}
function disc(img: ReturnType<typeof blank>, cx: number, cy: number, r: number, glyph: boolean): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if (Math.hypot(x - cx, y - cy) <= r) setPixel(img, x, y, 0);
  if (!glyph) return;
  // A white "1" and a white "2" made of small bars, with dark between them.
  for (let y = cy - 6; y <= cy + 6; y++) for (const x of [cx - 4, cx - 3]) setPixel(img, x, y, 255);
  for (const y of [cy - 6, cy, cy + 6]) for (let x = cx + 1; x <= cx + 6; x++) setPixel(img, x, y, 255);
  for (let y = cy - 6; y <= cy; y++) setPixel(img, cx + 6, y, 255);
  for (let y = cy; y <= cy + 6; y++) setPixel(img, cx + 1, y, 255);
}
const at = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => img.rgba[(y * img.width + x) * 4]!;

describe('eraseNumberMarkers', () => {
  const mapWithMarkers = () => {
    const img = blank(400, 300);
    for (const [x, y] of [[60, 60], [200, 90], [320, 200], [100, 220]] as const) disc(img, x, y, 16, true);
    // A thick wall that runs along a marker.
    for (let y = 40; y < 280; y++) for (let x = 150; x < 156; x++) setPixel(img, x, y, 0);
    return img;
  };

  it('paints the numbered discs over with the ground and leaves a wall alone', () => {
    const img = mapWithMarkers();
    const out = eraseNumberMarkers(img);
    expect(out).not.toBeNull();
    for (const [x, y] of [[60, 60], [200, 90], [320, 200], [100, 220]] as const) {
      expect(at(out!, x + 10, y)).toBe(255);
      expect(at(out!, x, y + 10)).toBe(255);
    }
    expect(at(out!, 152, 150)).toBe(0);
    expect(at(img, 70, 60)).toBe(0); // the input stays as it was
  });

  it('does nothing for fewer than three markers or for discs without a number', () => {
    const two = blank(400, 300);
    disc(two, 60, 60, 16, true);
    disc(two, 200, 90, 16, true);
    expect(eraseNumberMarkers(two)).toBeNull();
    const plain = blank(400, 300);
    for (const [x, y] of [[60, 60], [200, 90], [320, 200], [100, 220]] as const) disc(plain, x, y, 16, false);
    expect(eraseNumberMarkers(plain)).toBeNull();
  });

  it('does not touch dark squares with white marks (not discs)', () => {
    const img = blank(400, 300);
    for (const [x, y] of [[60, 60], [200, 90], [320, 200], [100, 220]] as const) {
      for (let j = -16; j <= 16; j++) for (let i = -16; i <= 16; i++) setPixel(img, x + i, y + j, 0);
      for (let j = -5; j <= 5; j++) for (const i of [-4, 0, 4]) setPixel(img, x + i, y + j, 255);
    }
    expect(eraseNumberMarkers(img)).toBeNull();
  });
});
