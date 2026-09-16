import { describe, expect, it } from 'vitest';
import { featherAlpha } from '../../src/images/featherAlpha.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** Plaski obraz `width x height`, RGB staly, alfa wedlug `alphaAt(x,y)`. */
function buildImage(width: number, height: number, alphaAt: (x: number, y: number) => number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 10;
      rgba[idx + 1] = 20;
      rgba[idx + 2] = 30;
      rgba[idx + 3] = alphaAt(x, y);
    }
  }
  return { width, height, rgba };
}

function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}

describe('featherAlpha', () => {
  it('promien=0 -> kopia bez zmian', () => {
    const image = buildImage(4, 4, () => 128);
    const result = featherAlpha(image, 0);
    expect(Array.from(result.rgba)).toEqual(Array.from(image.rgba));
    expect(result.rgba).not.toBe(image.rgba);
  });

  it('jednolita alfa (cala 0 albo cala 255) pozostaje bez zmian — rozmycie jednolitego obszaru to ten sam obszar', () => {
    const opaque = buildImage(20, 20, () => 255);
    const blurredOpaque = featherAlpha(opaque, 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(blurredOpaque, x, y)).toBe(255);

    const transparent = buildImage(20, 20, () => 0);
    const blurredTransparent = featherAlpha(transparent, 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(alphaAt(blurredTransparent, x, y)).toBe(0);
  });

  it('kanaly RGB nigdy nie sa ruszane, tylko alfa', () => {
    const image = buildImage(10, 10, (x) => (x < 5 ? 0 : 255));
    const result = featherAlpha(image, 2);
    for (let i = 0; i < result.rgba.length; i += 4) {
      expect(result.rgba[i]).toBe(10);
      expect(result.rgba[i + 1]).toBe(20);
      expect(result.rgba[i + 2]).toBe(30);
    }
  });

  it('ostra krawedz (skok 0->255) dostaje symetryczne, plynne przejscie o szerokosci ~2*promien wokol granicy, daleko od niej zostaje twarda', () => {
    const width = 40;
    const image = buildImage(width, 1, (x) => (x < 20 ? 0 : 255));
    const radius = 3;
    const result = featherAlpha(image, radius);

    // Daleko od granicy (poza pasmem promienia) — bez zmian.
    expect(alphaAt(result, 0, 0)).toBe(0);
    expect(alphaAt(result, width - 1, 0)).toBe(255);

    // Dokladnie na granicy (x=20, pierwszy piksel "255" strony) — okno
    // szerokosci 2*radius+1 wysrodkowane na x=20 obejmuje x=17..23: 3 piksele
    // "0" (17,18,19) i 4 piksele "255" (20,21,22,23) -> srednia = 4/7*255.
    const expectedAtBoundary = Math.round((4 / 7) * 255);
    expect(alphaAt(result, 20, 0)).toBe(expectedAtBoundary);

    // Symetria: piksel TUZ PRZED granica (x=19, ostatni "0") ma dopelniajacy
    // udzial (3/7 zamiast 4/7) — 17..19 zawiera 3 "0" i okno 16..22 zawiera
    // 4 "0" (16,17,18,19) i 3 "255" (20,21,22) -> 3/7*255.
    const expectedJustBefore = Math.round((3 / 7) * 255);
    expect(alphaAt(result, 19, 0)).toBe(expectedJustBefore);

    // Przejscie jest MONOTONICZNE rosnace przez pasmo graniczne.
    const band = [17, 18, 19, 20, 21, 22, 23].map((x) => alphaAt(result, x, 0));
    for (let i = 1; i < band.length; i++) expect(band[i]!).toBeGreaterThanOrEqual(band[i - 1]!);
  });

  it('nie mutuje wejscia', () => {
    const image = buildImage(6, 6, (x) => (x < 3 ? 0 : 255));
    const snapshot = image.rgba.slice();
    featherAlpha(image, 2);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});
