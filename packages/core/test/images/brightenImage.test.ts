import { describe, expect, it } from 'vitest';
import { brightenCroppedImage, type BrightenOptions } from '../../src/images/brightenImage.js';

/** Buduje obraz jednolitego koloru (wszystkie piksele identyczne) — percentyl dolny = ta wartosc, niezaleznie od percentyla. */
function solidImage(gray: number, count = 100): { width: number; height: number; rgba: Uint8ClampedArray } {
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = gray;
    rgba[i * 4 + 1] = gray;
    rgba[i * 4 + 2] = gray;
    rgba[i * 4 + 3] = 255;
  }
  return { width: count, height: 1, rgba };
}

/** `contrastFactor: 1` = krok kontrastu bez efektu, zeby testy poziomow/gamma nie musialy sie martwic o trzeci krok. */
const NEUTRAL_CONTRAST: Pick<BrightenOptions, 'contrastFactor' | 'contrastPivot'> = { contrastFactor: 1, contrastPivot: 128 };

describe('brightenCroppedImage', () => {
  it('rozjasnia srodkowe wartosci', () => {
    const image = solidImage(150);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThan(150);
    expect(out.rgba[3]!).toBe(255); // alfa bez zmian
  });

  it('[zmierzony na zywo problem, "rozjasnienie nie dziala" na portrecie z prawie-czarna winieta] podnosi PRAWDZIWA czern (0) do okolic targetFloor', () => {
    const image = solidImage(0);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThan(60); // gamma<1 podnosi jeszcze troche wyzej niz sam targetFloor
  });

  it('biel zostaje biela (rozciagniecie i gamma nie przepalaja juz jasnych partii)', () => {
    const image = solidImage(255);
    const out = brightenCroppedImage(image, { targetFloor: 75, floorPercentile: 0.01, gamma: 0.95, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBe(255);
    expect(out.rgba[3]!).toBe(255);
  });

  it('[sedno naprawy Z1] obraz z BARDZO ciemnym dnem (percentyl bliski 0) dostaje WIEKSZE rozjasnienie niz obraz, ktorego dno jest juz umiarkowanie jasne — jeden `targetFloor` nie oznacza tego samego przesuniecia dla obu', () => {
    const nearBlackFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([5, 5, 5, 255, 200, 200, 200, 255]) };
    const moderateFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([21, 21, 21, 255, 200, 200, 200, 255]) };
    const opts = { targetFloor: 75, floorPercentile: 0.5, gamma: 0.95, ...NEUTRAL_CONTRAST };
    const outNearBlack = brightenCroppedImage(nearBlackFloor, opts);
    const outModerate = brightenCroppedImage(moderateFloor, opts);
    // Obie zaczynaja od tego samego "wysokiego" piksela (200) -- porownujemy PRZESUNIECIE ich wlasnego dolnego percentyla.
    const shiftNearBlack = outNearBlack.rgba[0]! - 5;
    const shiftModerate = outModerate.rgba[0]! - 21;
    expect(shiftNearBlack).toBeGreaterThan(shiftModerate);
  });

  it('gdy targetFloor rowna sie WLASNEMU dolnemu percentylowi obrazu, gamma=1 i kontrast neutralny, przeliczenie jest identycznoscia', () => {
    const image = solidImage(100); // jednolity obraz -> dolny percentyl = 100 dla dowolnego progu
    const out = brightenCroppedImage(image, { targetFloor: 100, floorPercentile: 0.5, gamma: 1, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBe(100);
  });

  it('[zabezpieczenie] obraz, ktorego wlasny dolny percentyl jest JUZ jasniejszy niz targetFloor, nie zostaje przyciemniony (np. jasna sceneria bez glebokich cieni)', () => {
    const brightFloor = { width: 2, height: 1, rgba: new Uint8ClampedArray([120, 120, 120, 255, 220, 220, 220, 255]) };
    const out = brightenCroppedImage(brightFloor, { targetFloor: 75, floorPercentile: 0.5, gamma: 1, ...NEUTRAL_CONTRAST });
    expect(out.rgba[0]!).toBeGreaterThanOrEqual(120); // nigdy ciemniej niz oryginal
  });

  it('[zgloszenie uzytkownika, "jest teraz dosc jasno, ale straciło trochę kontrastu"] contrastFactor>1 ODDALA wartosci PONIZEJ pivotu od siebie mocniej niz contrastFactor=1 (rosnaca rozpietosc cieni, nie plaski wynik rozciagniecia)', () => {
    const shadow = { width: 1, height: 1, rgba: new Uint8ClampedArray([60, 60, 60, 255]) };
    const darkerShadow = { width: 1, height: 1, rgba: new Uint8ClampedArray([40, 40, 40, 255]) };
    const flat = { targetFloor: 0, floorPercentile: 0, gamma: 1, contrastFactor: 1, contrastPivot: 150 };
    const punchy = { targetFloor: 0, floorPercentile: 0, gamma: 1, contrastFactor: 1.25, contrastPivot: 150 };
    const gapFlat = brightenCroppedImage(shadow, flat).rgba[0]! - brightenCroppedImage(darkerShadow, flat).rgba[0]!;
    const gapPunchy = brightenCroppedImage(shadow, punchy).rgba[0]! - brightenCroppedImage(darkerShadow, punchy).rgba[0]!;
    expect(gapPunchy).toBeGreaterThan(gapFlat);
  });

  it('zachowuje wymiary obrazu i nie modyfikuje wejscia w miejscu', () => {
    const image = { width: 3, height: 2, rgba: new Uint8ClampedArray(3 * 2 * 4).fill(50) };
    const original = Array.from(image.rgba);
    const out = brightenCroppedImage(image);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(Array.from(image.rgba)).toEqual(original);
  });
});
