import { describe, expect, it } from 'vitest';
import { detectGrid } from '../../src/images/detectGrid.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * Piksele luminancji = suma DWOCH niezaleznych funkcji "pila" (jedna w X,
 * jedna w Y), kazda z wlasnym okresem/offsetem. Gradient POZIOMY (d/dx)
 * zalezy WYLACZNIE od skladnika X (skladnik Y jest stala wzdluz wiersza) i
 * odwrotnie dla gradientu PIONOWEGO — daje to CZYSTY, jednoznaczny (jeden
 * ostry skok na okres, nie dwie krawedzie jak przy narysowanej linii) sygnal
 * okresowosci na kazdej osi z osobna, latwy do przewidzenia w testach.
 */
function sawtooth(pos: number, size: number, offset: number): number {
  return ((((pos - offset) % size) + size) % size) / size;
}

function makeGridImage(width: number, height: number, sizeX: number, offsetX: number, sizeY: number, offsetY: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(sawtooth(x, sizeX, offsetX) * 100 + sawtooth(y, sizeY, offsetY) * 100 + 20);
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function flatImage(width: number, height: number, value: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(value);
  return { width, height, rgba };
}

describe('detectGrid', () => {
  it('wykrywa kwadratowa siatke o znanym rozmiarze/offsecie (obie osie zgodne)', () => {
    const img = makeGridImage(200, 200, 40, 5, 40, 12);
    const result = detectGrid(img, { minSize: 10, maxSize: 80 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe(40);
    expect(result!.offsetX).toBe(5);
    expect(result!.offsetY).toBe(12);
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('dwie osie o ROZNYCH okresach -> rozmiar to srednia, pewnosc obnizona przez brak zgodnosci', () => {
    const img = makeGridImage(300, 300, 40, 0, 60, 0);
    const agreeing = detectGrid(makeGridImage(300, 300, 40, 0, 40, 0), { minSize: 10, maxSize: 100 });
    const disagreeing = detectGrid(img, { minSize: 10, maxSize: 100 });
    expect(disagreeing).not.toBeNull();
    expect(disagreeing!.size).toBe(50); // (40+60)/2
    expect(disagreeing!.confidence).toBeLessThan(agreeing!.confidence);
  });

  it('tylko JEDNA os ma okresowosc (druga stala) -> wykrywa z niej rozmiar, offset drugiej osi = 0', () => {
    // Skladnik Y stale 0 -> rowProfile calkowicie plaski -> brak sygnalu na tej osi.
    const img = makeGridImage(200, 200, 30, 7, 1, 0);
    const result = detectGrid(img, { minSize: 10, maxSize: 60 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe(30);
    expect(result!.offsetX).toBe(7);
    expect(result!.offsetY).toBe(0);
  });

  it('obraz calkowicie plaski (brak jakiejkolwiek krawedzi) -> null, nie zgaduje', () => {
    const img = flatImage(200, 200, 128);
    expect(detectGrid(img)).toBeNull();
  });

  it('obraz ponizej minimalnej krawedzi -> null', () => {
    const img = makeGridImage(20, 20, 5, 0, 5, 0);
    expect(detectGrid(img)).toBeNull();
  });

  it('maxSize <= minSize (np. bardzo maly obraz wzgledem opcji) -> null, nie rzuca', () => {
    const img = makeGridImage(50, 50, 10, 0, 10, 0);
    expect(detectGrid(img, { minSize: 100, maxSize: 50 })).toBeNull();
  });

  it('determinizm: dwa wywolania na tych samych danych daja identyczny wynik', () => {
    const img = makeGridImage(150, 150, 25, 3, 25, 8);
    const a = detectGrid(img);
    const b = detectGrid(img);
    expect(a).toEqual(b);
  });

  it('nie znajduje falszywej wielokrotnosci okresu (np. 2x prawdziwy rozmiar)', () => {
    const img = makeGridImage(240, 240, 30, 0, 30, 0);
    const result = detectGrid(img, { minSize: 10, maxSize: 100 });
    expect(result!.size).toBe(30);
    expect(result!.size).not.toBe(60);
    expect(result!.size).not.toBe(90);
  });
});
