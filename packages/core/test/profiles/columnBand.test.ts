import { describe, expect, it } from 'vitest';
import { findColumnBand, isWithinColumnBand, type ColumnBandToken } from '../../src/profiles/columnBand.js';
import type { Rect } from '../../src/geometry.js';

function tok(minX: number, maxX: number): ColumnBandToken {
  return { bbox: { minX, maxX, minY: 0, maxY: 10 } };
}

function rect(minX: number, maxX: number): Rect {
  return { minX, maxX, minY: 0, maxY: 10 };
}

describe('findColumnBand — [zmierzony na zywo blad str. 23 "Zew Cthulhu 7ed. Wrak.pdf"]', () => {
  it('brak tokenow -> null (bezpieczny brak dzialania)', () => {
    expect(findColumnBand([], rect(0, 10))).toBeNull();
  });

  it('uklad JEDNOLAMOWY (caly tekst scala sie w jedna grupe) -> pasmo obejmuje CALA szerokosc tresci', () => {
    const tokens = [tok(72, 96), tok(100, 289), tok(72, 289), tok(150, 400)];
    const band = findColumnBand(tokens, rect(80, 90));
    expect(band).toEqual({ minX: 72, maxX: 400 });
  });

  it('[realne dane, uproszczone] uklad DWULAMOWY -- naglowek w lewej kolumnie dostaje pasmo lewej kolumny, nie pelnej strony', () => {
    // Lewa lama: waskie etykiety siatki cech (72-289) POLACZONE dlugim
    // wierszem prozy (72-289), ktory "mosci" przerwy miedzy nimi. Prawa lama:
    // proza (307-524), calkowicie odrebna, bez zadnego tokenu mostujacego.
    const leftColumn = [tok(72, 96), tok(117, 138), tok(162, 175), tok(72, 289)];
    const rightColumn = [tok(307, 400), tok(316, 523), tok(307, 524)];
    const tokens = [...leftColumn, ...rightColumn];

    const header = rect(72, 96); // "Walka" w lewej lamie
    const band = findColumnBand(tokens, header);
    expect(band).toEqual({ minX: 72, maxX: 289 });

    const rightHeader = rect(307, 400);
    const rightBand = findColumnBand(tokens, rightHeader);
    expect(rightBand).toEqual({ minX: 307, maxX: 524 });
  });

  it('cel POZA jakakolwiek grupa (np. token spoza dostarczonej listy) -> null', () => {
    const tokens = [tok(72, 96), tok(72, 289)];
    expect(findColumnBand(tokens, rect(1000, 1010))).toBeNull();
  });

  it('przedzialy stykajace sie DOKLADNIE na granicy (minX === poprzedni maxX) scalaja sie w jedna grupe', () => {
    const tokens = [tok(0, 50), tok(50, 100)];
    expect(findColumnBand(tokens, rect(10, 20))).toEqual({ minX: 0, maxX: 100 });
  });
});

describe('isWithinColumnBand', () => {
  it('null band (brak tokenow na stronie) NIGDY nie odrzuca', () => {
    expect(isWithinColumnBand(rect(1000, 1010), null)).toBe(true);
  });

  it('srodek bboksa wewnatrz pasma -> true', () => {
    expect(isWithinColumnBand(rect(80, 90), { minX: 72, maxX: 289 })).toBe(true);
  });

  it('srodek bboksa poza pasmem (sasiednia kolumna) -> false', () => {
    expect(isWithinColumnBand(rect(316, 400), { minX: 72, maxX: 289 })).toBe(false);
  });
});
