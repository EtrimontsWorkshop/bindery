import { describe, expect, it } from 'vitest';
import { cropDecodedImage, detectContentBounds } from '../../src/images/cropUniformMargins.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** Plotno wypelnione jednym kolorem tla — synteza "pustej strony/marginesu". */
function solidCanvas(width: number, height: number, r: number, g: number, b: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Wypelnia prostokat [x,y,w,h] SZACHOWNICA dwoch kontrastowych kolorow — symuluje "prawdziwa ilustracje" (wysoka lokalna wariancja, nie jednolita). */
function paintNoisyRect(image: DecodedImage, x: number, y: number, w: number, h: number): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = (row * image.width + col) * 4;
      const on = (row + col) % 2 === 0;
      image.rgba[i] = on ? 20 : 230;
      image.rgba[i + 1] = on ? 40 : 60;
      image.rgba[i + 2] = on ? 60 : 20;
      image.rgba[i + 3] = 255;
    }
  }
}

describe('detectContentBounds — [na zyczenie uzytkownika] przycinanie pustego marginesu wokol malej ilustracji', () => {
  it('mala szachownicowa "ilustracja" w rogu duzego jednolitego tla -> wykryty prostokat WYRAZNIE mniejszy niz cale plotno, obejmuje ilustracje', () => {
    const image = solidCanvas(400, 500, 230, 220, 200); // jednolite bezowe "tlo papieru"
    // [kalibracja] Ilustracja MUSI zajmowac spora CZESC dlugosci wiersza/kolumny,
    // ktora przecina — inaczej test "wlasnej sredniej" (patrz naglowek
    // cropUniformMargins.ts) rozcienczyloby ja tak, ze caly wiersz/kolumna
    // WCIAZ wyglada na "nudny" wzgledem swojej wlasnej (juz przesunietej)
    // sredniej. Zmierzone wprost: 100x120 w 400x500 (25%/24%) dawalo pokrycie
    // dokladnie NA progu (~0.75) i test byl niestabilny; 180x220 (45%/44%)
    // daje jednoznaczne rozdzielenie.
    paintNoisyRect(image, 110, 90, 180, 220); // "portret", nie dotyka zadnej krawedzi
    const bounds = detectContentBounds(image);
    expect(bounds).not.toBeNull();
    const b = bounds!;
    // Wykryty prostokat MUSI obejmowac cala namalowana ilustracje...
    expect(b.x).toBeLessThanOrEqual(110);
    expect(b.y).toBeLessThanOrEqual(90);
    expect(b.x + b.width).toBeGreaterThanOrEqual(290);
    expect(b.y + b.height).toBeGreaterThanOrEqual(310);
    // ...ale byc WYRAZNIE mniejszy niz cale plotno (400x500=200000) — glowny cel przyciecia.
    expect(b.width * b.height).toBeLessThan(400 * 500 * 0.6);
  });

  it('[bezpiecznik] tresc wypelniajaca plotno niemal do krawedzi (np. rozkladowka pod pelny spad) -> null, NIE przycina', () => {
    const image = solidCanvas(400, 500, 40, 30, 20);
    paintNoisyRect(image, 2, 2, 396, 496); // "ilustracja" niemal na cala strone, 2px marginesu
    expect(detectContentBounds(image)).toBeNull();
  });

  it('[bezpiecznik] cale plotno jednolite (brak jakiejkolwiek tresci) -> null, NIE przycina do bezsensownego skrawka', () => {
    const image = solidCanvas(400, 500, 230, 220, 200);
    expect(detectContentBounds(image)).toBeNull();
  });

  it('[roznokolorowa ramka dekoracyjna] jednolity ciemny pasek z lewej + jednolity jasny "papier" na srodku (dwie ROZNE strefy) nadal poprawnie przycina do centralnej ilustracji', () => {
    // Odtwarza dokladnie zgloszony na zywo uklad Wrak.pdf: ciemny "skorzany"
    // pasek z lewej (inny kolor niz "papier"), z portretem gdzies w srodku
    // jasnej strefy. Test istnieje, bo referencja z JEDNEGO globalnego koloru
    // (np. z rogu) zawiodlaby tutaj — patrz uzasadnienie w cropUniformMargins.ts.
    const image = solidCanvas(400, 500, 230, 220, 200);
    for (let y = 0; y < 500; y++) {
      for (let x = 0; x < 40; x++) {
        const i = (y * 400 + x) * 4;
        image.rgba[i] = 50;
        image.rgba[i + 1] = 35;
        image.rgba[i + 2] = 25;
      }
    }
    // [kalibracja, patrz test wyzej] 200x220 (50%/44%), pozycjonowane z dala od
    // paska (x>=150), zeby jednoznacznie przebic prog pokrycia.
    paintNoisyRect(image, 150, 150, 200, 220);

    const bounds = detectContentBounds(image);
    expect(bounds).not.toBeNull();
    const b = bounds!;
    expect(b.x).toBeLessThanOrEqual(150);
    expect(b.x + b.width).toBeGreaterThanOrEqual(350);
    expect(b.width * b.height).toBeLessThan(400 * 500 * 0.7);
  });
});

describe('cropDecodedImage', () => {
  it('wycina dokladnie wskazany prostokat, piksel po pikselu', () => {
    const image = solidCanvas(10, 10, 0, 0, 0);
    paintNoisyRect(image, 3, 3, 2, 2);
    const cropped = cropDecodedImage(image, { x: 3, y: 3, width: 2, height: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    // Rog (3,3) w oryginale odpowiada (0,0) w wyciecu.
    const origIdx = (3 * 10 + 3) * 4;
    expect([cropped.rgba[0], cropped.rgba[1], cropped.rgba[2]]).toEqual([image.rgba[origIdx], image.rgba[origIdx + 1], image.rgba[origIdx + 2]]);
  });
});
