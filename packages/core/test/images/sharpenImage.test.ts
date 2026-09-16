import { describe, expect, it } from 'vitest';
import { sharpenImage } from '../../src/images/sharpenImage.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solidImage(size: number, gray: number, alpha = 255): DecodedImage {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = alpha;
  }
  return { width: size, height: size, rgba };
}
function channelAt(image: DecodedImage, x: number, y: number, c: number): number {
  return image.rgba[(y * image.width + x) * 4 + c]!;
}

describe('sharpenImage', () => {
  it('amount=0 -> kopia bez zmiany', () => {
    const image = solidImage(10, 120);
    const result = sharpenImage(image, { radiusPx: 2, amount: 0 });
    expect(Array.from(result.rgba)).toEqual(Array.from(image.rgba));
  });

  it('radiusPx=0 -> kopia bez zmiany', () => {
    const image = solidImage(10, 120);
    const result = sharpenImage(image, { radiusPx: 0, amount: 0.8 });
    expect(Array.from(result.rgba)).toEqual(Array.from(image.rgba));
  });

  it('jednolity obraz (brak detalu) pozostaje bez zmian — rozmycie jednolitego obszaru = ten sam obszar, roznica zero', () => {
    const image = solidImage(20, 150);
    const result = sharpenImage(image, { radiusPx: 2, amount: 1 });
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect(channelAt(result, x, y, 0)).toBe(150);
  });

  it('pojedynczy jasny piksel na ciemnym tle: piksel robi sie JESZCZE JASNIEJSZY (lokalna srednia byla nizsza), bezposredni sasiad robi sie CIEMNIEJSZY (typowe "halo" wyostrzania)', () => {
    const image = solidImage(20, 50);
    const centerIdx = (10 * 20 + 10) * 4;
    image.rgba[centerIdx] = 200;
    image.rgba[centerIdx + 1] = 200;
    image.rgba[centerIdx + 2] = 200;
    const result = sharpenImage(image, { radiusPx: 2, amount: 1 });
    expect(channelAt(result, 10, 10, 0)).toBeGreaterThan(200);
    expect(channelAt(result, 11, 10, 0)).toBeLessThan(50);
  });

  it('alfa nigdy nie jest ruszana', () => {
    const image = solidImage(10, 100, 180);
    const result = sharpenImage(image, { radiusPx: 1, amount: 0.6 });
    for (let i = 3; i < result.rgba.length; i += 4) expect(result.rgba[i]).toBe(180);
  });

  it('wynik jest zawsze clampowany do [0,255]', () => {
    const image = solidImage(20, 250);
    const centerIdx = (10 * 20 + 10) * 4;
    image.rgba[centerIdx] = 255;
    image.rgba[centerIdx + 1] = 255;
    image.rgba[centerIdx + 2] = 255;
    const result = sharpenImage(image, { radiusPx: 3, amount: 5 }); // celowo agresywne wzmocnienie
    for (const v of result.rgba) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it('nie mutuje wejscia', () => {
    const image = solidImage(10, 100);
    const snapshot = image.rgba.slice();
    sharpenImage(image, { radiusPx: 2, amount: 0.7 });
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });
});
