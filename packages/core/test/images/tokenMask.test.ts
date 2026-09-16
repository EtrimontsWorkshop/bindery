import { describe, expect, it } from 'vitest';
import { isInsideShape, applyTokenMask } from '../../src/images/tokenMask.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solidSquare(size: number): DecodedImage {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 100;
    rgba[i * 4 + 2] = 50;
    rgba[i * 4 + 3] = 255;
  }
  return { width: size, height: size, rgba };
}
function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}

describe('isInsideShape', () => {
  it('square: zawsze true, nawet w rogach — swiadomy brak maskowania', () => {
    expect(isInsideShape('square', 0, 0)).toBe(true);
    expect(isInsideShape('square', 1, 1)).toBe(true);
    expect(isInsideShape('square', -1, -1)).toBe(true);
  });

  it('circle: srodek i granica wpisanego kola true, rog kwadratu (odleglosc √2) false', () => {
    expect(isInsideShape('circle', 0, 0)).toBe(true);
    expect(isInsideShape('circle', 1, 0)).toBe(true); // dokladnie na promieniu 1
    expect(isInsideShape('circle', 0.99, 0)).toBe(true);
    expect(isInsideShape('circle', 1.01, 0)).toBe(false);
    expect(isInsideShape('circle', 1, 1)).toBe(false); // rog, odleglosc √2 > 1
  });

  it('roundedSquare: srodek i srodek krawedzi true, ostry rog kwadratu false, punkt w promieniu naroza tuz PRZED zaokragleniem true', () => {
    expect(isInsideShape('roundedSquare', 0, 0)).toBe(true);
    expect(isInsideShape('roundedSquare', 1, 0)).toBe(true); // srodek krawedzi (nie naroze) — nie obcinany
    expect(isInsideShape('roundedSquare', 1, 1)).toBe(false); // ostry rog kwadratu zawsze poza zaokraglonym ksztaltem
    expect(isInsideShape('roundedSquare', 0.7, 0.7)).toBe(true); // wyraznie wewnatrz, daleko od naroza
  });

  it('hex (flat-top): srodek true, wierzcholek lewy/prawy (1,0) na granicy true, punkt POZA plaskim gornym bokiem (0,1) false, punkt na plaskim gornym boku (0, apotem) true', () => {
    const apothem = Math.cos(Math.PI / 6);
    expect(isInsideShape('hex', 0, 0)).toBe(true);
    expect(isInsideShape('hex', 1, 0)).toBe(true);
    expect(isInsideShape('hex', 0, apothem)).toBe(true);
    expect(isInsideShape('hex', 0, 1)).toBe(false); // powyzej plaskiej gornej krawedzi (heks NIE siega do y=1, w odroznieniu od kola/kwadratu)
    expect(isInsideShape('hex', 0.5, 0.3)).toBe(true); // wyraznie wewnatrz
  });
});

describe('applyTokenMask', () => {
  it('circle na jednolitym, nieprzezroczystym plotnie: srodek zostaje nieprzezroczysty, rog staje sie przezroczysty (featherPx=0, ostra granica)', () => {
    const image = solidSquare(40);
    const result = applyTokenMask(image, 'circle', 0);
    expect(alphaAt(result, 20, 20)).toBe(255); // srodek
    expect(alphaAt(result, 0, 0)).toBe(0); // rog, daleko poza kolem
  });

  it('square: brak zmian alfa NAWET w rogach (brak maskowania z definicji)', () => {
    const image = solidSquare(20);
    const result = applyTokenMask(image, 'square', 0);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(result, x, y)).toBe(255);
  });

  it('RGB nigdy nie jest ruszane przez maskowanie', () => {
    const image = solidSquare(20);
    const result = applyTokenMask(image, 'circle', 0);
    for (let i = 0; i < result.rgba.length; i += 4) {
      expect(result.rgba[i]).toBe(200);
      expect(result.rgba[i + 1]).toBe(100);
      expect(result.rgba[i + 2]).toBe(50);
    }
  });

  it('featherPx > 0 daje POSREDNIA wartosc alfa tuz na granicy maski (nie ostry skok 0/255)', () => {
    const image = solidSquare(60);
    const hard = applyTokenMask(image, 'circle', 0);
    const soft = applyTokenMask(image, 'circle', 3);
    // Znajdz piksel na hard-masce, ktory jest na granicy (sasiaduje z przezroczystym).
    let boundaryX = -1;
    let boundaryY = -1;
    outer: for (let y = 0; y < 60; y++) {
      for (let x = 1; x < 60; x++) {
        if (alphaAt(hard, x, y) === 255 && alphaAt(hard, x - 1, y) === 0) {
          boundaryX = x;
          boundaryY = y;
          break outer;
        }
      }
    }
    expect(boundaryX).toBeGreaterThanOrEqual(0);
    const softAlpha = alphaAt(soft, boundaryX, boundaryY);
    expect(softAlpha).toBeGreaterThan(0);
    expect(softAlpha).toBeLessThan(255);
  });

  it('nie mutuje wejscia', () => {
    const image = solidSquare(20);
    const snapshot = image.rgba.slice();
    applyTokenMask(image, 'hex', 1);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});
