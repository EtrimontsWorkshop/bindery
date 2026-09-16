import { describe, expect, it } from 'vitest';
import { inscribedRotatedRectScale } from '../src/geometry.js';

/**
 * Weryfikacja NIEZALEZNA od formuly w `inscribedRotatedRectScale`: dla danego
 * `s`, sprawdza wprost geometrycznie (obrot rogow prostokata `s*width x
 * s*height` WSTECZ o `angleRad`), czy WSZYSTKIE 4 rogi ladujol w oryginalnym,
 * nieobroconym prostokacie `width x height` (z malym marginesem tolerancji na
 * blad zmiennoprzecinkowy) — dokladnie ten sam wzorzec co reszta testow tego
 * projektu ("nie sprawdzaj formuly produkcyjnej samej przez siebie").
 */
function fitsInsideRotatedOriginal(width: number, height: number, angleRad: number, s: number): boolean {
  const a = width / 2;
  const b = height / 2;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const EPS = 1e-6;
  const corners: Array<[number, number]> = [
    [s * a, s * b],
    [s * a, -s * b],
    [-s * a, s * b],
    [-s * a, -s * b],
  ];
  return corners.every(([x, y]) => {
    const localX = cos * x + sin * y;
    const localY = -sin * x + cos * y;
    return Math.abs(localX) <= a + EPS && Math.abs(localY) <= b + EPS;
  });
}

describe('inscribedRotatedRectScale', () => {
  it('kat=0 -> pelny rozmiar (s=1), niezaleznie od proporcji', () => {
    expect(inscribedRotatedRectScale(100, 50, 0)).toBeCloseTo(1, 10);
    expect(inscribedRotatedRectScale(50, 100, 0)).toBeCloseTo(1, 10);
    expect(inscribedRotatedRectScale(100, 100, 0)).toBeCloseTo(1, 10);
  });

  it('[znany wynik geometryczny] kwadrat obrocony o 45° -> s=1/√2', () => {
    expect(inscribedRotatedRectScale(100, 100, Math.PI / 4)).toBeCloseTo(1 / Math.sqrt(2), 10);
  });

  it('[wprost policzony przyklad] prostokat 2:1 obrocony o 90° -> s=0.5 (najdluzsza krawedz musi zmiescic sie w najkrotszej)', () => {
    expect(inscribedRotatedRectScale(100, 50, Math.PI / 2)).toBeCloseTo(0.5, 10);
    expect(inscribedRotatedRectScale(50, 100, Math.PI / 2)).toBeCloseTo(0.5, 10);
  });

  it('symetryczne wzgledem znaku kata (obrot w lewo/prawo o ten sam kat daje ten sam wynik)', () => {
    const s1 = inscribedRotatedRectScale(120, 80, 0.3);
    const s2 = inscribedRotatedRectScale(120, 80, -0.3);
    expect(s1).toBeCloseTo(s2, 10);
  });

  it('maleje monotonicznie z rosnacym katem w zakresie MALYCH katow [0°, 30°] — jedyny zakres, ktory faktycznie uzywa ten projekt (krok #rotateImage to stale 10°)', () => {
    const angles = [0, 5, 10, 15, 20, 25, 30].map((deg) => (deg * Math.PI) / 180);
    const scales = angles.map((a) => inscribedRotatedRectScale(200, 120, a));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]!).toBeLessThanOrEqual(scales[i - 1]! + 1e-9);
    }
    expect(scales[0]).toBeCloseTo(1, 10);
  });

  it('[odkryte przy pisaniu tego testu] NIE jest monotoniczna na calym [0°,90°] dla prostokatow o proporcjach dalekich od kwadratu — minimum wypada w okolicy 55-65°, potem s ROSNIE az do 90° (fizycznie sensowne: przy 90° "dlugi" bok znowu wpasowuje sie latwiej w zamienione wymiary otoczki). Test dokumentuje ten fakt wprost, zeby nikt pozniej nie "naprawil" formuly w reakcji na pozornie dziwny wynik.', () => {
    const s60 = inscribedRotatedRectScale(200, 120, (60 * Math.PI) / 180);
    const s90 = inscribedRotatedRectScale(200, 120, (90 * Math.PI) / 180);
    expect(s90).toBeGreaterThan(s60);
    expect(s90).toBeCloseTo(0.6, 6);
  });

  it('nigdy nie przekracza 1 (degenerate/zerowe wymiary)', () => {
    expect(inscribedRotatedRectScale(0, 100, 0.2)).toBeLessThanOrEqual(1);
    expect(inscribedRotatedRectScale(100, 0, 0.2)).toBeLessThanOrEqual(1);
  });

  it('[weryfikacja niezalezna] dla realistycznego kroku obrotu (10°) na typowej stronie 3:4, wynik faktycznie miesci sie CALY w oryginale', () => {
    const width = 900;
    const height = 1200;
    const angleRad = (10 * Math.PI) / 180;
    const s = inscribedRotatedRectScale(width, height, angleRad);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThan(0.7);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
    // "Ciasny" wynik — powiekszenie o promil juz nie powinno sie miescic.
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s * 1.001)).toBe(false);
  });

  it('[weryfikacja niezalezna] dziala poprawnie takze dla proporcji szerszych niz wyzszych (landscape)', () => {
    const width = 1600;
    const height = 900;
    const angleRad = (25 * Math.PI) / 180;
    const s = inscribedRotatedRectScale(width, height, angleRad);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
    expect(fitsInsideRotatedOriginal(width, height, angleRad, s * 1.001)).toBe(false);
  });

  describe('[naprawa zgloszonego bledu — "po 36 obrotach po 10° obraz sie kurczy" ujawnil TEZ, ze dla katow > 90° stara wersja dawala UJEMNE, bezsensowne wyniki] katy poza [-90°,90°]', () => {
    const width = 900;
    const height = 1200;

    it('170°/190°/350° daja DODATNI wynik, faktycznie mieszczacy sie w oryginale (przed naprawa: ujemny)', () => {
      for (const deg of [170, 190, 350]) {
        const angleRad = (deg * Math.PI) / 180;
        const s = inscribedRotatedRectScale(width, height, angleRad);
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(fitsInsideRotatedOriginal(width, height, angleRad, s)).toBe(true);
      }
    });

    it('okres 180° (symetria srodkowa prostokata): 10°, 170°(=180-10), 190°(=180+10) i -170°(=10-180) daja DOKLADNIE ten sam wynik co 10°', () => {
      const base = inscribedRotatedRectScale(width, height, (10 * Math.PI) / 180);
      for (const deg of [170, 190, -170, 350, -350]) {
        expect(inscribedRotatedRectScale(width, height, (deg * Math.PI) / 180)).toBeCloseTo(base, 10);
      }
    });

    it('wielokrotne pelne obroty (725° = 2*360°+5°) redukuja sie poprawnie do kata 5°', () => {
      const base = inscribedRotatedRectScale(width, height, (5 * Math.PI) / 180);
      expect(inscribedRotatedRectScale(width, height, (725 * Math.PI) / 180)).toBeCloseTo(base, 10);
      expect(inscribedRotatedRectScale(width, height, (-715 * Math.PI) / 180)).toBeCloseTo(base, 10);
    });

    it('kat=360° (pelny obrot) -> s=1, DOKLADNIE jak kat=0° — kluczowe dla "36 klikniec po 10° wraca do oryginalu" (`#rotateImage` normalizuje sumaryczny kat modulo 360° w stopniach, wiec w praktyce zawsze przekazuje 0°, ale ta funkcja MUSI byc poprawna tez wprost dla 360° samodzielnie)', () => {
      expect(inscribedRotatedRectScale(width, height, 2 * Math.PI)).toBeCloseTo(1, 10);
    });
  });
});
