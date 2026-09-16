import { groupByQuantizedPosition } from '../collections.js';
import type { TextLine } from './lineCluster.js';

/**
 * Naglowki/stopki biegnace (KROK-6 Z5) — wykrywane przez POWTARZALNOSC miedzy
 * stronami (wzorzec A8: wymaga widoku calego dokumentu, jak Z2/Z5-KROK5).
 *
 * NIGDY nie dopasowuj po dokladnym tekscie — numer strony sie zmienia, a to
 * najczestszy element biegnacy. Dopasowanie po KONIUNKCJI: pasmo pionowe +
 * klucz fontu + PODOBNA (nie identyczna) szerokosc/pozycja pozioma + obecnosc
 * na >= 60% stron w zakresie.
 */

export interface RunningElementMatch {
  pageNumber: number;
  lineId: string;
  kind: 'header' | 'footer';
}

export interface PageForRunningElements {
  pageNumber: number;
  pageHeight: number;
  /** Linie strumienia PODSTAWOWEGO (0°) tej strony — naglowki/stopki biegnace sa poziome. */
  primaryLines: readonly TextLine[];
}

export interface RunningElementOptions {
  /** Pasmo gorne: y > tejWartosci * wysokosc strony = kandydat na naglowek. */
  headerBandFraction?: number;
  /** Pasmo dolne: y < tejWartosci * wysokosc strony = kandydat na stopke. */
  footerBandFraction?: number;
  /** Minimalny odsetek stron w zakresie, na ktorych sygnatura musi wystapic. */
  minPageFraction?: number;
  /** Tolerancja pozycji poziomej (pt) — naglowki sa zwykle wyrownane identycznie. */
  positionTolerancePt?: number;
  /** Tolerancja szerokosci (pt) — WIEKSZA niz pozycji: numer strony zmienia liczbe cyfr (np. "9" vs "10"). */
  widthTolerancePt?: number;
}

const DEFAULT_HEADER_BAND_FRACTION = 0.93;
const DEFAULT_FOOTER_BAND_FRACTION = 0.07;
const DEFAULT_MIN_PAGE_FRACTION = 0.6;
const DEFAULT_POSITION_TOLERANCE_PT = 3;
const DEFAULT_WIDTH_TOLERANCE_PT = 12;

interface Candidate {
  pageNumber: number;
  line: TextLine;
  kind: 'header' | 'footer';
}

function quantize(v: number, tolerance: number): number {
  return Math.round(v / tolerance);
}

/**
 * Wykrywa naglowki/stopki biegnace na CALYM dokumencie (lub przekazanym
 * zakresie stron — brief: "w zakresie", nie zawsze caly dokument). Zwraca
 * dopasowania do OZNACZENIA (`BlockKind: 'header'|'footer'` w Z6) — nigdy nie
 * usuwa linii z modelu.
 */
export function detectRunningElements(
  pages: readonly PageForRunningElements[],
  opts: RunningElementOptions = {},
): RunningElementMatch[] {
  const headerBandFraction = opts.headerBandFraction ?? DEFAULT_HEADER_BAND_FRACTION;
  const footerBandFraction = opts.footerBandFraction ?? DEFAULT_FOOTER_BAND_FRACTION;
  const minPageFraction = opts.minPageFraction ?? DEFAULT_MIN_PAGE_FRACTION;
  const positionTolerancePt = opts.positionTolerancePt ?? DEFAULT_POSITION_TOLERANCE_PT;
  const widthTolerancePt = opts.widthTolerancePt ?? DEFAULT_WIDTH_TOLERANCE_PT;

  const candidates: Candidate[] = [];
  for (const page of pages) {
    if (page.pageHeight <= 0) continue;
    for (const line of page.primaryLines) {
      const y = (line.bbox.minY + line.bbox.maxY) / 2;
      const relativeY = y / page.pageHeight;
      if (relativeY > headerBandFraction) {
        candidates.push({ pageNumber: page.pageNumber, line, kind: 'header' });
      } else if (relativeY < footerBandFraction) {
        candidates.push({ pageNumber: page.pageNumber, line, kind: 'footer' });
      }
    }
  }

  const groups = groupByQuantizedPosition(candidates, (c) => {
    const width = c.line.bbox.maxX - c.line.bbox.minX;
    return [
      c.kind,
      c.line.dominantFont.key,
      quantize(c.line.bbox.minX, positionTolerancePt),
      quantize(width, widthTolerancePt),
    ].join('|');
  });

  const totalPages = pages.length;
  const matches: RunningElementMatch[] = [];
  for (const group of groups.values()) {
    const distinctPages = new Set(group.map((c) => c.pageNumber));
    if (totalPages > 0 && distinctPages.size / totalPages >= minPageFraction) {
      for (const c of group) {
        matches.push({ pageNumber: c.pageNumber, lineId: c.line.id, kind: c.kind });
      }
    }
  }

  return matches;
}
