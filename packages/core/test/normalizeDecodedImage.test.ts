import { describe, expect, it } from 'vitest';
import { normalizeDecodedImage } from '../src/images/normalizeDecodedImage.js';

describe('normalizeDecodedImage — ksztalt {kind, data} (Node, fazy 0 spike)', () => {
  it('RGBA_32BPP (kind=3) przechodzi bez zmian', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 3, data });
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect([...result.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('RGB_24BPP (kind=2) dostaje kanal alfa=255 doklejony', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 40, 50, 60]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 2, data });
    expect([...result.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('GRAYSCALE_1BPP (kind=1) rozpakowuje bity do czerni/bieli RGBA', () => {
    // 2x1 px: bit0=1 (bialy), bit1=0 (czarny) -> bajt 0b10000000 = 0x80
    const data = new Uint8ClampedArray([0b10000000]);
    const result = normalizeDecodedImage({ width: 2, height: 1, kind: 1, data });
    expect([...result.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it('rzuca czytelny blad dla nieznanego kind', () => {
    expect(() => normalizeDecodedImage({ width: 1, height: 1, kind: 99, data: new Uint8ClampedArray([0]) })).toThrow(
      /nieobslugiwany kind/,
    );
  });
});

describe('normalizeDecodedImage — ksztalt {bitmap} (przegladarka)', () => {
  it('w Node (bez OffscreenCanvas) rzuca czytelny blad zamiast cichego zawieszenia', () => {
    // Prawdziwe rysowanie ImageBitmap na canvasie to zakres fazy 3 (KROK-3-fixtures.md, Z6) —
    // tutaj tylko potwierdzamy, ze ksztalt jest rozpoznany i brak OffscreenCanvas
    // w Node daje jasny, opisowy blad, a nie awarie.
    const fakeBitmap = { width: 4, height: 4 };
    expect(() => normalizeDecodedImage({ width: 4, height: 4, bitmap: fakeBitmap })).toThrow(/OffscreenCanvas/);
  });

  it('dziala poprawnie, gdy OffscreenCanvas jest dostepny (zamockowany)', () => {
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

describe('normalizeDecodedImage — walidacja wejscia', () => {
  it('rzuca dla null', () => {
    expect(() => normalizeDecodedImage(null)).toThrow(/oczekiwano obiektu/);
  });

  it('rzuca, gdy brak width/height', () => {
    expect(() => normalizeDecodedImage({ data: new Uint8ClampedArray() })).toThrow(/width\/height/);
  });

  it('rzuca dla nierozpoznanego ksztaltu (brak data i brak bitmap)', () => {
    expect(() => normalizeDecodedImage({ width: 1, height: 1 })).toThrow(/nierozpoznany ksztalt/);
  });
});
