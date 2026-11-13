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

describe('eraseNumberMarkers — squares of one colour', () => {
  /** A red square with a white "1" in it, on a grey-green ground. */
  const RED = [200, 40, 40, 255];
  const GROUND = [150, 160, 140, 255];
  function ground(width: number, height: number) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) rgba.set(GROUND, p * 4);
    return { width, height, rgba };
  }
  function square(img: ReturnType<typeof ground>, x0: number, y0: number, side: number, glyph: boolean): void {
    for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) img.rgba.set(RED, (y * img.width + x) * 4);
    if (!glyph) return;
    for (let y = y0 + 4; y < y0 + side - 4; y++) for (const x of [x0 + side / 2 - 1, x0 + side / 2]) img.rgba.set([255, 255, 255, 255], (y * img.width + x) * 4);
  }
  const red = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => img.rgba[(y * img.width + x) * 4]! > 180 && img.rgba[(y * img.width + x) * 4 + 1]! < 80;

  it('paints three or more red squares with a light number over with the ground around them', () => {
    const img = ground(500, 400);
    const at = [[40, 40], [200, 100], [380, 300], [120, 260]] as const;
    for (const [x, y] of at) square(img, x, y, 20, true);
    const out = eraseNumberMarkers(img);
    expect(out).not.toBeNull();
    for (const [x, y] of at) {
      expect(red(out!, x + 3, y + 3)).toBe(false);
      expect(out!.rgba[((y + 3) * out!.width + x + 3) * 4 + 1]).toBeGreaterThan(140);
    }
  });

  it('leaves a bold red letter with a counter (an O of a headline) alone: its corners are not red', () => {
    const img = ground(500, 400);
    for (const [cx, cy] of [[60, 60], [200, 110], [390, 310], [130, 270]] as const) {
      for (let y = cy - 10; y <= cy + 10; y++) for (let x = cx - 10; x <= cx + 10; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= 10) img.rgba.set(d <= 4 ? [255, 255, 255, 255] : RED, (y * img.width + x) * 4);
      }
    }
    expect(eraseNumberMarkers(img)).toBeNull();
  });

  it('leaves a bold red E of a headline alone: its gaps open to its edge', () => {
    const img = ground(500, 400);
    for (const [x0, y0] of [[40, 40], [200, 100], [380, 300], [120, 260]] as const) {
      for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) {
        const gap = x >= x0 + 6 && ((y >= y0 + 4 && y < y0 + 8) || (y >= y0 + 12 && y < y0 + 16));
        img.rgba.set(gap ? [255, 255, 255, 255] : RED, (y * img.width + x) * 4);
      }
    }
    expect(eraseNumberMarkers(img)).toBeNull();
  });

  it('leaves red squares without a number (a roof, a flag) and a red square or two alone', () => {
    const plain = ground(500, 400);
    for (const [x, y] of [[40, 40], [200, 100], [380, 300]] as const) square(plain, x, y, 20, false);
    expect(eraseNumberMarkers(plain)).toBeNull();
    const two = ground(500, 400);
    for (const [x, y] of [[40, 40], [200, 100]] as const) square(two, x, y, 20, true);
    expect(eraseNumberMarkers(two)).toBeNull();
  });
});
