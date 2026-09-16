/**
 * Macierze 2D i prostokąty — matematyka współdzielona przez inwentaryzację
 * (faza 2/3, MDD zał. A). Reimplementowane niezależnie od pdfjs-dist (nie
 * importujemy `Util` z pdf.js tutaj), żeby `walkOperators` pozostał w pełni
 * czystą funkcją, testowalną na gołych tablicach liczb bez żadnej zależności —
 * formuła zweryfikowana wprost względem `Util.transform` w pdf.mjs (KROK-4).
 */

/** Macierz afiniczna PDF: [a, b, c, d, e, f], punkt' = (x*a + y*c + e, x*b + y*d + f). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Skleja dwie macierze: `m1` (dotychczasowe CTM) rozszerzone o `m2` (nowa macierz,
 * np. z operatora `cm`). Formula identyczna z `Util.transform(m1, m2)` w pdf.js.
 */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bbox kwadratu jednostkowego [0,1]x[0,1] przekształconego przez CTM — metodyka
 * ze spike'u fazy 0 (`Util.getAxialAlignedBoundingBox` nie istnieje w 6.1.200).
 * Ujemne wspolrzedne SA poprawne (spad drukarski) — nigdy nie przycinaj.
 */
export function unitSquareBBox(ctm: Matrix): Rect {
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of corners) {
    xs.push(ctm[0] * x + ctm[2] * y + ctm[4]);
    ys.push(ctm[1] * x + ctm[3] * y + ctm[5]);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Bbox przebiegu TextItem z pdf.js. NIE jest to przypadek `localRectBBox`:
 * `item.width`/`item.height` z `getTextContent()` sa JUZ finalna dlugoscia w
 * przestrzeni urzadzenia (suma delt pozycji glifow, patrz `updateAdvanceScale`
 * w pdf.worker.mjs) — NIE lokalnymi jednostkami sprzed transformacji jak w
 * przypadku operatora `re`. Mnozenie ich przez `transform[0]`/`transform[3]`
 * (jak robi `localRectBBox`) PODWAJA skalowanie o rozmiar fontu (np. 10x dla
 * Tf 10) — empirycznie wykryte w KROK-6 przy pierwszej integracji detekcji
 * kolumn na prawdziwych fixture'ach (bboxy linii siegaly x=2000+ na stronie
 * 612pt szerokiej). Zamiast tego: znormalizuj kierunek z (a,b)/(c,d), przeskaluj
 * przez JUZ-finalne width/height.
 */
export function textRunBBox(transform: Matrix, width: number, height: number): Rect {
  const [a, b, c, d, e, f] = transform;
  const hLen = Math.hypot(a, b) || 1;
  const vLen = Math.hypot(c, d) || 1;
  const hx = (a / hLen) * width;
  const hy = (b / hLen) * width;
  const vx = (c / vLen) * height;
  const vy = (d / vLen) * height;
  const corners: Array<[number, number]> = [
    [e, f],
    [e + hx, f + hy],
    [e + vx, f + vy],
    [e + hx + vx, f + hy + vy],
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function unionRect(a: Rect, b: Rect): Rect {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Powierzchnia przeciecia / powierzchnia mniejszego z dwoch prostokatow — do wykrywania masek (path "geometry"). */
export function overlapRatio(a: Rect, b: Rect): number {
  const inter = rectIntersection(a, b);
  if (!inter) return 0;
  const smaller = Math.min(rectArea(a), rectArea(b));
  if (smaller <= 0) return 0;
  return rectArea(inter) / smaller;
}

/** Powierzchnia `r` wzgledem powierzchni strony — 0..1+ (obraz moze wychodzic poza strone). */
export function relativeArea(r: Rect, page: Rect): number {
  const pageArea = rectArea(page);
  if (pageArea <= 0) return 0;
  return rectArea(r) / pageArea;
}

/**
 * [wyodrebnione po recenzji calego designu — ta sama formula byla
 * zduplikowana w trzech plikach `profiles/`] Odleglosc miedzy NAJBLIZSZYMI
 * krawedziami dwoch prostokatow — 0, gdy sie stykaja lub nakladaja (gap
 * ujemny/zerowy jest przycinany do 0 w kazdej osi z osobna PRZED `Math.hypot`,
 * nie po), inaczej euklidesowa odleglosc miedzy najblizszymi punktami.
 */
export function rectGapDistance(a: Rect, b: Rect): number {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
  const dy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * [zgloszenie uzytkownika, "obraz mocno sie zmniejsza po obrocie, duzo
 * pustego miejsca w ramce"] Wspolczynnik skali `s` (0 < s <= 1) NAJWIEKSZEGO
 * prostokata o TYCH SAMYCH proporcjach co `width x height`, ktory miesci sie
 * CALY wewnatrz TEGO SAMEGO prostokata obroconego o `angleRad` (DOWOLNY kat,
 * dowolny znak i dowolna wielkosc — patrz redukcja ponizej). Wyjscie:
 * `packages/module`'s `#rotateImage` uzywa tego, zeby przyciac obrocony
 * obraz do rozmiaru BEZ przezroczystych rogow (zamiast powiekszac otoczke,
 * zeby zmiescic CALY oryginal z pustymi rogami) — standardowe zachowanie
 * narzedzi "wyprostuj" w edytorach zdjec.
 *
 * Wyprowadzenie: prostokat wyjsciowy o polowicznych wymiarach `(s*a, s*b)`
 * (a=width/2, b=height/2), WYSRODKOWANY w tym samym punkcie co obrot, miesci
 * sie w oryginale (przed obrotem) dokladnie wtedy, gdy KAZDY z jego 4 rogow,
 * po obrocie WSTECZ o `angleRad` (macierz `R(-angleRad)`), ma wspolrzedne w
 * `[-a,a] x [-b,b]` — cztery nierownosci z tego (jedna per odrebny typ rogu)
 * daja cztery gorne ograniczenia na `s`, brany jest NAJMNIEJSZY (najbardziej
 * restrykcyjny). Zweryfikowane recznie na dwoch znanych przypadkach: kat=0 ->
 * s=1 (pelny rozmiar); kwadrat obrocony o 45° -> s=1/√2 (znany wynik
 * geometryczny) — patrz testy.
 *
 * [naprawa zgloszonego bledu — "po 36 obrotach po 10° obraz sie kurczy" ujawnil
 * TEZ, ze funkcja dawala UJEMNE (bezsensowne) wyniki dla katow > 90°, np.
 * 170°/190°] Prostokat ma OKRES 180° (symetria srodkowa — obrot o θ i o
 * θ+180° daje IDENTYCZNY zbior punktow) I jest symetryczny wzgledem znaku
 * (obrot w lewo/prawo o ten sam kat daje zwierciadlany, wiec rownowazny pod
 * wzgledem samej skali wynik) — dawne `Math.abs(angleRad)` bez zadnej innej
 * redukcji poprawnie obslugiwalo WYLACZNIE katy juz w [-90°, 90°]; dla
 * wiekszych katow (nieuniknione przy wielokrotnym klikaniu przycisku obrotu
 * o maly krok) dawalo dowolnie zle wyniki. Redukcja ponizej: modulo π (okres
 * 180°, z obsluga ujemnych — JS `%` NIE jest "floor mod"), zlozenie do
 * `(-π/2, π/2]`, potem `Math.abs` -> zawsze `[0, π/2]`.
 */
export function inscribedRotatedRectScale(width: number, height: number, angleRad: number): number {
  if (width <= 0 || height <= 0) return 1;
  const a = width / 2;
  const b = height / 2;
  let angle = angleRad % Math.PI;
  if (angle < 0) angle += Math.PI; // teraz w [0, π)
  if (angle > Math.PI / 2) angle -= Math.PI; // teraz w (-π/2, π/2]
  angle = Math.abs(angle); // teraz w [0, π/2]
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const c1 = a / (a * cos + b * sin);
  const d2 = b * cos - a * sin;
  const c2 = d2 !== 0 ? b / Math.abs(d2) : Infinity;
  const d3 = a * cos - b * sin;
  const c3 = d3 !== 0 ? a / Math.abs(d3) : Infinity;
  const c4 = b / (a * sin + b * cos);
  return Math.min(c1, c2, c3, c4, 1);
}
