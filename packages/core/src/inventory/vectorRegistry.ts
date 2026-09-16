import type { Rect } from '../geometry.js';
import { relativeArea as computeRelativeArea } from '../geometry.js';
import type { WalkEvent } from './walkOperators.js';

/**
 * Prostokatne wypelnienia/obrysy — kandydaci na ramki i tla statblokow
 * (faza 2, krok scalania w bloki). `walkOperators` juz odrzucil wszystko,
 * co nie jest osiowo zorientowanym prostokatem — ten modul tylko dolicza
 * `relativeArea` i porzadkuje wynik per strona.
 */
export interface VectorRegion {
  kind: 'fill' | 'stroke';
  bbox: Rect;
  page: number;
  /** Powierzchnia wzgledem strony — odroznia ramke statblocku od tla calej strony. */
  relativeArea: number;
  /**
   * [KROK-5 Z6, dlug z KROK-4] Subtype grupy nadrzednej (np. "Luminosity"),
   * gdy ta sciezka/wypelnienie zostaly narysowane wewnatrz beginGroup. Bez
   * tego pola maski luminancyjne, ktorych forma maluje wypelnienie wektorowe
   * zamiast obrazu (patrz RAPORT-KROK-4.md), byly calkowicie niewidoczne dla
   * jakiejkolwiek przyszlej klasyfikacji masek — ten modul tylko przenosi
   * fakt geometryczny, decyzja klasyfikacyjna nadal nalezy do fazy 3.
   */
  groupSubtype: string | null;
}

/** Buduje regiony wektorowe dla jednej strony z eventow `walkOperators` typu 'vector'. */
export function buildVectorRegions(events: readonly WalkEvent[], page: number, pageBox: Rect): VectorRegion[] {
  const regions: VectorRegion[] = [];
  for (const e of events) {
    if (e.type !== 'vector') continue;
    regions.push({
      kind: e.kind,
      bbox: e.bbox,
      page,
      relativeArea: computeRelativeArea(e.bbox, pageBox),
      groupSubtype: e.inGroup?.subtype ?? null,
    });
  }
  return regions;
}
