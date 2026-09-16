import { textRunBBox, unionRect, type Rect } from '../geometry.js';
import { hasBoundaryBetween } from '../text/hygiene.js';
import type { FontFingerprint, WordBoundary } from '../text/types.js';
import { findLikelyGutters, type GutterHint } from './gutterHint.js';
import type { MergedToken } from './wordMerge.js';
import { axisPositions, baselineTolerance, fontSizeFromTransform, type StreamAngle } from './textGeometry.js';

/**
 * Klastrowanie tokenow (po Z4) w linie tekstu (KROK-5 Z5, MDD §5.1). Klucz:
 * grupowanie po `crossAxisPosition` — osi PROSTOPADLEJ do kierunku tekstu, nie
 * zawsze Y — z tolerancja pochodna od rozmiaru fontu (wspoldzielona z Z2/Z4,
 * patrz textGeometry.ts). Indeksy gorne/dolne (mniejszy font, male przesuniecie)
 * musza trafic do tej samej linii co ich otoczenie.
 */

export interface TextLine {
  id: string;
  text: string;
  bbox: Rect;
  /** Zawsze -1 w kroku 5 — przypisanie do kolumny to krok 6. */
  columnIndex: number;
  crossAxisPosition: number;
  fonts: FontFingerprint[];
  dominantFont: FontFingerprint;
  syntheticBold: boolean;
  /**
   * [KROK-9 Z1b] Przebiegi WEWNATRZ linii w kolejnosci wzdluz osi czytania —
   * ciagle grupy tokenow tego samego `fontKey`. Puste/brak = linia jednolita
   * (typowy przypadek). Istnieje WYLACZNIE po to, zeby `blockBuilder.ts` mogl
   * wykryc naglowek srodakapitowy (przejscie roli fontu heading->body W JEDNEJ
   * linii, MDD §5.2) — `fonts`/`dominantFont` powyzej spłaszczaja te informacje
   * do jednego klucza i nie niosa pozycji. Opcjonalne (nie wymagane), zeby nie
   * psuc istniejacych fixture'ow testowych budujacych `TextLine` recznie.
   */
  runs?: LineRun[];
  /**
   * [KROK-10] Bbox+tekst KAZDEGO oryginalnego tokenu tej linii (PRZED agregacja
   * do `text`/`bbox`), posortowane wzdluz osi czytania. Opcjonalne — istnieje
   * WYLACZNIE do dyskryminatora `gutterRepair.ts` ("czy jakikolwiek token
   * przecina obszar wykrytej rynny"), zero wplywu na istniejace fixture'y/testy
   * budujace `TextLine` recznie. Nie zmienia `sameLine`/klastrowania — czysto
   * dodatkowe dane wyjsciowe z JUZ obliczonych bboksow tokenow.
   */
  tokens?: LineToken[];
}

/** Ciagly przebieg tokenow jednego fontu wewnatrz linii (KROK-9 Z1b) — patrz `TextLine.runs`. */
export interface LineRun {
  fontKey: string;
  text: string;
  bbox: Rect;
}

/** Jeden oryginalny token linii (KROK-10) — patrz `TextLine.tokens`. */
export interface LineToken {
  text: string;
  bbox: Rect;
}

/** Wspolczynnik typograficzny interlinii wzgledem rozmiaru fontu — standardowy zakres 1.2-1.5, tu srodek. */
const LINE_HEIGHT_RATIO = 1.35;
/** Ponizej tego stosunku rozmiarow token jest "mniejszy" — kandydat na indeks gorny/dolny. */
const SUBSCRIPT_SIZE_RATIO = 0.8;
/**
 * [KROK-6, odkrycie] Dwa tokeny na TEJ SAMEJ linii bazowej (cross-axis) nie sa
 * automatycznie ta sama LINIA tekstu — realny uklad dwukolumnowy (a takze
 * sidebar obok kolumny) ma czesto wyrownane baseline'y obu kolumn w tym samym
 * wierszu. Bez dodatkowego warunku `sameLine` sklejalo sasiadujace kolumny w
 * jedna linie rozpinajaca cala szerokosc bloku (zero wyniku Z3: histogram nigdy
 * nie widzial doliny).
 *
 * Pierwsza proba: STALY prog "gap > Nx rozmiaru fontu = rozne linie". Odrzucona
 * empirycznie — brak jednej wartosci N dzielacej poprawnie oba przypadki:
 * fixture text-empill-items (grupa B, KROK-3/5) ma CELOWO szeroki, ale
 * PRAWDZIWY odstep miedzywyrazowy ~2.9-3.1x rozmiaru fontu (kalibrowany tak,
 * zeby wymusic syntetyczny item spacji pdf.js), a layout-2col-sidebar ma
 * rynne ~4x rozmiaru fontu (wezsza niz miedzy glownymi kolumnami) — zakresy
 * SIE NAKLADAJA, zaden staly mnoznik nie rozroznia ich poprawnie.
 *
 * Druga proba: `WordBoundary` pdf.js (krok 5, U2) — jesli pdf.js sam wstawil
 * jawny item bialoznakowy miedzy tokenami, to dowod na prawdziwy odstep w
 * ciaglym biegu tekstu, niezaleznie od szerokosci. TAKZE odrzucona empirycznie
 * na prawdziwym pliku (Cienie_posrod_mgie.pdf str. 46): rynna miedzy dwiema
 * kolumnami byla waska (~12.7pt, ~1.2x rozmiaru fontu) i pdf.js WSTAWIL tam
 * synteryczny bialy znak (bo jego wlasna heurystyka "to tylko odstep" patrzy
 * WYLACZNIE na odleglosc geometryczna, tak samo slepa na "to dwie kolumny" jak
 * nasza pierwsza proba) — `sameLine` nadal sklejalo kolumny w jedna linie.
 *
 * Zaden LOKALNY sygnal (odleglosc, granica pdf.js) nie moze tego rozstrzygnac
 * niezawodnie: waska rynna i szeroki odstep miedzywyrazowy wygladaja identycznie
 * z perspektywy PARY tokenow. Jedyny niezawodny sygnal to KONSYSTENCJA pozycji
 * X w WIELU wierszach na raz — `findLikelyGutters` (gutterHint.ts) liczy
 * dokladnie to, tym samym histogramem co Z3 (`detectColumns`), ale PRZED
 * klastrowaniem w linie (na tokenach, nie liniach) — bo Z3 wlasciwe dziala
 * dopiero PO tym kroku, na juz (mamy nadzieje) poprawnie podzielonych liniach.
 * Gutter hint ma PIERWSZENSTWO nad obiema wczesniejszymi probami: token po
 * drugiej stronie wykrytej (choc tylko podpowiedzianej) rynny nigdy nie jest
 * ta sama linia, nawet przy malym odstepie lub obecnosci `WordBoundary`.
 */
const SAME_LINE_TRACKING_GAP_RATIO = 1;
const HYPHEN = '-';
const LOWERCASE_START_RE = /^\p{Ll}/u;

interface ClusterToken {
  token: MergedToken;
  size: number;
  along: number;
  cross: number;
}

/** Union-Find prosty — liczba tokenow na stronie jest mala (dziesiatki-setki), nie tysiace. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/** Odstep wzdluz osi czytania miedzy dwoma tokenami (od konca wczesniejszego do poczatku pozniejszego) — moze byc ujemny przy nakladaniu. */
function alongGap(a: ClusterToken, b: ClusterToken): number {
  const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
  return later.along - (earlier.along + earlier.token.width);
}

/** Czy jakas podpowiedziana rynna lezy MIEDZY dwoma tokenami wzdluz osi czytania. */
function gutterBetween(a: ClusterToken, b: ClusterToken, gutters: readonly GutterHint[]): boolean {
  if (gutters.length === 0) return false;
  const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
  const gapStart = earlier.along + earlier.token.width;
  const gapEnd = later.along;
  return gutters.some((g) => g.minX < gapEnd && gapStart < g.maxX);
}

/** Czy dwa tokeny naleza do tej samej linii — normalna tolerancja LUB regula indeksu gornego/dolnego. */
function sameLine(a: ClusterToken, b: ClusterToken, wordBoundaries: readonly WordBoundary[], gutters: readonly GutterHint[]): boolean {
  const crossDelta = Math.abs(a.cross - b.cross);
  const biggerSize = Math.max(a.size, b.size);

  if (crossDelta <= baselineTolerance(biggerSize)) {
    // Podpowiedziana rynna ma PIERWSZENSTWO — patrz komentarz przy SAME_LINE_TRACKING_GAP_RATIO.
    if (gutterBetween(a, b, gutters)) return false;
    // Ta sama linia bazowa TO ZA MALO — maly odstep zawsze OK (stykajace sie
    // biegi), wiekszy wymaga jawnej granicy pdf.js (prawdziwy, choc szeroki,
    // odstep miedzywyrazowy).
    const gap = alongGap(a, b);
    if (gap <= biggerSize * SAME_LINE_TRACKING_GAP_RATIO) return true;
    const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
    const earlierLastIndex = earlier.token.sourceIndices[earlier.token.sourceIndices.length - 1]!;
    const laterFirstIndex = later.token.sourceIndices[0]!;
    return hasBoundaryBetween(wordBoundaries, earlierLastIndex, laterFirstIndex);
  }

  // Indeks gorny/dolny: jeden token WYRAZNIE mniejszy, przesuniecie mniejsze niz interlinia tego wiekszego.
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size / larger.size <= SUBSCRIPT_SIZE_RATIO && crossDelta < larger.size * LINE_HEIGHT_RATIO) {
    return true;
  }
  return false;
}

function buildFontFingerprints(tokens: readonly ClusterToken[]): { fonts: FontFingerprint[]; dominantFont: FontFingerprint } {
  const byKey = new Map<string, { size: number; charCount: number }>();
  for (const t of tokens) {
    const acc = byKey.get(t.token.fontKey) ?? { size: t.size, charCount: 0 };
    acc.charCount += t.token.str.length;
    byKey.set(t.token.fontKey, acc);
  }
  const fonts: FontFingerprint[] = [...byKey.entries()]
    .map(([key, acc]) => ({ key, size: acc.size }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const dominantKey = [...byKey.entries()].reduce((best, curr) => (curr[1].charCount > best[1].charCount ? curr : best))[0];
  const dominantFont = fonts.find((f) => f.key === dominantKey)!;
  return { fonts, dominantFont };
}

/**
 * [KROK-9 Z1b] Grupuje tokeny JUZ POSORTOWANE wzdluz osi czytania w ciagle
 * przebiegi tego samego `fontKey` — surowy material do wykrycia przejscia roli
 * fontu (np. heading->body) wewnatrz jednej linii w `blockBuilder.ts`.
 */
function buildLineRuns(sorted: readonly ClusterToken[], wordBoundaries: readonly WordBoundary[]): LineRun[] {
  const runs: LineRun[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i]!.token.fontKey === sorted[start]!.token.fontKey) continue;
    const chunk = sorted.slice(start, i);
    const bbox = chunk
      .map((t) => textRunBBox(t.token.transform as [number, number, number, number, number, number], t.token.width, t.token.height))
      .reduce((acc, r) => (acc ? unionRect(acc, r) : r), null as Rect | null)!;
    runs.push({ fontKey: chunk[0]!.token.fontKey, text: joinTokenText(chunk, wordBoundaries), bbox });
    start = i;
  }
  return runs;
}

/** Skleja tokeny linii w tekst, wstawiajac spacje TYLKO tam, gdzie miedzy nimi byla prawdziwa granica wyrazu (Z1/U2). */
function joinTokenText(sorted: readonly ClusterToken[], wordBoundaries: readonly WordBoundary[]): string {
  let text = '';
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]!.token;
    if (i > 0) {
      const prev = sorted[i - 1]!.token;
      const prevLastIndex = prev.sourceIndices[prev.sourceIndices.length - 1]!;
      const currFirstIndex = curr.sourceIndices[0]!;
      if (hasBoundaryBetween(wordBoundaries, prevLastIndex, currFirstIndex)) text += ' ';
    }
    text += curr.str;
  }
  return text;
}

/**
 * Klastruje tokeny JEDNEGO strumienia katowego w linie. Zaklada tokeny juz
 * po Z4 (scalanie wyrazow) dla tego samego kata — wolajacy dostarcza je per
 * strumien, tak jak Z4.
 */
export function clusterIntoLines(
  tokens: readonly MergedToken[],
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  pageNumber: number,
): TextLine[] {
  const clusterTokens: ClusterToken[] = tokens.map((token) => {
    const { along, cross } = axisPositions(token.transform, angle);
    return { token, size: fontSizeFromTransform(token.transform), along, cross };
  });

  // Podpowiedz rynny TYLKO dla strumienia podstawowego (0°) — tam `along` = X
  // realnej strony, a koncepcja kolumn ma sens (patrz gutterHint.ts). rowId =
  // zaokraglona pozycja cross-axis (ten sam mechanizm co bucketByBaseline w
  // wordMerge.ts) — gutter hint musi liczyc DYSTYNKTYWNE wiersze, nie tokeny.
  const gutters: GutterHint[] =
    angle === 0
      ? findLikelyGutters(
          clusterTokens.map((t) => ({
            minX: t.along,
            maxX: t.along + t.token.width,
            rowId: Math.round(t.cross / baselineTolerance(t.size)),
          })),
        )
      : [];

  const uf = new UnionFind(clusterTokens.length);
  for (let i = 0; i < clusterTokens.length; i++) {
    for (let j = i + 1; j < clusterTokens.length; j++) {
      if (sameLine(clusterTokens[i]!, clusterTokens[j]!, wordBoundaries, gutters)) uf.union(i, j);
    }
  }

  const groups = new Map<number, ClusterToken[]>();
  for (let i = 0; i < clusterTokens.length; i++) {
    const root = uf.find(i);
    const arr = groups.get(root) ?? [];
    arr.push(clusterTokens[i]!);
    groups.set(root, arr);
  }

  const lines: TextLine[] = [];
  for (const groupTokens of groups.values()) {
    const sorted = [...groupTokens].sort((a, b) => a.along - b.along);
    const { fonts, dominantFont } = buildFontFingerprints(sorted);
    const tokenBBoxes = sorted.map((t) =>
      textRunBBox(t.token.transform as [number, number, number, number, number, number], t.token.width, t.token.height),
    );
    const bbox = tokenBBoxes.reduce((acc, r) => (acc ? unionRect(acc, r) : r), null as Rect | null)!;

    // Pozycja cross-axis reprezentatywna dla linii: dominujacego (najczestszego) fontu, nie srednia (odporne na indeksy gorne/dolne).
    const dominantTokens = sorted.filter((t) => t.token.fontKey === dominantFont.key);
    const crossAxisPosition = dominantTokens[0]?.cross ?? sorted[0]!.cross;

    lines.push({
      id: `p${pageNumber}-${angle}-${lines.length}`,
      text: joinTokenText(sorted, wordBoundaries),
      bbox,
      columnIndex: -1,
      crossAxisPosition,
      fonts,
      dominantFont,
      syntheticBold: sorted.some((t) => t.token.syntheticBold),
      runs: buildLineRuns(sorted, wordBoundaries),
      tokens: sorted.map((t, i) => ({ text: t.token.str, bbox: tokenBBoxes[i]! })),
    });
  }

  // Kolejnosc czytania: wzdluz osi PROSTOPADLEJ (linie ida "w dol" strumienia); dla 0°/90° cross rosnie w dol/w prawo
  // w ukladzie PDF (Y rosnie w gore), wiec porzadek czytania to malejace Y dla 0°/180°, rosnace X dla 90°/270°.
  const readingOrderSign = angle === 0 || angle === 180 ? -1 : 1;
  lines.sort((a, b) => readingOrderSign * (a.crossAxisPosition - b.crossAxisPosition));
  lines.forEach((line, i) => {
    line.id = `p${pageNumber}-${angle}-${i}`;
  });

  return joinHyphenatedLineWraps(lines, gutters);
}

/** Czy jakas podpowiedziana rynna lezy MIEDZY dwoma bboxami wzdluz X (jak `gutterBetween`, ale na juz uformowanych liniach). */
function gutterBetweenBBoxes(a: Rect, b: Rect, gutters: readonly GutterHint[]): boolean {
  if (gutters.length === 0) return false;
  const [earlier, later] = a.minX <= b.minX ? [a, b] : [b, a];
  return gutters.some((g) => g.minX < later.minX && earlier.maxX < g.maxX);
}

/**
 * Skleja wyraz przenoszony lacznikiem na koncu linii z poczatkiem nastepnej —
 * PO uformowaniu linii (brief Z5). Warunek: linia konczy sie plaskim lacznikiem
 * U+002D I nastepna linia zaczyna sie mala litera (zabezpieczenie przed
 * sklejeniem prawdziwego myslnika w tytule, np. "Chapter One-Two").
 *
 * [KROK-6, odkrycie] Bez sprawdzenia rynny to sklejalo koniec linii PRAWEJ
 * kolumny z poczatkiem linii LEWEJ kolumny nastepnego wiersza w globalnym
 * sortowaniu po Y (ktore nie wie nic o kolumnach) — zawsze gdy prawa kolumna
 * konczyla sie lacznikiem, a kolejna linia w sortowaniu (jakakolwiek, z
 * dowolnej kolumny) zaczynala sie mala litera. Zmierzone na prawdziwym pliku
 * (Cienie_posrod_mgie.pdf str. 46): "...Splot bezpo-" (prawa kolumna) sklejone
 * z "wadze sił..." (LEWA kolumna, zupelnie inny fragment tekstu) w jedno
 * fikcyjne slowo "bezpowadze".
 */
function joinHyphenatedLineWraps(lines: readonly TextLine[], gutters: readonly GutterHint[]): TextLine[] {
  const result: TextLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (result.length > 0) {
      const prev = result[result.length - 1]!;
      if (prev.text.endsWith(HYPHEN) && LOWERCASE_START_RE.test(line.text) && !gutterBetweenBBoxes(prev.bbox, line.bbox, gutters)) {
        const continuationMatch = /^\S+/.exec(line.text);
        const continuation = continuationMatch ? continuationMatch[0] : line.text;
        prev.text = prev.text.slice(0, -1) + continuation;
        prev.bbox = unionRect(prev.bbox, line.bbox);
        // Przyblizenie: doklejamy CALE runs nastepnej linii, bez dzielenia jej
        // pierwszego runu na "zjedzona przez continuation" i "reszte" czesc —
        // rzadki zbieg okolicznosci (przeniesienie lacznikiem DOKLADNIE w
        // miejscu przejscia roli fontu) nie uzasadnial dokladnego ciecia tekstu runu.
        prev.runs = [...(prev.runs ?? []), ...(line.runs ?? [])];
        prev.tokens = [...(prev.tokens ?? []), ...(line.tokens ?? [])];
        const remainder = line.text.slice(continuation.length).replace(/^\s+/, '');
        if (remainder.length > 0) {
          result.push({ ...line, text: remainder });
        }
        continue;
      }
    }
    result.push({ ...line });
  }
  return result;
}
