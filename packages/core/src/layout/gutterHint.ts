/**
 * Podpowiedz rynny (KROK-6, odkrycie na `samples/`) — lekki histogram gestosci
 * na osi X, ta sama metodyka co `detectColumns` (Z3), ale BEZ pelnej walidacji
 * pionowej i BEZ ksztaltu `ColumnRegion[]`: to tylko PODPOWIEDZ dla klastrowania
 * w linie (Z5, `lineCluster.ts`), nie autorytatywna odpowiedz o kolumnach (ta
 * wciaz nalezy wylacznie do Z3, na juz poprawnie podzielonych liniach).
 *
 * Dlaczego to w ogole potrzebne: na prawdziwych plikach (nie w syntetycznych
 * fixture'ach) rynna miedzy kolumnami bywa waska (~1.2x rozmiaru fontu,
 * zmierzone na Cienie_posrod_mgie.pdf str. 46) — nie do odroznienia od
 * zwyklego, szerokiego odstepu miedzywyrazowego SAMA odlegloscia ani obecnoscia
 * granicy pdf.js (`WordBoundary`): oba sygnaly zawodza dokladnie w tym samym
 * zakresie wartosci. Jedyny niezawodny sygnal to KONSYSTENCJA pozycji X w
 * wielu WIERSZACH (rowId) na raz — czyli dokladnie to, co liczy histogram
 * ponizej, ale MUSI to nastapic PRZED klastrowaniem w linie (Z5), inaczej dwie
 * kolumny na tym samym wierszu juz sa sklejone w jedna linie, zanim Z3 w ogole
 * dostanie szanse to zobaczyc.
 *
 * [KROK-6, druga poprawka — pierwsza wersja liczyla gestosc po TOKENACH, nie
 * WIERSZACH: na pojedynczej linii z 2-5 slowami (np. fixture text-empty-items)
 * kazdy odstep miedzy slowami wygladal jak "100% pusta dolina" wzgledem
 * garstki tokenow tej jednej linii, falszywie rozpoznawany jako rynna.
 * Gestosc musi liczyc DYSTYNKTYWNE wiersze pokrywajace dany bin, nie surowa
 * liczbe tokenow — i wymagac minimalnej liczby wierszy, zanim cokolwiek
 * zostanie zaufane (ponizej progu: brak sensownych danych, zwroc pusto).
 */

export interface GutterHint {
  minX: number;
  maxX: number;
}

export interface SpanWithRow {
  minX: number;
  maxX: number;
  /** Identyfikator wiersza (np. zaokraglona pozycja cross-axis) — gutter liczy sie po ROW, nie po tokenie. */
  rowId: string | number;
}

const HISTOGRAM_BIN_WIDTH_PT = 2;
const MAX_VALLEY_ROW_RATIO = 0.05;
/**
 * [KROK-6, odkrycie] Nizszy prog niz w `detectColumns` (tam 10pt) — ta
 * podpowiedz dziala na SUROWYCH TOKENACH (szumniejsze niz gotowe linie Z3) i
 * jej blad w jedna strone jest tani (najwyzej niepotrzebnie rozbije linie o
 * niezwykle szerokim odstepie), a w druga kosztowny (cichy blad sklejenia
 * kolumn w tekst). Zmierzone na Cienie_posrod_mgie.pdf str. 20: prawdziwa
 * rynna ~10pt na surowych tokenach czasem mierzy sie odrobine wezsza niz na
 * finalnych liniach (szerszy token nachodzi na skraj rynny), przez co przy
 * progu=10pt caly kandydat byl odrzucany i sklejenie wracalo.
 */
const MIN_VALLEY_WIDTH_PT = 6;
/** Ponizej tylu DYSTYNKTYWNYCH wierszy histogram nie ma zadnej mocy statystycznej — nie zwracaj zadnej podpowiedzi. */
const MIN_ROWS_FOR_GUTTER_HINT = 3;

export function findLikelyGutters(spans: readonly SpanWithRow[]): GutterHint[] {
  const rowIds = new Set(spans.map((s) => s.rowId));
  if (rowIds.size < MIN_ROWS_FOR_GUTTER_HINT) return [];

  const blockMinX = Math.min(...spans.map((s) => s.minX));
  const blockMaxX = Math.max(...spans.map((s) => s.maxX));
  const width = blockMaxX - blockMinX;
  if (width <= 0) return [];

  const binCount = Math.max(1, Math.ceil(width / HISTOGRAM_BIN_WIDTH_PT));
  const rowsByBin: Set<string | number>[] = Array.from({ length: binCount }, () => new Set());
  for (const s of spans) {
    const startBin = Math.floor((s.minX - blockMinX) / HISTOGRAM_BIN_WIDTH_PT);
    const endBin = Math.floor((s.maxX - blockMinX) / HISTOGRAM_BIN_WIDTH_PT);
    for (let b = Math.max(0, startBin); b <= Math.min(binCount - 1, endBin); b++) rowsByBin[b]!.add(s.rowId);
  }

  const totalRows = rowIds.size;
  const valleyThreshold = Math.max(0, Math.floor(totalRows * MAX_VALLEY_ROW_RATIO));
  const minValleyBins = Math.ceil(MIN_VALLEY_WIDTH_PT / HISTOGRAM_BIN_WIDTH_PT);

  const gutters: GutterHint[] = [];
  let runStart: number | null = null;
  for (let b = 0; b < binCount; b++) {
    const isLow = rowsByBin[b]!.size <= valleyThreshold;
    if (isLow && runStart === null) runStart = b;
    if (!isLow && runStart !== null) {
      if (runStart > 0 && b - runStart >= minValleyBins) {
        gutters.push({ minX: blockMinX + runStart * HISTOGRAM_BIN_WIDTH_PT, maxX: blockMinX + b * HISTOGRAM_BIN_WIDTH_PT });
      }
      runStart = null;
    }
  }
  // Rynna otwarta az do prawego brzegu bloku to margines, nie rynna miedzykolumnowa (jak w detectColumns) — pomijamy.

  return gutters;
}
