import { describe, expect, it } from 'vitest';
import { normalizeDecodedImage } from '../src/images/normalizeDecodedImage.js';

describe('normalizeDecodedImage — the {kind, data} shape (Node, from the initial spike)', () => {
  it('RGBA_32BPP (kind=3) passes through unchanged', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 3, data });
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect([...result.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('RGB_24BPP (kind=2) gets an alpha=255 channel appended', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 2, data });
    expect([...result.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('GRAYSCALE_1BPP (kind=1) unpacks the bits into black/white RGBA', () => {
    // 2x1 px: bit0=1 (white), bit1=0 (black) -> byte 0b10000000 = 0x80
    const data = new Uint8ClampedArray([0b10000000]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 1, data });
    expect([...result.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it('throws a readable error for an unknown kind', () => {
    expect(() => normalizeDecodedImage({ width: 1, height: 1, kind: 99, data: new Uint8ClampedArray([0]) })).toThrow(
      /unsupported kind/,
    );
  });
});

describe('normalizeDecodedImage — the {bitmap} shape (the browser)', () => {
  it('in Node (without OffscreenCanvas) throws a readable error instead of a silent hang', () => {
    // Real drawing of an ImageBitmap on a canvas is the scope of the image extraction stage — here we
    // only confirm that the shape is recognized and that the lack of OffscreenCanvas in Node gives a
    // clear, descriptive error, not a crash.
    const fakeBitmap = { width: 4, height: 4 };
    expect(() => normalizeDecodedImage({ width: 4, height: 4, bitmap: fakeBitmap })).toThrow(/OffscreenCanvas/);
  });

  it('works correctly when OffscreenCanvas is available (mocked)', () => {
    const drawnBitmaps: unknown[] = [];
    class FakeCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: (bitmap: unknown) => {
            drawnBitmaps.push(bitmap);
          },
          getImageData: () => ({
            data: new Uint8ClampedArray(this.width * this.height * 4).fill(123),
          }),
        };
      }
    }
    const g = globalThis as unknown as Record<string, unknown>;
    g['OffscreenCanvas'] = FakeCanvas;
    try {
      const fakeBitmap = { marker: 'fake-bitmap' };
      const result = normalizeDecodedImage({ width: 2, height: 2, bitmap: fakeBitmap });
      expect(result.width).toBe(2);
      expect(result.height).toBe(2);
      expect(result.rgba.length).toBe(16);
      expect(result.rgba[0]).toBe(123);
      expect(drawnBitmaps).toEqual([fakeBitmap]);
    } finally {
      delete g['OffscreenCanvas'];
    }
  });
});

describe('normalizeDecodedImage — input validation', () => {
  it('throws for null', () => {
    expect(() => normalizeDecodedImage(null)).toThrow(/expected an object/);
  });

  it('throws when width/height are missing', () => {
    expect(() => normalizeDecodedImage({ data: new Uint8ClampedArray() })).toThrow(/width\/height/);
  });

  it('throws for an unrecognized shape (no data and no bitmap)', () => {
    expect(() => normalizeDecodedImage({ width: 1, height: 1 })).toThrow(/unrecognized input shape/);
  });
});
