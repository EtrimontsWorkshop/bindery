import { groupByQuantizedPosition } from '../collections.js';
import { hasBoundaryBetween } from '../text/hygiene.js';
import type { CleanItem, WordBoundary } from '../text/types.js';
import { effectiveGapProfileForPage, type HierarchicalGapProfile } from '../text/gapStatistics.js';
import { axisPositions, baselineTolerance, fontSizeFromTransform, type StreamAngle } from './textGeometry.js';

/**
 * Scalanie fragmentow w tokeny wysokiego prawdopodobienstwa spojnosci (KROK-5
 * Z4). Scala DWA sasiadujace itemy tylko gdy WSZYSTKIE warunki z briefu sa
 * spelnione — brak choc jednego = brak scalenia. Wynik NIE jest "slowem" w
 * sensie jezykowym (brak walidacji slownikowej, brak detekcji jezyka).
 *
 * P1 (polskie wyrazy jednoliterowe: w, z, i, o, a, u, e): NIGDY nie uzywamy
 * samej dlugosci tokenu jako przeslanki do scalania — warunki ponizej nie
 * odwoluja sie do dlugosci `str` w ogole.
 */

export interface MergeCandidateItem extends CleanItem {
  fontKey: string;
}

export interface MergedToken {
  str: string;
  /** Transform PIERWSZEGO zrodlowego itemu — kotwica pozycji tokenu. */
  transform: readonly number[];
  /** Rozpietosc wzdluz osi czytania od kotwicy do konca OSTATNIEGO zrodlowego itemu. */
  width: number;
  height: number;
  fontKey: string;
  fontName: string;
  syntheticBold: boolean;
  /** [F0] Slad scalenia — oryginalne indeksy + powod, do ekranu przegladu (faza 9). */
  sourceIndices: number[];
  mergeReason: 'no-merge' | 'gap-below-threshold';
}

const MERGE_REASON_NONE: MergedToken['mergeReason'] = 'no-merge';
const MERGE_REASON_GAP: MergedToken['mergeReason'] = 'gap-below-threshold';

function toToken(item: MergeCandidateItem): MergedToken {
  return {
    str: item.str,
    transform: item.transform,
    width: item.width,
    height: item.height,
    fontKey: item.fontKey,
    fontName: item.fontName,
    syntheticBold: item.syntheticBold,
    sourceIndices: [item.index],
    mergeReason: MERGE_REASON_NONE,
  };
}

/**
 * Powod decyzji o (nie)scaleniu pary sasiadujacych itemow — uzywane zarowno
 * przez `mergeWords` jak i przez `tools/calibrate-merge.mjs` (KROK-5, kalibracja
 * na plikach z `samples/`), zeby narzedzie diagnostyczne nie powielalo logiki
 * produkcyjnej.
 */
export type MergeBlockReason =
  | 'merged'
  | 'different-font'
  | 'word-boundary'
  | 'different-baseline'
  | 'unreliable-profile'
  | 'gap-too-large'
  | 'overlapping';

/**
 * Klasyfikuje, czy `next` powinien scalic sie z `prev` — WSZYSTKIE warunki z
 * tabeli briefu (Z4) musza byc spelnione, sprawdzane w tej samej kolejnosci co
 * w tabeli. `angle` to kat strumienia, wspolny dla calego wywolania mergeWords
 * (warunek #3 spelniony z definicji, bo wolajacy dzieli juz itemy na strumienie
 * katowe przed wywolaniem — patrz Z3).
 */
export function classifyMergeDecision(
  prev: MergeCandidateItem,
  next: MergeCandidateItem,
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  gapProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
  page: number,
): MergeBlockReason {
  // #1 Ten sam klucz fontu.
  if (prev.fontKey !== next.fontKey) return 'different-font';

  // #4 [U2, TWARDY] Brak granicy z wordBoundaries miedzy nimi.
  if (hasBoundaryBetween(wordBoundaries, prev.index, next.index)) return 'word-boundary';

  // #2 Ta sama linia bazowa (tolerancja wspoldzielona z Z5, patrz textGeometry.ts).
  const prevAxis = axisPositions(prev.transform, angle);
  const nextAxis = axisPositions(next.transform, angle);
  const tolerance = baselineTolerance(fontSizeFromTransform(prev.transform));
  if (Math.abs(prevAxis.cross - nextAxis.cross) > tolerance) return 'different-baseline';

  // #6 Profil fontu musi byc wiarygodny (separation powyzej progu ufnosci) — Z2.
  // [KROK-6 Z1a] Bardziej zachowawczy z progu dokumentowego i stronicowego (patrz effectiveGapProfileForPage).
  const hierarchical = gapProfiles.get(prev.fontKey);
  if (!hierarchical) return 'unreliable-profile';
  const profile = effectiveGapProfileForPage(hierarchical, page);
  if (!profile.reliable) return 'unreliable-profile';

  // #5 Odstep SCISLE ponizej progu wewnatrzwyrazowego dla tego fontu.
  const gap = nextAxis.along - (prevAxis.along + prev.width);
  // [KROK-6, odkrycie] Odstep UJEMNY (itemy nakladajace sie geometrycznie wzdluz
  // osi czytania) NIE jest "blisko" — to zawsze odrebne, nieciagle elementy (np.
  // dwie kolumny geste tabeli/spisu tresci ktore przypadkiem wspoldziela linie
  // bazowa), nigdy prawdziwa fragmentacja jednego slowa. Bez tej granicy dolnej
  // `gap < intraWordThreshold` przepuszczalo KAZDY ujemny gap (zawsze "mniejszy"
  // niz dowolny dodatni prog) — zweryfikowane empirycznie: to byla PRAWDZIWA
  // przyczyna sklejen na str. 3 Cienie_posrod_mgie.pdf (Z1a), nie kalibracja progu.
  if (gap < 0) return 'overlapping';
  if (!(gap < profile.intraWordThreshold)) return 'gap-too-large';

  return 'merged';
}

/**
 * Grupuje po PRZYBLIZONEJ linii bazowej (cross-axis, zaokraglone do tolerancji)
 * PRZED sortowaniem/scalaniem wzdluz osi czytania — bez tego calenie porownuje
 * fragmenty z ROZNYCH linii, ktore przypadkiem znalazly sie obok siebie w
 * globalnym sortowaniu po samej osi `along` (wykryte empirycznie kalibracja na
 * plikach z `samples/`, KROK-5: na stronie wieloliniowej >90% par "sasiednich"
 * po takim globalnym sortowaniu bylo z roznych linii — blokowane poprawnie
 * przez warunek #2, ale marnujace pracie i, gorzej, mogace pominac prawdziwe
 * scalenia jesli fragment innej linii wsuwa sie miedzy dwa fragmenty tej samej
 * linii w sortowaniu). Ta sama metoda bucketowania co `collectGapSamples` (Z2).
 */
function bucketByBaseline(items: readonly MergeCandidateItem[], angle: StreamAngle): MergeCandidateItem[][] {
  const buckets = groupByQuantizedPosition(items, (item) => {
    const cross = axisPositions(item.transform, angle).cross;
    const tolerance = baselineTolerance(fontSizeFromTransform(item.transform));
    return String(Math.round(cross / tolerance));
  });
  return [...buckets.keys()]
    .sort((a, b) => Number(b) - Number(a))
    .map((key) => buckets.get(key)!);
}

/**
 * Scala sasiadujace itemy JEDNEGO strumienia katowego (juz po higienie, Z1) w
 * tokeny. Wolajacy (orkiestrator) dostarcza itemy jednego kata na raz (Z3
 * poprzedza Z4); kolejnosc wejscia jest nieistotna — funkcja grupuje po linii
 * bazowej i sortuje wzdluz osi czytania wewnatrz kazdej grupy sama.
 */
export function mergeWords(
  items: readonly MergeCandidateItem[],
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  gapProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
  page: number,
): MergedToken[] {
  const tokens: MergedToken[] = [];

  for (const bucket of bucketByBaseline(items, angle)) {
    const sorted = [...bucket].sort((a, b) => axisPositions(a.transform, angle).along - axisPositions(b.transform, angle).along);

    let lastPhysicalItem: MergeCandidateItem | undefined;
    let currentTokenAnchorAlong = 0;

    for (const item of sorted) {
      const last = tokens[tokens.length - 1];

      if (last && lastPhysicalItem && classifyMergeDecision(lastPhysicalItem, item, angle, wordBoundaries, gapProfiles, page) === 'merged') {
        last.str += item.str;
        last.sourceIndices.push(item.index);
        last.mergeReason = MERGE_REASON_GAP;
        last.syntheticBold = last.syntheticBold || item.syntheticBold;
        const itemEnd = axisPositions(item.transform, angle).along + item.width;
        last.width = itemEnd - currentTokenAnchorAlong;
      } else {
        tokens.push(toToken(item));
        currentTokenAnchorAlong = axisPositions(item.transform, angle).along;
      }

      lastPhysicalItem = item;
    }
  }

  return tokens;
}
