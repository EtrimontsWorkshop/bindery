import { unionRect, type Rect } from '../geometry.js';
import type { TextLine } from './lineCluster.js';

/**
 * Rozdzielenie linii rozpinajacych od kolumnowych (KROK-6 Z2) — MUSI poprzedzac
 * detekcje kolumn (Z3): pelnowymiarowy naglowek nad dwiema kolumnami wypelnia
 * rynne miedzy nimi i niszczy dolina w histogramie gestosci. Dziala WYLACZNIE
 * na strumieniu podstawowym (0°) — strumienie ≠ 0° to marginalia, poza
 * zakresem detekcji kolumn z definicji (MDD §5.1).
 */

export interface SpanningSplit {
  spanning: TextLine[];
  columnar: TextLine[];
  /** Szerokosc bloku tekstu uzyta do progu — do diagnostyki/kalibracji. */
  textBlockWidth: number;
}

/**
 * Prog "rozpinajaca" jako udzial szerokosci bloku tekstu. Wartosc startowa z
 * briefu (~70%) — dwukolumnowy uklad ma kolumny o szerokosci ~45-48% bloku
 * (z odstepem miedzy nimi), wiec 70% jednoznacznie odrzuca pojedyncza kolumne,
 * ale lapie kazdy naglowek szerszy niz jakakolwiek pojedyncza kolumna moglaby
 * byc. Kalibrowane na plikach z `samples/` (RAPORT-KROK-6.md).
 */
const DEFAULT_SPANNING_WIDTH_RATIO = 0.7;
/** Te same progi co domyslne w runningElements.ts (Z5) — pasmo pionowe uznawane za margines strony. */
const DEFAULT_HEADER_BAND_FRACTION = 0.93;
const DEFAULT_FOOTER_BAND_FRACTION = 0.07;

function computeTextBlockBBox(lines: readonly TextLine[]): Rect | null {
  return lines.reduce<Rect | null>((acc, line) => (acc ? unionRect(acc, line.bbox) : line.bbox), null);
}

function lineWidth(line: TextLine): number {
  return line.bbox.maxX - line.bbox.minX;
}

/**
 * [KROK-6, odkrycie] Linia w pasmie naglowka/stopki (patrz Z5) potrafi
 * siedziec DALEKO na marginesie (np. numer stopki x=5, podczas gdy prawdziwa
 * tresc zaczyna sie od x=51) — wliczona do histogramu kolumn (Z3) przesuwa
 * granice bloku tekstu i tworzy FIKCYJNA "dolinie" tuz kolo marginesu zamiast
 * prawdziwej rynny miedzykolumnowej. Zmierzone na Cienie_posrod_mgie.pdf str.
 * 20: stopka "Maciej Pasierbek..." (x=5) + numer strony "20" (x=30) psuly
 * detekcje 2 kolumn (dawaly falszywa "kolumne" 1-elementowa kolo x=5-51,
 * ktora poprawka "sparse merge" [patrz columns.ts] zjadala razem z PRAWDZIWA
 * rynna). Naglowki/stopki NIE naleza do zadnej kolumny z definicji — musza
 * wypasc z histogramu, niezaleznie od szerokosci. Nie usuwamy ich z modelu
 * (brief Z5) — trafiaja do `spanning`, ktore i tak wraca w Z4 jako wlasne
 * pasmo (naglowek/stopka na koncu/poczatku kolejnosci czytania, tak jak
 * powinno byc).
 */
function isInMarginBand(line: TextLine, pageHeight: number): boolean {
  if (pageHeight <= 0) return false;
  const relativeY = (line.bbox.minY + line.bbox.maxY) / 2 / pageHeight;
  return relativeY > DEFAULT_HEADER_BAND_FRACTION || relativeY < DEFAULT_FOOTER_BAND_FRACTION;
}

/**
 * Dzieli linie strumienia podstawowego na rozpinajace (szerokosc >= prog *
 * szerokosc bloku tekstu, lub w pasmie naglowka/stopki — patrz `isInMarginBand`)
 * i kolumnowe (reszta). Histogram kolumn (Z3) liczy WYLACZNIE z `columnar`;
 * `spanning` wraca przy budowie kolejnosci czytania (Z4). `pageHeight=0`
 * (domyslnie) wylacza sprawdzanie pasma marginesu — wymaga geometrii calej
 * strony, ktorej fixture'y jednostkowe czesto nie potrzebuja.
 */
export function splitSpanningLines(
  lines: readonly TextLine[],
  widthRatio: number = DEFAULT_SPANNING_WIDTH_RATIO,
  pageHeight = 0,
): SpanningSplit {
  const marginLines: TextLine[] = [];
  const bodyLines: TextLine[] = [];
  for (const line of lines) {
    if (isInMarginBand(line, pageHeight)) marginLines.push(line);
    else bodyLines.push(line);
  }

  const textBlock = computeTextBlockBBox(bodyLines);
  const textBlockWidth = textBlock ? textBlock.maxX - textBlock.minX : 0;
  if (textBlockWidth <= 0) {
    return { spanning: [...marginLines], columnar: [...bodyLines], textBlockWidth: 0 };
  }

  const threshold = textBlockWidth * widthRatio;
  const candidates = bodyLines.filter((line) => lineWidth(line) >= threshold);

  // [KROK-6, odkrycie] Prog "70% szerokosci bloku" zaklada cichy TYPOWY przypadek:
  // rozpinajacy naglowek to MNIEJSZOSC linii strony, otoczona wyrazniej wezszymi
  // liniami kolumnowymi. Na PRAWDZIWIE jednokolumnowej stronie kazda linia z
  // definicji wypelnia niemal cala szerokosc WLASNEGO bloku tekstu — blok liczony
  // ze WSZYSTKICH linii tej strony, wiec "szerokosc bloku" to w praktyce "typowa
  // szerokosc linii", i prawie kazda linia (>50%) przekracza prog. Bez tej
  // poprawki cala strona jednokolumnowa trafiala do `spanning`, zostawiajac Z3
  // (detectColumns) bez zadnych linii kolumnowych — zweryfikowane empirycznie na
  // fixture layout-1col (10/10 linii, brak dolin do znalezienia, zero kolumn
  // zamiast poprawnej odpowiedzi "1 kolumna").
  if (candidates.length > bodyLines.length / 2) {
    return { spanning: [...marginLines], columnar: [...bodyLines], textBlockWidth };
  }

  const spanning: TextLine[] = [...marginLines];
  const columnar: TextLine[] = [];
  for (const line of bodyLines) {
    if (lineWidth(line) >= threshold) spanning.push(line);
    else columnar.push(line);
  }
  return { spanning, columnar, textBlockWidth };
}
