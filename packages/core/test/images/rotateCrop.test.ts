import { describe, expect, it } from 'vitest';
import { rotateAndCropImage } from '../../src/images/rotateCrop.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * 20x20 czarny obraz z bialym blokiem 3x3 wysrodkowanym na (markerX,markerY)
 * — celowo BLOK, nie pojedynczy piksel: srodek SYMETRYCZNEGO bloku zostaje
 * dokladnie w miejscu geometrycznego srodka bloku NIEZALEZNIE od dwuliniowego
 * rozmycia przy probkowaniu pod katem (w odroznieniu od pojedynczego piksela,
 * ktorego "srodek" po rozmyciu potrafi przesunac sie o czesc piksela w
 * zaleznosci od tego, jak siatka probkowania akurat wypada wzgledem granic
 * pikseli — zmierzone wprost pierwsza wersja tego testu, patrz historia).
 */
function markerImage(markerX: number, markerY: number): DecodedImage {
  const width = 20;
  const height = 20;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = 255; // czarne, ale nieprzezroczyste
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const idx = ((markerY + dy) * width + (markerX + dx)) * 4;
      rgba[idx] = 255;
      rgba[idx + 1] = 255;
      rgba[idx + 2] = 255;
      rgba[idx + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Wazona jasnoscia SREDNIA pozycja (centroid), w TEJ SAMEJ konwencji co
 * `rotateAndCropImage`/`sampleBilinear` (calkowita wspolrzedna = SRODEK
 * danego piksela, zero "+0.5" — dwuliniowa interpolacja traktuje calkowita
 * wspolrzedna jako "dokladnie ten piksel, zero mieszania"). Centroid (nie
 * pojedynczy najjasniejszy piksel) jest odporny na rozmycie od dwuliniowej
 * interpolacji pod katem/przy przesunieciu u{ł}amkowym.
 */
function findMarker(image: DecodedImage): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (y * image.width + x) * 4;
      const brightness = image.rgba[idx]! + image.rgba[idx + 1]! + image.rgba[idx + 2]!;
      sumX += x * brightness;
      sumY += y * brightness;
      sumWeight += brightness;
    }
  }
  return { x: sumX / sumWeight, y: sumY / sumWeight };
}

const CENTER = 10; // srodek 20x20 zrodla (geometrycznie na wspolrzednej ciaglej 10.0)

describe('rotateAndCropImage', () => {
  it('rotationRad=0, ten sam srodek i rozmiar -> odtwarza zrodlo 1:1 (identycznosc)', () => {
    const source = markerImage(14, CENTER); // 4px na prawo od srodka
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0 });
    const marker = findMarker(result);
    expect(marker.x).toBeCloseTo(14, 1);
    expect(marker.y).toBeCloseTo(10, 1);
  });

  it('obrot o 180° -> znacznik ladowuje sie DOKLADNIE po przeciwnej stronie srodka (jednoznaczne niezaleznie od kierunku obrotu)', () => {
    const source = markerImage(14, CENTER); // offset (+4, 0) od srodka
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI });
    const marker = findMarker(result);
    // Oczekiwany offset: (-4, 0) od srodka wyjscia (ten sam rozmiar).
    expect(marker.x).toBeCloseTo(6, 1);
    expect(marker.y).toBeCloseTo(10, 1);
  });

  it('obrot o 90° przesuwa znacznik o cwierc obrotu wokol srodka, zachowujac promien (odleglosc od srodka)', () => {
    const source = markerImage(15, CENTER); // offset (+5, 0) od srodka
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI / 2 });
    const marker = findMarker(result);
    const dx = marker.x - CENTER;
    const dy = marker.y - CENTER;
    // Promien zachowany (obrot nie przesuwa punktu blizej/dalej od srodka).
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 1);
    // [Konwencja tej funkcji, zweryfikowana wprost tym testem] `rotationRad=+90°`
    // przesuwa znacznik z "na prawo od srodka" na "nad srodkiem" (dy ujemne,
    // dx ~0) — NIE pod spod. Jesli integracja z UI (kierunek przeciagania
    // uchwytu obrotu) okaze sie odwrotna, jedyna poprawka to negacja kata w
    // JEDNYM miejscu wywolania (`renderRotatedRegion.ts`), nie tutaj.
    expect(dx).toBeCloseTo(0, 0);
    expect(dy).toBeLessThan(-4);
  });

  it('piksele poza zrodlem probkowane jako przezroczyste/czarne (brak wyjatku, brak "zawijania")', () => {
    const source = markerImage(1, 1);
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 60, outputHeight: 60, rotationRad: 0.3 });
    expect(result.width).toBe(60);
    expect(result.height).toBe(60);
    // Rogi daleko poza oryginalnym 20x20 zrodlem musza byc puste (alpha=0).
    const cornerIdx = (0 * 60 + 0) * 4;
    expect(result.rgba[cornerIdx + 3]).toBe(0);
  });

  it('rozmiar wyjscia jest zaokraglany do liczb calkowitych i przynajmniej 1x1', () => {
    const source = markerImage(CENTER, CENTER);
    const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 0.4, outputHeight: 12.6, rotationRad: 0 });
    expect(result.width).toBe(1);
    expect(result.height).toBe(13);
  });

  describe('[KROK-42 Z2, "kadrowanie i zoom wewnatrz maski tokenu"] parametr scale', () => {
    it('scale=1 jawnie podane -> identyczne z pominieciem pola (domyslne zachowanie, regresja)', () => {
      const source = markerImage(15, CENTER);
      const withDefault = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0 });
      const withExplicit1 = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0, scale: 1 });
      expect(Array.from(withExplicit1.rgba)).toEqual(Array.from(withDefault.rgba));
    });

    it('scale=2 ODDALA (kazdy piksel wyjscia = 2 piksele zrodla) — offset znacznika w wyjsciu jest POLOWA offsetu w zrodle', () => {
      const source = markerImage(15, CENTER); // offset +5 od srodka w zrodle
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: 0, scale: 2 });
      const marker = findMarker(result);
      expect(marker.x - CENTER).toBeCloseTo(2.5, 1);
      expect(marker.y - CENTER).toBeCloseTo(0, 1);
    });

    it('scale=0.5 PRZYBLIZA (kazdy piksel wyjscia = pol piksela zrodla) — offset znacznika w wyjsciu jest PODWOJONY', () => {
      const source = markerImage(15, CENTER); // offset +5 od srodka w zrodle
      const outCenter = 20; // wyjscie 40x40, wlasny srodek w 20
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 40, outputHeight: 40, rotationRad: 0, scale: 0.5 });
      const marker = findMarker(result);
      expect(marker.x - outCenter).toBeCloseTo(10, 1);
      expect(marker.y - outCenter).toBeCloseTo(0, 1);
    });

    it('scale i obrot komutuja (jednorodne skalowanie) — polaczenie 90° + scale=2 daje promien PRZESKALOWANY, nie tylko obrocony', () => {
      const source = markerImage(15, CENTER); // offset +5 od srodka w zrodle (promien 5)
      const result = rotateAndCropImage(source, { centerX: CENTER, centerY: CENTER, outputWidth: 20, outputHeight: 20, rotationRad: Math.PI / 2, scale: 2 });
      const marker = findMarker(result);
      const dx = marker.x - CENTER;
      const dy = marker.y - CENTER;
      // Promien 5/scale(2) = 2.5 — ta sama geometria co test "obrot o 90°"
      // wyzej (tam scale=1, promien 5 bez zmian), tylko przeskalowana.
      expect(Math.hypot(dx, dy)).toBeCloseTo(2.5, 1);
      expect(dx).toBeCloseTo(0, 0);
      expect(dy).toBeLessThan(-2);
    });
  });
});
