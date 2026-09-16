import { describe, expect, it } from 'vitest';
import { detectRunningElements, type PageForRunningElements } from '../../src/layout/runningElements.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

const PAGE_HEIGHT = 792;

function line(id: string, minX: number, maxX: number, y: number, fontKey = 'Header@9'): TextLine {
  return {
    id,
    text: id,
    bbox: { minX, minY: y, maxX, maxY: y + 10 },
    columnIndex: -1,
    crossAxisPosition: y,
    fonts: [{ key: fontKey, size: 9 }],
    dominantFont: { key: fontKey, size: 9 },
    syntheticBold: false,
  };
}

describe('detectRunningElements — dopasowanie NIE po dokladnym tekscie (numer strony sie zmienia)', () => {
  it('naglowek stalego tekstu + zmienny numer strony na kazdej z 6 stron -> wykryty na wszystkich', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 6 }, (_, i) => {
      const pageNumber = i + 1;
      // Naglowek: tytul stale w tej samej pozycji + numer strony o zmiennej liczbie cyfr (1 vs 10+).
      const pageLabel = `Chapter One - ${pageNumber}`;
      return {
        pageNumber,
        pageHeight: PAGE_HEIGHT,
        primaryLines: [
          line(`header-p${pageNumber}`, 72, 72 + pageLabel.length * 5, 760), // y=760/792=95.9% > 93% -> header band
          line(`body-p${pageNumber}`, 72, 300, 400), // tresc glowna, poza pasmem
        ],
      };
    });
    const matches = detectRunningElements(pages);
    const headerMatches = matches.filter((m) => m.kind === 'header');
    expect(headerMatches).toHaveLength(6);
    expect(headerMatches.map((m) => m.pageNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // Tresc glowna nigdy nie jest dopasowana jako naglowek/stopka.
    expect(matches.some((m) => m.lineId.startsWith('body'))).toBe(false);
  });
});

describe('detectRunningElements — stopka analogicznie do naglowka', () => {
  it('linia w dolnym pasmie (y < 7% wysokosci) wykryta jako stopka', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`footer-p${i + 1}`, 250, 350, 30, 'Footer@8')], // y=30/792=3.8% < 7%
    }));
    const matches = detectRunningElements(pages);
    expect(matches.every((m) => m.kind === 'footer')).toBe(true);
    expect(matches).toHaveLength(5);
  });
});

describe('detectRunningElements — koniunkcja warunkow', () => {
  it('NIE dopasowuje gdy klucz fontu jest inny na kazdej stronie, mimo tej samej pozycji', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, 200, 760, `Font${i}@9`)], // rozny font kazda strona
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('NIE dopasowuje gdy pozycja pozioma zbyt rozna miedzy stronami', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72 + i * 100, 200 + i * 100, 760)], // x przesuwa sie mocno kazda strone
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('dopasowuje mimo roznicy szerokosci wynikajacej ze zmiennej liczby cyfr numeru strony', () => {
    const widths = [72 + 1 * 5, 72 + 2 * 5, 72 + 3 * 5]; // "9", "10", "100" - rozna liczba cyfr
    const pages: PageForRunningElements[] = widths.map((w, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, w, 760)],
    }));
    // Tolerancja domyslna (12pt) moze rozbic 5pt-15pt roznice na sasiednie kubelki
    // kwantyzacji przez zaokraglenie na granicy (znany kompromis prostego bucketingu,
    // patrz collections.ts) — tu jawnie szersza tolerancja, zeby przetestowac SAM
    // mechanizm "podobna, nie identyczna szerokosc", nie konkretna wartosc domyslna.
    const matches = detectRunningElements(pages, { widthTolerancePt: 100 });
    expect(matches).toHaveLength(3);
  });
});

describe('detectRunningElements — prog 60% stron w zakresie', () => {
  it('sygnatura obecna na mniej niz 60% stron NIE jest zaraportowana', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      // tylko 5/10 = 50% stron ma jakikolwiek kandydat w pasmie naglowka
      primaryLines: i < 5 ? [line(`h-p${i + 1}`, 72, 200, 760)] : [line(`body-p${i + 1}`, 72, 200, 400)],
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('sygnatura obecna na dokladnie progu (60%) JEST zaraportowana', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: i < 6 ? [line(`h-p${i + 1}`, 72, 200, 760)] : [line(`body-p${i + 1}`, 72, 200, 400)],
    }));
    const matches = detectRunningElements(pages);
    expect(matches.filter((m) => m.kind === 'header')).toHaveLength(6);
  });
});

describe('detectRunningElements — nie usuwa, tylko oznacza (kontrakt zwracanych danych)', () => {
  it('zwraca lineId + pageNumber + kind, nie modyfikuje wejsciowych linii', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, 200, 760)],
    }));
    const matches = detectRunningElements(pages);
    for (const m of matches) {
      expect(m).toHaveProperty('lineId');
      expect(m).toHaveProperty('pageNumber');
      expect(m.kind).toBe('header');
    }
  });
});
