import { describe, expect, it } from 'vitest';
import { applyBuiltInFrame, compositeCustomFrame } from '../../src/images/tokenFrame.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solidSquare(size: number, r: number, g: number, b: number, a = 255): DecodedImage {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width: size, height: size, rgba };
}
function pixelAt(image: DecodedImage, x: number, y: number): [number, number, number, number] {
  const idx = (y * image.width + x) * 4;
  return [image.rgba[idx]!, image.rgba[idx + 1]!, image.rgba[idx + 2]!, image.rgba[idx + 3]!];
}

describe('applyBuiltInFrame', () => {
  it('srodek (daleko wewnatrz) zachowuje oryginalny kolor tresci, pasmo tuz przy granicy ksztaltu dostaje kolor ramki', () => {
    const image = solidSquare(60, 10, 20, 30);
    const result = applyBuiltInFrame(image, { shape: 'circle', thicknessNorm: 0.15, color: [255, 0, 0] });
    expect(pixelAt(result, 30, 30).slice(0, 3)).toEqual([10, 20, 30]); // srodek
    // Piksel tuz przy zewnetrznej krawedzi kola (promien ~29 z 30) powinien byc w pasmie ramki.
    expect(pixelAt(result, 59, 30).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('alfa nigdy nie jest ruszana przez ramke', () => {
    const image = solidSquare(40, 10, 20, 30, 200);
    const result = applyBuiltInFrame(image, { shape: 'square', thicknessNorm: 0.1, color: [0, 255, 0] });
    for (let i = 3; i < result.rgba.length; i += 4) expect(result.rgba[i]).toBe(200);
  });

  it('thicknessNorm=0 -> brak pasma (kazdy punkt "wewnatrz" jest tez wewnatrz nieskurczonego ksztaltu wewnetrznego) — obraz bez zmian', () => {
    const image = solidSquare(30, 10, 20, 30);
    const result = applyBuiltInFrame(image, { shape: 'square', thicknessNorm: 0, color: [255, 255, 255] });
    expect(Array.from(result.rgba)).toEqual(Array.from(image.rgba));
  });

  it('nie mutuje wejscia', () => {
    const image = solidSquare(20, 10, 20, 30);
    const snapshot = image.rgba.slice();
    applyBuiltInFrame(image, { shape: 'circle', thicknessNorm: 0.2, color: [1, 2, 3] });
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});

describe('compositeCustomFrame', () => {
  it('w pelni nieprzezroczysta ramka calkowicie zaslania obraz pod spodem', () => {
    const image = solidSquare(10, 0, 0, 0, 255);
    const frame = solidSquare(10, 200, 150, 100, 255);
    const result = compositeCustomFrame(image, frame);
    expect(pixelAt(result, 5, 5)).toEqual([200, 150, 100, 255]);
  });

  it('w pelni przezroczysta ramka nie zmienia obrazu pod spodem', () => {
    const image = solidSquare(10, 40, 50, 60, 255);
    const frame = solidSquare(10, 200, 150, 100, 0);
    const result = compositeCustomFrame(image, frame);
    expect(pixelAt(result, 5, 5)).toEqual([40, 50, 60, 255]);
  });

  it('ramka o polowicznej przezroczystosci nad w pelni nieprzezroczystym tlem daje 50/50 mieszanke koloru, pelna nieprzezroczystosc wyniku', () => {
    const image = solidSquare(4, 0, 0, 0, 255);
    const frame = solidSquare(4, 255, 255, 255, 128);
    const result = compositeCustomFrame(image, frame);
    const [r, g, b, a] = pixelAt(result, 1, 1);
    expect(r).toBeCloseTo(128, -1);
    expect(g).toBeCloseTo(128, -1);
    expect(b).toBeCloseTo(128, -1);
    expect(a).toBe(255);
  });

  it('rzuca przy niezgodnym rozmiarze ramki i tokenu', () => {
    const image = solidSquare(10, 0, 0, 0);
    const frame = solidSquare(8, 255, 255, 255);
    expect(() => compositeCustomFrame(image, frame)).toThrow();
  });

  it('nie mutuje wejscia', () => {
    const image = solidSquare(6, 10, 20, 30, 255);
    const frame = solidSquare(6, 200, 100, 50, 128);
    const imageSnapshot = image.rgba.slice();
    const frameSnapshot = frame.rgba.slice();
    compositeCustomFrame(image, frame);
    expect(Array.from(image.rgba)).toEqual(Array.from(imageSnapshot));
    expect(Array.from(frame.rgba)).toEqual(Array.from(frameSnapshot));
  });
});
