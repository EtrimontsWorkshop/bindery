import type { ProfileToken } from './types.js';
import type { LabelledPairsPattern, SectionListPattern, FontRoleCandidatePattern } from './schema.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { matchFontRoleCandidate, type FontRoleCandidateMatch } from './entityName.js';
import { attachNearest, classifyRelativeDirection, directionalDistance, type AttachCandidate, type AttachStrategy, type GeometricAnchor } from './entityAssembly.js';

/**
 * [Step 24 Z2] Measures the MUTUAL POSITION of the anchor (attribute grid) and a second
 * pattern (derived stats/attacks/skills) across ALL pages of the document where
 * both occur — instead of making the profile author GUESS the strategy
 * (`nearestBelow`/`nearestAbove`/`nearest`) and the limit (`maxDistancePt`), as
 * happened in step 19 (`nearestBelow` only attached 5/15 derived-stat blocks, because in
 * this book the grid and the derived stats sit SIDE BY SIDE — the author only discovered this
 * via manual measurement after the fact, see `write-coc7-niczas-profile.ts`).
 *
 * Per-page pairing uses `attachNearest` with the `'nearest'` strategy and NO
 * distance limit (`Infinity`) — the SAME global greedy minimum-distance matching as
 * the real pipeline (Step 21, `attachNearestInternal`), just without a
 * threshold, in order to measure the TRUE distances, not just the ones that already
 * fit some guess. The result of this pairing (which grid
 * "belongs" to which candidate) is the input to direction classification
 * (`classifyRelativeDirection`) — NOT the other way around: direction does not affect
 * which pairs get measured.
 */

export interface AttachGeometryMeasurement {
  /** Number of pages on which BOTH patterns (anchor and candidate) occurred at all — small values = a "too little data to measure" warning. */
  pagesWithBoth: number;
  /** Number of actually paired (anchor, candidate) pairs across those pages. */
  measuredPairCount: number;
  belowCount: number;
  aboveCount: number;
  /** Candidate neither below nor above the anchor (e.g. beside it, in a neighboring column) — a signal for `'nearest'`. */
  besideCount: number;
  suggestedStrategy: AttachStrategy;
  /**
   * Measured distances (in the `suggestedStrategy` metric) for pairs BELONGING to the
   * majority direction — SORTED ascending. The step-24 brief is explicit:
   * "Show the distribution, not just a single number" — the profile author should see whether
   * cases are tightly clustered or spread out, not just one aggregated number.
   */
  distances: number[];
  /** `Math.max(distances) + margin`, rounded up — a starting point to enter into `maxDistancePt`, NOT a final decision (the author can always change it). `null` when `distances` is empty (no measured pairs). */
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
      const nearestDist = directionalDistance(anchorBbox, cand.bbox, 'nearest')!; // 'nearest' never returns null
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

  // [table from the step-24 brief] "Consistently" = EVERY measured pair (not just the majority) shares the same direction — a single exception already disqualifies a directional strategy, because `nearestBelow`/`nearestAbove` would reject that exception ENTIRELY (null, not "far away"), not merely make it a worse candidate.
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
