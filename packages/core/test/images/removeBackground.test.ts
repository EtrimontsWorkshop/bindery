import { describe, expect, it } from 'vitest';
import { removeBackground, DEFAULT_REMOVE_BACKGROUND } from '../../src/images/removeBackground.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** Plaskie, jednolite plotno danego koloru RGB (alfa=255 wszedzie). */
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

/** Maluje prostokat [x,y,w,h] na `image` (w miejscu) na dany kolor. */
function paintRect(image: DecodedImage, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const idx = (row * image.width + col) * 4;
      image.rgba[idx] = r;
      image.rgba[idx + 1] = g;
      image.rgba[idx + 2] = b;
    }
  }
}

function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.rgba[(y * image.width + x) * 4 + 3]!;
}
function rgbAt(image: DecodedImage, x: number, y: number): [number, number, number] {
  const idx = (y * image.width + x) * 4;
  return [image.rgba[idx]!, image.rgba[idx + 1]!, image.rgba[idx + 2]!];
}

describe('removeBackground', () => {
  it('jednolite tlo (cale plotno jeden kolor, brak tresci) -> przekracza limit powierzchni, PRZERYWA i zwraca oryginal bez zmian', () => {
    const image = solidCanvas(30, 30, 220, 210, 190);
    const result = removeBackground(image, { tolerance: 20, featherPx: 1, maxAreaFraction: 0.6 });
    expect(result.aborted).toBe(true);
    expect(result.removedFraction).toBeCloseTo(1, 5);
    expect(Array.from(result.image.rgba)).toEqual(Array.from(image.rgba));
  });

  it('tlo + wyspa tresci NIEDOTYKAJACA zadnego rogu -> tlo usuniete (alfa 0), tresc zachowana (alfa 255), RGB tresci bez zmian', () => {
    const image = solidCanvas(60, 60, 230, 225, 210);
    paintRect(image, 20, 20, 20, 20, 40, 60, 90); // tresc to 400/3600=11% powierzchni, tlo ~89% — WIECEJ niz domyslny limit 60%, `maxAreaFraction` podniesiony w tym tescie celowo, zeby przetestowac MECHANIKE usuwania w oderwaniu od zabezpieczenia (ktore ma wlasny, dedykowany test wyzej)
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95 });
    expect(result.aborted).toBe(false);
    expect(result.removedFraction).toBeGreaterThan(0.85);
    expect(result.removedFraction).toBeLessThan(0.9);

    // Rogi (tlo) -> przezroczyste.
    expect(alphaAt(result.image, 0, 0)).toBe(0);
    expect(alphaAt(result.image, 59, 59)).toBe(0);
    // Srodek wyspy tresci -> nadal nieprzezroczysty, kolor niezmieniony.
    expect(alphaAt(result.image, 30, 30)).toBe(255);
    expect(rgbAt(result.image, 30, 30)).toEqual([40, 60, 90]);
  });

  it('lancuchowa tolerancja pozwala rozlac sie przez DELIKATNY gradient tla (kazdy krok maly), ale zatrzymuje sie na OSTREJ krawedzi tresci', () => {
    const width = 50;
    const height = 50;
    const image = solidCanvas(width, height, 200, 200, 200);
    // Delikatny gradient poziomy tla: +1 na kolumne, od 200 do 249 — kazdy
    // pojedynczy krok (1) jest DUZO mniejszy niz tolerancja (10), ale suma na
    // calej szerokosci (49) przekracza ja z duzym zapasem — sprawdza, ze
    // porownanie lancuchowe (nie do stalego rogu) NIE zatrzymuje sie na tym.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const shade = 200 + x;
        image.rgba[idx] = shade;
        image.rgba[idx + 1] = shade;
        image.rgba[idx + 2] = shade;
      }
    }
    // Prawdziwa tresc: ostry, kontrastowy kwadrat w srodku (OSTRA krawedz, >> tolerancja).
    paintRect(image, 20, 20, 10, 10, 10, 10, 10);

    const result = removeBackground(image, { tolerance: 10, featherPx: 0, maxAreaFraction: 0.98 });
    expect(result.aborted).toBe(false);
    // Caly gradientowy pasek tla usuniety az do prawej krawedzi (rog x=49 tez tlo).
    expect(alphaAt(result.image, width - 1, 0)).toBe(0);
    // Tresc w srodku zachowana.
    expect(alphaAt(result.image, 25, 25)).toBe(255);
  });

  it('featherPx > 0 daje POSREDNIA (nie 0/255) wartosc alfa tuz na granicy usunietego tla', () => {
    const image = solidCanvas(40, 40, 230, 225, 210);
    paintRect(image, 15, 15, 10, 10, 20, 30, 40);
    const result = removeBackground(image, { tolerance: 15, featherPx: 3, maxAreaFraction: 0.95 });
    const boundaryAlpha = alphaAt(result.image, 15, 20); // lewa krawedz wyspy tresci
    expect(boundaryAlpha).toBeGreaterThan(0);
    expect(boundaryAlpha).toBeLessThan(255);
  });

  it('nie mutuje wejscia', () => {
    const image = solidCanvas(20, 20, 230, 225, 210);
    paintRect(image, 5, 5, 5, 5, 10, 10, 10);
    const snapshot = image.rgba.slice();
    removeBackground(image, DEFAULT_REMOVE_BACKGROUND);
    expect(Array.from(image.rgba)).toEqual(Array.from(snapshot));
  });

  it('pusty obraz (0x0) nie wywraca sie, zwraca bez usuwania', () => {
    const image: DecodedImage = { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
    const result = removeBackground(image, DEFAULT_REMOVE_BACKGROUND);
    expect(result.aborted).toBe(false);
    expect(result.removedFraction).toBe(0);
  });

  /** Kwadratowy "pierscien" tresci (kolor kontrastowy) na tle jednolitego koloru — otacza kieszen SRODKA o kolorze TLA, calkowicie odcieta od brzegu obrazu (ten sam ksztalt problemu co "ronde kapelusza laczace sie z ramieniem" ze zgloszenia). */
  function ringWithEnclosedPocket(): DecodedImage {
    const image = solidCanvas(40, 40, 230, 225, 210);
    for (let y = 10; y <= 29; y++) {
      for (let x = 10; x <= 29; x++) {
        const isRing = x < 12 || x > 27 || y < 12 || y > 27;
        if (isRing) {
          const idx = (y * image.width + x) * 4;
          image.rgba[idx] = 10;
          image.rgba[idx + 1] = 10;
          image.rgba[idx + 2] = 10;
        }
      }
    }
    return image;
  }

  it('[ZGLOSZENIE-doklikniecie-tla Z1] kieszen tla odcieta od brzegu przez zamkniety pierscien tresci NIE jest usuwana samym rozlewem od rogow', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95 });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 0, 0)).toBe(0); // tlo zewnetrzne usuniete
    expect(alphaAt(result.image, 20, 20)).toBe(255); // kieszen w srodku NIEOSIAGALNA z zadnego rogu — nietknieta
    expect(rgbAt(result.image, 10, 20)).toEqual([10, 10, 10]); // pierscien (tresc) zachowany
  });

  it('[ZGLOSZENIE-doklikniecie-tla Z1] `extraSeeds` we wnetrzu kieszeni usuwa ja, nie ruszajac otaczajacego pierscienia tresci', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95, extraSeeds: [{ x: 20, y: 20 }] });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 0, 0)).toBe(0); // zewnetrzne tlo nadal usuniete
    expect(alphaAt(result.image, 20, 20)).toBe(0); // kieszen TERAZ usunieta dzieki dokliknieciu
    expect(rgbAt(result.image, 10, 20)).toEqual([10, 10, 10]); // pierscien nietkniety kolorystycznie
    expect(alphaAt(result.image, 10, 20)).toBe(255); // ...i nieprzezroczysty — rozlew z wnetrza kieszeni zatrzymal sie na OSTRYM skoku koloru pierscienia
  });

  it('[ZGLOSZENIE-doklikniecie-tla Z1] limit powierzchni liczony NARASTAJACO — rogi + `extraSeeds` razem przekraczaja limit, mimo ze SAM rozlew od rogow miescilby sie w nim', () => {
    const image = ringWithEnclosedPocket();
    // Bez dokliknieia: tlo zewnetrzne to (1600 - 400)/1600 = 75% powierzchni -- juz samo w sobie ponad 60%, wiec podnosimy limit tak, zeby SAM rozlew od rogow mieescil sie w nim, ale suma z kieszenia (kolejne ~256/1600=16%) juz nie.
    const onlyCorners = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.99 });
    expect(onlyCorners.aborted).toBe(false);
    const tightLimit = onlyCorners.removedFraction + 0.05; // odrobine ponad SAM rozlew od rogow — nie miesci dodatkowej kieszeni
    const withPocket = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: tightLimit, extraSeeds: [{ x: 20, y: 20 }] });
    expect(withPocket.aborted).toBe(true);
    expect(withPocket.removedFraction).toBeGreaterThan(onlyCorners.removedFraction);
    expect(Array.from(withPocket.image.rgba)).toEqual(Array.from(image.rgba)); // PRZERWANE -> oryginal bez zmian
  });

  it('[ZGLOSZENIE-doklikniecie-tla Z1] `extraSeeds` poza granicami obrazu jest bezpiecznie pomijane (bez bledu, bez efektu)', () => {
    const image = ringWithEnclosedPocket();
    const result = removeBackground(image, { tolerance: 15, featherPx: 0, maxAreaFraction: 0.95, extraSeeds: [{ x: -5, y: 500 }] });
    expect(result.aborted).toBe(false);
    expect(alphaAt(result.image, 20, 20)).toBe(255); // kieszen nietknieta -- poza-obrazowy punkt nie mial efektu
  });
});
