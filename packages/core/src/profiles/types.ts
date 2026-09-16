import type { Rect } from '../geometry.js';
import type { FontRole } from '../inventory/fontRegistry.js';

/**
 * [KROK-18 Z2] Token wejsciowy silnika wzorcow — CELOWO plaski i niezalezny od
 * `MergedToken`/`LineToken`/`TextLine` (layout/*, semantic/*). MDD §5.5:
 * silnik operuje na "surowym strumieniu tokenow pdf.js plus geometrii z
 * inwentaryzacji" — NIGDY na `SemanticBlock[]` (krok 12 wykazal, ze
 * `buildSemanticBlocks` rozbija statblock na 20-30 fragmentow i skleja dane
 * roznych encji, S1). Wywolujacy buduje `ProfileToken[]` z dowolnego zrodla
 * (raw `TextItem`, `MergedToken` po higienie/scalaniu slow) — silnik nie
 * zaklada, KTORY etap potoku je dostarczyl, tylko ze sa uporzadkowane w
 * kolejnosci strumienia tekstu PDF-a (nie w kolejnosci czytania — S3: encje
 * wystepuja partiami, parowanie geometryczne dzieje sie osobno, poza tym plikiem).
 */
export interface ProfileToken {
  text: string;
  bbox: Rect;
  /** [KROK-18 Z3] Rola fontu z inwentaryzacji (`buildInventory().fontRoles`) — wejscie do `fontRoleCandidate` (kandydaci na nazwe encji). Opcjonalne: `labelledPairs`/`sectionList` (Z2) go nie potrzebuja. */
  fontRole?: FontRole;
  /** [KROK-29 Z3] Klucz nosny fontu (`buildFontKey` — BaseFont po zdjeciu prefiksu subsetu + rozmiar), NIEZALEZNY od `fontRole` (ktory jest rankingiem CZESTOSCI/rozmiaru per dokument, nie identyfikatorem konkretnego kroju). Wejscie do `fontRoleCandidate.requireFontKeys` — klikniecie kandydata na nazwe w Profile Studio uczy sie TEGO klucza, zawezajac fatalna precyzje samej roli fontu (H2 kroku 12: 2401 kandydatow na 15 encji) do faktycznie uzywanego kroju. Opcjonalne z tego samego powodu co `fontRole`. */
  fontKey?: string;
  /** [KROK-18 Z3] Numer strony tokenu — potrzebny `excludeRepeatedAcrossPages` (H2: naglowki/stopki powtarzajace sie identycznym tekstem na wielu stronach to NIE kandydaci na nazwe). Opcjonalne z tego samego powodu co `fontRole`. */
  page?: number;
}
