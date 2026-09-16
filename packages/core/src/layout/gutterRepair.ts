import { unionRect, type Rect } from '../geometry.js';
import type { ColumnRegion } from './columns.js';
import type { LineToken, TextLine } from './lineCluster.js';
import type { SpanningSplit } from './spanning.js';

/**
 * Przebieg naprawczy PO detekcji kolumn (KROK-10) — naprawia linie fałszywie
 * sklejone przez `lineCluster.ts` w dwie (lub więcej) kolumny na tej samej
 * wysokości, gdy słaba podpowiedź rynny (`gutterHint.ts`, działa PRZED
 * klastrowaniem, na surowym histogramie) nie wystarczyła.
 *
 * [decyzja architektoniczna, brief] `gutterHint` działa PRZED klastrowaniem
 * linii i dysponuje wyłącznie zgrubnym histogramem — wzmacnianie go tam
 * oznaczałoby walkę na najgorszym dostępnym poziomie informacji, w mocno
 * przetestowanym rdzeniu (`lineCluster.ts`/`sameLine`), z realnym ryzykiem
 * regresji. Zamiast tego: PO detekcji kolumn (Z3, `detectColumns`) mamy PEWNĄ
 * wiedzę o granicach kolumn — ten moduł ją wykorzystuje WSTECZ, jako osobny
 * przebieg, bez dotykania `lineCluster.ts`'s logiki decyzyjnej.
 *
 * Dyskryminator (sedno zadania): linia, ktorej bbox przecina wykryta rynne,
 * moze byc (a) PRAWDZIWA linia rozpinajaca — ma token(y) WEWNATRZ obszaru
 * rynny, tekst faktycznie tam biegnie — NIE ruszaj; (b) FALSZYWE sklejenie —
 * ZERO tokenow w rynnie, dwa skupiska z dziura — ROZETNIJ. Bezpiecznik: dziala
 * WYLACZNIE gdy confidence detekcji kolumn >= progu (niepewna detekcja kolumn
 * = nie wiadomo gdzie SA kolumny, lepiej zostawic istniejacy blad niz
 * wprowadzic nowy).
 */

/** Ten sam prog co `LOW_CONFIDENCE_THRESHOLD` w `tools/calibrate-layout.ts` — spojnosc z istniejaca konwencja "ponizej tego kolumny sa niepewne". */
const GUTTER_REPAIR_CONFIDENCE_THRESHOLD = 0.85;

export interface GutterRepairResult {
  split: SpanningSplit;
  /** Liczba linii faktycznie rozcietych — do kalibracji/raportu. */
  splitCount: number;
}

interface Gutter {
  minX: number;
  maxX: number;
}

/** Rynny miedzy KOLEJNYMI (posortowanymi wzdluz X) kolumnami — N kolumn daje N-1 rynien. */
function computeGutters(columns: readonly ColumnRegion[]): Gutter[] {
  const sorted = [...columns].sort((a, b) => a.bbox.minX - b.bbox.minX);
  const gutters: Gutter[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    gutters.push({ minX: sorted[i]!.bbox.maxX, maxX: sorted[i + 1]!.bbox.minX });
  }
  return gutters;
}

/** Ktore z rynien linia FAKTYCZNIE przecina swoim bboksem (moze byc wiecej niz jedna przy 3+ kolumnach). */
function crossedGutters(line: TextLine, gutters: readonly Gutter[]): Gutter[] {
  return gutters.filter((g) => line.bbox.minX < g.minX && line.bbox.maxX > g.maxX);
}

function tokenIntersectsGutter(token: LineToken, gutter: Gutter): boolean {
  return token.bbox.maxX > gutter.minX && token.bbox.minX < gutter.maxX;
}

function buildFragmentBBox(tokens: readonly LineToken[]): Rect {
  return tokens.map((t) => t.bbox).reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
}

/** Fragment linii po rozcieciu — nowy `TextLine` z podzbiorem tokenow, tekstem/bboksem przeliczonym TYLKO z nich. `id` niesie powiazanie ze zrodlowa linia (provenance, brief). */
function buildFragment(line: TextLine, tokens: readonly LineToken[], fragmentIndex: number): TextLine {
  return {
    ...line,
    id: `${line.id}-gutter${fragmentIndex}`,
    text: tokens.map((t) => t.text).join(' '),
    bbox: buildFragmentBBox(tokens),
    tokens: [...tokens],
    // `runs` (KROK-9 Z1b) odziedziczone z linii zrodlowej nie sa juz poprawne
    // dla fragmentu (moga odwolywac sie do tokenow z DRUGIEJ strony rynny) —
    // wyczyszczone zamiast wprowadzac cichy blad w dalszym przebiegu Z1b.
    runs: undefined,
  };
}

/**
 * Rozcina linie z `split.spanning`, ktore fałszywie sklejaja dwie (lub wiecej)
 * kolumny na tej samej wysokosci. Bezpieczna z zalozenia: przy braku danych o
 * tokenach (`TextLine.tokens` niepopulowane — np. recznie zbudowane fixture'y
 * bez tego pola) albo niepewnej detekcji kolumn, NIC nie rozcina.
 */
export function repairGutterCrossingLines(split: SpanningSplit, columns: readonly ColumnRegion[], columnConfidence: number): GutterRepairResult {
  if (columnConfidence < GUTTER_REPAIR_CONFIDENCE_THRESHOLD || columns.length < 2) {
    return { split, splitCount: 0 };
  }
  const gutters = computeGutters(columns);
  if (gutters.length === 0) return { split, splitCount: 0 };

  const remainingSpanning: TextLine[] = [];
  const newColumnar: TextLine[] = [];
  let splitCount = 0;

  for (const line of split.spanning) {
    const crossed = crossedGutters(line, gutters);
    if (crossed.length === 0) {
      remainingSpanning.push(line);
      continue;
    }

    const tokens = line.tokens;
    if (!tokens || tokens.length === 0) {
      // Bezpiecznik: brak danych o tokenach — nie tnij bez pewnosci (A7-podobna zasada: degraduj, nie zgaduj).
      remainingSpanning.push(line);
      continue;
    }

    const hasTokenInAnyCrossedGutter = crossed.some((g) => tokens.some((t) => tokenIntersectsGutter(t, g)));
    if (hasTokenInAnyCrossedGutter) {
      // Prawdziwa linia rozpinajaca — tekst faktycznie biegnie przez rynne. NIE ruszaj.
      remainingSpanning.push(line);
      continue;
    }

    // Podziel na fragmenty miedzy kolejnymi przecietymi rynnami.
    const sortedGutters = [...crossed].sort((a, b) => a.minX - b.minX);
    const regionBounds: { min: number; max: number }[] = [];
    let prevMax = Number.NEGATIVE_INFINITY;
    for (const g of sortedGutters) {
      regionBounds.push({ min: prevMax, max: g.minX });
      prevMax = g.maxX;
    }
    regionBounds.push({ min: prevMax, max: Number.POSITIVE_INFINITY });

    const fragmentsTokens: LineToken[][] = regionBounds.map(() => []);
    let allTokensAssigned = true;
    for (const t of tokens) {
      const regionIndex = regionBounds.findIndex((r) => t.bbox.minX >= r.min && t.bbox.maxX <= r.max);
      if (regionIndex === -1) {
        // Token nie miesci sie czysto w zadnym regionie (np. sam nachodzi na granice rynny) — bezpiecznik, nie tnij.
        allTokensAssigned = false;
        break;
      }
      fragmentsTokens[regionIndex]!.push(t);
    }

    if (!allTokensAssigned || fragmentsTokens.some((f) => f.length === 0)) {
      // Ktoras strona wyszlaby pusta (albo token niejednoznaczny) — nie ma dwoch realnych stron do rozdzielenia.
      remainingSpanning.push(line);
      continue;
    }

    fragmentsTokens.forEach((frag, i) => newColumnar.push(buildFragment(line, frag, i)));
    splitCount++;
  }

  return {
    split: { spanning: remainingSpanning, columnar: [...split.columnar, ...newColumnar], textBlockWidth: split.textBlockWidth },
    splitCount,
  };
}
