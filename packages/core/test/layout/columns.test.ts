import { describe, expect, it } from 'vitest';
import { detectColumns, validateColumnStabilityAcrossPages } from '../../src/layout/columns.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

function line(id: string, minX: number, maxX: number, y: number): TextLine {
  return {
    id,
    text: id,
    bbox: { minX, minY: y, maxX, maxY: y + 12 },
    columnIndex: -1,
    crossAxisPosition: y,
    fonts: [{ key: 'Body@12', size: 12 }],
    dominantFont: { key: 'Body@12', size: 12 },
    syntheticBold: false,
  };
}

/** Buduje N linii uniformnie rozlozonych pionowo w [minX,maxX], pokrywajace cala wysokosc bloku (0..height). */
function fillColumn(prefix: string, minX: number, maxX: number, count: number, height: number): TextLine[] {
  return Array.from({ length: count }, (_, i) => line(`${prefix}${i}`, minX, maxX, (height / count) * i));
}

describe('detectColumns — brak wyraznych dolin', () => {
  it('jedna kolumna, confidence=1, gdy brak jakiejkolwiek rynny (uklad jednokolumnowy)', () => {
    const lines = fillColumn('p', 50, 550, 20, 600);
    const result = detectColumns(lines, 1);
    expect(result.columns).toHaveLength(1);
    expect(result.confidence).toBe(1);
    expect(result.columns[0]!.bbox.minX).toBe(50);
    expect(result.columns[0]!.bbox.maxX).toBe(550);
  });

  it('pusta lista linii kolumnowych -> pusty wynik (np. cala strona to nagrupek rozpinajacy)', () => {
    const result = detectColumns([], 1);
    expect(result.columns).toHaveLength(0);
  });
});

describe('detectColumns — dwie kolumny z prawdziwa rynna', () => {
  it('wykrywa dwie kolumny z rynna pusta na CALEJ wysokosci bloku', () => {
    const left = fillColumn('l', 50, 280, 20, 600);
    const right = fillColumn('r', 320, 550, 20, 600);
    const result = detectColumns([...left, ...right], 1);
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0]!.bbox.maxX).toBeLessThanOrEqual(280 + 2); // granica ~gdzie konczy sie lewa kolumna
    expect(result.columns[1]!.bbox.minX).toBeGreaterThanOrEqual(320 - 2);
    expect(result.confidence).toBeGreaterThan(0.9); // rynna calkowicie pusta na 100% wysokosci
  });

  it('kolumny posortowane w kolejnosci czytania (lewo->prawo) niezaleznie od kolejnosci wejscia', () => {
    const left = fillColumn('l', 50, 280, 10, 600);
    const right = fillColumn('r', 320, 550, 10, 600);
    const result = detectColumns([...right, ...left], 1); // prawa podana pierwsza
    expect(result.columns.map((c) => c.index)).toEqual([0, 1]);
    expect(result.columns[0]!.bbox.minX).toBeLessThan(result.columns[1]!.bbox.minX);
  });
});

describe('detectColumns — walidacja pionowa (brief: rynna tylko w gornej cwiartce to NIE kolumna)', () => {
  it('rynna niska GESToscia (po liczbie linii) ale pokryta przez wysoka linie na duzej czesci wysokosci zostaje odrzucona', () => {
    // 30 krotkich linii lewej "kolumny" (x=50..280) + 30 krotkich prawej (x=320..550) — duzo linii,
    // wysoka gestosc po obu stronach rynny 280-320. JEDNA dodatkowa linia pelnej szerokosci
    // (x=50..550) przecina rynne, ale jest wysoka (bbox 0..400 z 0..590 calkowitej wysokosci) —
    // jej WYSOKOSC pokrywa >30% bloku, wiec walidacja pionowa (prog 70% pustki) odrzuca ta rynne,
    // mimo ze gestosc PO LICZBIE LINII w rynnie jest bardzo niska (1 z ~31).
    const topLeft = Array.from({ length: 30 }, (_, i) => line(`tl${i}`, 50, 280, i * 20));
    const topRight = Array.from({ length: 30 }, (_, i) => line(`tr${i}`, 320, 550, i * 20));
    const tallCrossing: TextLine = { ...line('cross', 50, 550, 0), bbox: { minX: 50, minY: 0, maxX: 550, maxY: 400 } };
    const result = detectColumns([...topLeft, ...topRight, tallCrossing], 1);
    expect(result.columns).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === 'COLUMN_VALLEY_REJECTED_VERTICAL')).toBe(true);
  });
});

describe('validateColumnStabilityAcrossPages', () => {
  it('strona ze wszystkimi (obu) sasiadami odstajacymi dostaje Diagnostic, nie wymusza zgodnosci', () => {
    const perPage = [
      { pageNumber: 1, columnCount: 2 },
      { pageNumber: 2, columnCount: 2 },
      { pageNumber: 3, columnCount: 1 }, // odstaje od obu sasiadow
      { pageNumber: 4, columnCount: 2 },
      { pageNumber: 5, columnCount: 2 },
    ];
    const diagnostics = validateColumnStabilityAcrossPages(perPage);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.pageNumber).toBe(3);
    expect(diagnostics[0]!.code).toBe('COLUMN_COUNT_UNSTABLE');
  });

  it('strona zgodna z PRZYNAJMNIEJ jednym sasiadem nie dostaje diagnostyki', () => {
    const perPage = [
      { pageNumber: 1, columnCount: 2 },
      { pageNumber: 2, columnCount: 2 },
      { pageNumber: 3, columnCount: 1 }, // rozni sie od str.2, ale to koniec zakresu (brak nastepnej)
    ];
    const diagnostics = validateColumnStabilityAcrossPages(perPage);
    expect(diagnostics).toHaveLength(1); // tylko strona 3 (rozni sie od jedynego sasiada, str.2)
    expect(diagnostics[0]!.pageNumber).toBe(3);
  });

  it('pojedyncza strona bez sasiadow nigdy nie dostaje diagnostyki', () => {
    expect(validateColumnStabilityAcrossPages([{ pageNumber: 1, columnCount: 3 }])).toHaveLength(0);
  });
});
