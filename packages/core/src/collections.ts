/**
 * Grupowanie po skwantyzowanej pozycji — jeden wspolny mechanizm zamiast trzech
 * niezaleznie zaimplementowanych (KROK-6 Z1d): `collectGapSamples` (KROK-5 Z2,
 * per linia bazowa), `mergeWords` (KROK-5 Z4, per linia bazowa),
 * `correlateImagesByBBox` (KROK-5 Z6.2, per skwantowany bbox).
 *
 * Nie ma jednego uniwersalnego KROKU kwantyzacji — tolerancja tekstu (pochodna
 * rozmiaru fontu, patrz `baselineTolerance`) i tolerancja obrazow (stala 0.5pt)
 * sa z natury rozne domeny. Wspolna jest wylacznie mechanika grupowania; kazde
 * miejsce wywolania dostarcza WLASNA, jawna funkcje kwantyzacji (`keyOf`) —
 * to jest "jawny parametr kwantyzacji" z briefu, widoczny przy wywolaniu,
 * nie ukryty wewnatrz wspolnej funkcji.
 */
export function groupByQuantizedPosition<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = groups.get(key);
    if (arr) arr.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
