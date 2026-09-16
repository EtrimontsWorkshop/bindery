import type { ProfileToken } from './types.js';
import type { LabelledPairsPattern, SectionListPattern, FontRoleCandidatePattern } from './schema.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { matchFontRoleCandidate, type FontRoleCandidateMatch } from './entityName.js';
import { attachNearest, classifyRelativeDirection, directionalDistance, type AttachCandidate, type AttachStrategy, type GeometricAnchor } from './entityAssembly.js';

/**
 * [KROK-24 Z2] Mierzy WZAJEMNE POLOZENIE kotwicy (siatka cech) i drugiego
 * wzorca (pochodne/ataki/umiejetnosci) na WSZYSTKICH stronach dokumentu, gdzie
 * oba wystepuja — zamiast kazac autorowi profilu ZGADYWAC strategie
 * (`nearestBelow`/`nearestAbove`/`nearest`) i limit (`maxDistancePt`), tak jak
 * w kroku 19 (`nearestBelow` dawalo 5/15 dolaczonych blokow pochodnych, bo w
 * tej ksiazce siatka i pochodne stoja OBOK SIEBIE — autor odkryl to dopiero
 * pomiarem recznym po fakcie, patrz `write-coc7-niczas-profile.ts`).
 *
 * Parowanie per strona uzywa `attachNearest` ze strategia `'nearest'` i BEZ
 * limitu odleglosci (`Infinity`) — TO SAMO globalne zachlanne dopasowanie o
 * minimalnym dystansie co prawdziwy potok (KROK-21, `attachNearestInternal`),
 * tylko bez progu, zeby zmierzyc PRAWDZIWE odleglosci, nie tylko te juz
 * mieszczace sie w jakims domysle. Wynik tego parowania (ktora siatka
 * "nalezy" do ktorego kandydata) jest wejsciem do klasyfikacji kierunku
 * (`classifyRelativeDirection`) — NIE odwrotnie: kierunek nie wplywa na to,
 * ktore pary sa mierzone.
 */

export interface AttachGeometryMeasurement {
  /** Liczba stron, na ktorych OBA wzorce (kotwica i kandydat) w ogole wystapily — male wartosci = ostrzezenie "za malo danych do pomiaru". */
  pagesWithBoth: number;
  /** Liczba faktycznie sparowanych (kotwica, kandydat) par na tych stronach. */
  measuredPairCount: number;
  belowCount: number;
  aboveCount: number;
  /** Kandydat ani ponizej, ani powyzej kotwicy (np. obok, w sasiedniej kolumnie) — sygnal dla `'nearest'`. */
  besideCount: number;
  suggestedStrategy: AttachStrategy;
  /**
   * Zmierzone dystanse (w metryce `suggestedStrategy`) dla par NALEZACYCH do
   * wiekszosciowego kierunku — POSORTOWANE rosnaco. Brief kroku 24 wprost:
   * "Pokaz rozklad, nie sama liczbe" — autor profilu ma widziec, czy
   * przypadki sa zwarte, czy rozstrzelone, nie tylko jedna zagregowana liczbe.
   */
  distances: number[];
  /** `Math.max(distances) + margines`, zaokraglone w gore — punkt startowy do wpisania w `maxDistancePt`, NIE ostateczna decyzja (autor moze zawsze zmienic). `null`, gdy `distances` jest puste (brak zmierzonych par). */
  suggestedMaxDistancePt: number | null;
}

const SUGGESTED_MAX_DISTANCE_MARGIN_PT = 10;

function toCandidates(
  matches: readonly LabelledPairsMatch[] | readonly SectionListMatch[] | readonly FontRoleCandidateMatch[],
  tokens: readonly ProfileToken[],
  kind: 'labelledPairs' | 'sectionList' | 'fontRoleCandidate',
): AttachCandidate[] {
  if (kind === 'labelledPairs') return (matches as readonly LabelledPairsMatch[]).map((m) => ({ bbox: m.bbox, tokenIndex: m.startIndex }));
  if (kind === 'fontRoleCandidate') return (matches as readonly FontRoleCandidateMatch[]).map((m) => ({ bbox: m.bbox, tokenIndex: m.tokenIndex }));
  return (matches as readonly SectionListMatch[]).map((m) => ({ bbox: tokens[m.headerTokenIndex]!.bbox, tokenIndex: m.headerTokenIndex }));
}

export function measureAttachGeometry(
  pages: readonly { tokens: readonly ProfileToken[] }[],
  anchorPattern: LabelledPairsPattern,
  candidatePattern: LabelledPairsPattern | SectionListPattern | FontRoleCandidatePattern,
): AttachGeometryMeasurement {
  let pagesWithBoth = 0;
  let belowCount = 0;
  let aboveCount = 0;
  let besideCount = 0;
  const distancesBelow: number[] = [];
  const distancesAbove: number[] = [];
  const distancesNearest: number[] = [];

  for (const { tokens } of pages) {
    const grids = matchLabelledPairs(tokens, anchorPattern);
    const candidateMatches =
      candidatePattern.kind === 'labelledPairs'
        ? matchLabelledPairs(tokens, candidatePattern)
        : candidatePattern.kind === 'fontRoleCandidate'
          ? matchFontRoleCandidate(tokens, candidatePattern)
          : matchSectionList(tokens, candidatePattern);
    if (grids.length === 0 || candidateMatches.length === 0) continue;
    pagesWithBoth++;

    const anchors: GeometricAnchor[] = grids.map((g) => ({ bbox: g.bbox, anchorTokenIndex: g.startIndex }));
    const candidates = toCandidates(candidateMatches, tokens, candidatePattern.kind);
    const attached = attachNearest(anchors, candidates, 'nearest', Number.POSITIVE_INFINITY);

    attached.forEach((cand, i) => {
      if (!cand) return;
      const anchorBbox = anchors[i]!.bbox;
      const nearestDist = directionalDistance(anchorBbox, cand.bbox, 'nearest')!; // 'nearest' nigdy nie zwraca null
      distancesNearest.push(nearestDist);
      const direction = classifyRelativeDirection(anchorBbox, cand.bbox);
      if (direction === 'below') {
        belowCount++;
        distancesBelow.push(directionalDistance(anchorBbox, cand.bbox, 'nearestBelow')!);
      } else if (direction === 'above') {
        aboveCount++;
        distancesAbove.push(directionalDistance(anchorBbox, cand.bbox, 'nearestAbove')!);
      } else {
        besideCount++;
      }
    });
  }

  // [tabela z briefu kroku 24] "Konsekwentnie" = KAZDA zmierzona para (nie tylko wiekszosc) dzieli ten sam kierunek — jeden wyjatek juz dyskwalifikuje kierunkowa strategie, bo `nearestBelow`/`nearestAbove` odrzucalyby ten wyjatek CALKOWICIE (null, nie "daleko"), nie tylko robily go gorszym kandydatem.
  let suggestedStrategy: AttachStrategy;
  let distances: number[];
  if (belowCount > 0 && aboveCount === 0 && besideCount === 0) {
    suggestedStrategy = 'nearestBelow';
    distances = distancesBelow;
  } else if (aboveCount > 0 && belowCount === 0 && besideCount === 0) {
    suggestedStrategy = 'nearestAbove';
    distances = distancesAbove;
  } else {
    suggestedStrategy = 'nearest';
    distances = distancesNearest;
  }
  distances.sort((a, b) => a - b);

  const suggestedMaxDistancePt = distances.length > 0 ? Math.ceil(Math.max(...distances) + SUGGESTED_MAX_DISTANCE_MARGIN_PT) : null;

  return {
    pagesWithBoth,
    measuredPairCount: belowCount + aboveCount + besideCount,
    belowCount,
    aboveCount,
    besideCount,
    suggestedStrategy,
    distances,
    suggestedMaxDistancePt,
  };
}
