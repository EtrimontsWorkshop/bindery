import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * KROK-10 Z5 — bezpiecznik progu ufnosci: uklad kolumnowy o NIEJEDNOZNACZNYCH
 * kolumnach (jeden IZOLOWANY, wiekszy element czesciowo wchodzi w obszar
 * rynny na fragmencie wysokosci bloku), obnizajac `confidence`
 * (`detectColumns`) ponizej progu naprawy (0.85), ale wciaz POWYZEJ progu
 * samego wykrycia kolumn (0.7 w `columns.ts`) — kolumny SA wykryte, tylko
 * niepewnie. Plus dokladnie ten sam wzorzec falszywego sklejenia co
 * `layout-2col-false-merge`. Przy niepewnej detekcji kolumn przebieg
 * naprawczy NIE MOZE ciac — "nie wiadomo gdzie SA kolumny" (brief) — lepiej
 * zostawic istniejacy blad niz wprowadzic nowy.
 *
 * [technika] Element wiekszego rozmiaru fontu ODIZOLOWANY pionowo (daleko od
 * kazdego innego wiersza — poza zasiegiem sciezki "indeks gorny/dolny" w
 * `sameLine`, zeby uniknac kaskadowego sklejenia z sasiadami) daje WIEKSZA
 * WYSOKOSC bboksa (proporcjonalna do rozmiaru fontu) przy gestosci=1 (jedna
 * linia) — latwo przezywa filtr gestosci `detectColumns` (5% maksimum przy
 * ~25 "normalnych" wierszach w tle), a jego WYSOKOSC znaczaco obniza
 * `coveredHeight`/`emptyRatio` dla kandydata na rynne, ktory czesciowo przecina.
 */
export function build(): Buffer {
  const rowCount = 25;
  const rowSpacing = 3.6;
  const startY = 700;

  const left = Array.from({ length: rowCount }, (_, i) => ({
    text: `Left col ${i}`,
    x: 45,
    y: startY - i * rowSpacing,
  }));
  const right = Array.from({ length: rowCount }, (_, i) => ({
    text: `Right col ${i}`,
    x: 310,
    y: startY - i * rowSpacing,
  }));

  // Izolowany duzy element — Y daleko od kazdego normalnego wiersza (w
  // dedykowanej przerwie), wiec nie moze sklejic sie z zadnym z nich
  // (przekracza kazdy prog `sameLine`, wlacznie ze sciezka indeksu
  // gorny/dolny). X siega w rynne. Pozostaje w [0,792] (domyslny MediaBox) —
  // Y poza tym zakresem falszywie trafia w pasmo naglowka/stopki (Z2, `spanning.ts`).
  const mainRowsBottom = startY - (rowCount - 1) * rowSpacing;
  const bigIntrusion = [{ text: 'INTRUDES HERE', x: 150, y: mainRowsBottom - 90, size: 51 }];

  const baseY = mainRowsBottom - 210;
  // [KROK-11, odkrycie] Ten sam wzorzec jest TERAZ dodatkowo zlapany o wiele
  // wczesniej przez `lineEdgeSplit.ts` (Z1, dziala PRZED `gutterRepair.ts`,
  // NIE zalezy od confidence kolumn w ogole) — patrz `groupEFixtures.test.ts`.
  const anomaly = [
    { text: 'Short left end here', x: 45, y: baseY + 30 },
    { text: 'Sidebar Title', x: 313, y: baseY + 22, size: 14 },
    { text: 'Another short left line', x: 45, y: baseY + 6 },
    { text: 'Sidebar body continues past title here now', x: 313, y: baseY },
  ];
  const belowAnomaly = Array.from({ length: 4 }, (_, i) => ({
    text: `Left column continues line ${i} here now`,
    x: 45,
    y: baseY - 20 - i * rowSpacing,
  }));

  return buildLayoutPage({ lines: [...left, ...right, ...bigIntrusion, ...anomaly, ...belowAnomaly] });
}
