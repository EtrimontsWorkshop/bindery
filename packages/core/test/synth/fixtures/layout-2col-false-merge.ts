import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * KROK-10 Z5 — replika geometrii zmierzonej na `Za_lini_wroga.pdf` str. 70
 * (RAPORT-KROK-10.md): dwie kolumny z regularnymi wierszami (ustalajace
 * pewna rynne dla `detectColumns`), plus JEDEN caption/tytul w prawej
 * kolumnie WIEKSZYM fontem (mimikuje "Georgi Vasile" — tytul ramki bocznej),
 * ktorego rozmiar/pozycja wzgledem sasiada w lewej kolumnie spelnia warunek
 * "indeks gorny/dolny" w `sameLine` (`SUBSCRIPT_SIZE_RATIO`) i laczy go
 * transytywnie z linia z INNEJ kolumny, mimo pustej rynny miedzy nimi.
 */
export function build(): Buffer {
  const rowCount = 6;
  const rowSpacing = 12;
  const startY = 700;

  const left = Array.from({ length: rowCount }, (_, i) => ({
    text: `Left column line ${i} of body text here now`,
    x: 45,
    y: startY - i * rowSpacing,
  }));
  const right = Array.from({ length: rowCount }, (_, i) => ({
    text: `Right column line ${i} of body text here now`,
    x: 310,
    y: startY - i * rowSpacing,
  }));

  // Replika dokladnej geometrii str. 70: lewa linia konczaca sie "po" (y=744
  // wzgledem lokalnego startY), prawy TYTUL wiekszym fontem (y=736, mimikuje
  // "Georgi Vasile"), lewa kontynuacja (y=720), prawe body (y=714).
  const baseY = startY - rowCount * rowSpacing - 60;
  // [KROK-11, odkrycie] Ten sam wzorzec (etykieta wiekszego fontu na brzegu
  // zlaczonej linii, krotsza niz reszta) jest TERAZ dodatkowo zlapany o wiele
  // wczesniej przez `lineEdgeSplit.ts` (Z1, dziala PRZED `gutterRepair.ts` na
  // surowych liniach) — patrz `groupEFixtures.test.ts`, ktory dokumentuje
  // wprost, ktory mechanizm faktycznie rozcina ten fixture po tej zmianie.
  const anomaly = [
    { text: 'Short left end here', x: 45, y: baseY + 30 },
    { text: 'Sidebar Title', x: 313, y: baseY + 22, size: 14 },
    { text: 'Another short left line', x: 45, y: baseY + 6 },
    { text: 'Sidebar body continues past title here now', x: 313, y: baseY },
  ];

  // Dodatkowe czyste linie lewej kolumny PONIZEJ anomalii — bez nich lewa
  // "kolumna" pokrywa zbyt maly wycinek wysokosci bloku (bo jej jedyna tresc
  // w tym pasmie trafila do linii rozpinajacej) i `mergeSparseColumns`
  // (columns.ts) usuwa ja jako rzekomy sidebar, zanim przebieg naprawczy
  // dostanie szanse zobaczyc DWIE kolumny do przeciecia miedzy nimi.
  const belowAnomaly = Array.from({ length: 4 }, (_, i) => ({
    text: `Left column continues line ${i} here now`,
    x: 45,
    y: baseY - 20 - i * rowSpacing,
  }));

  return buildLayoutPage({ lines: [...left, ...right, ...anomaly, ...belowAnomaly] });
}
