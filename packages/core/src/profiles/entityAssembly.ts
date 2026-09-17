import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { LabelledPairsMatch } from './patterns.js';

/**
 * [Step 18 Z3] Entity assembly via geometry — an implementation of
 * `entityAssembly` from MDD §5.5. GEOMETRIC pairing (bbox), not by
 * order in the text stream — S3: entities occur in batches (all
 * names, then all grids, then all derived-stats/attack blocks, NOT
 * interleaved per-entity, confirmed directly on p. 55 of the step-12/13
 * book).
 *
 * Two separate functions:
 * - `attachNearest` — general attachment (derivedBlock/attackSection to a
 *   grid anchor), simply returns the nearest candidate in a given
 *   direction, or `null`. No confidence concept — the MDD doesn't require confidence
 *   for these patterns, only for the name (S4).
 * - `resolveEntityNames` — name<->grid pairing (H3 from the step-13 spike),
 *   WITH BUILT-IN confidence and a threshold (S4): below `nameConfidenceThreshold`
 *   NEVER guess, a placeholder + a list of candidates to resolve in the
 *   review (a wrong name is worse than none).
 */

export interface GeometricAnchor {
  bbox: Rect;
  /** Index of this anchor's first token in the stream — for processing order and `preferEarlierSibling`. */
  anchorTokenIndex: number;
}

export interface AttachCandidate {
  bbox: Rect;
  tokenIndex: number;
}

export type AttachStrategy = 'nearestBelow' | 'nearestAbove' | 'nearest';

export interface PreferEarlierSiblingConfig {
  maxDeltaYPt: number;
}

/**
 * Distance of a candidate from the anchor IN THE PROPER DIRECTION, or `null` if
 * the candidate doesn't lie in that direction at all (PDF: Y increases UPWARD on the
 * page — "below" = SMALLER Y, see `pageOverlayGeometry.ts`).
 *
 * [Step 18 Z7] `nearest` — WITHOUT a directional requirement, plain Euclidean distance
 * between bbox edges. Added after measuring across the whole book: pages with
 * multiple characters lay out the grid and its derived-stats block SIDE BY SIDE on the
 * same line (columns), not one below the other — `nearestBelow`/`nearestAbove`
 * never find such a candidate (the directional condition is never satisfied),
 * regardless of `maxDistancePt`. See the comment at `AttachStrategy` in schema.ts.
 */
export function directionalDistance(anchor: Rect, candidate: Rect, strategy: AttachStrategy): number | null {
  const horizontalGap = Math.max(candidate.minX - anchor.maxX, anchor.minX - candidate.maxX, 0);
  if (strategy === 'nearest') return rectGapDistance(anchor, candidate);
  if (strategy === 'nearestBelow') {
    if (candidate.maxY > anchor.minY) return null;
    return Math.hypot(anchor.minY - candidate.maxY, horizontalGap);
  }
  if (candidate.minY < anchor.maxY) return null;
  return Math.hypot(candidate.minY - anchor.maxY, horizontalGap);
}

export type RelativeDirection = 'below' | 'above' | 'beside';

/**
 * [Step 24 Z2] Classifies a candidate's POSITION relative to the anchor, WITHOUT a
 * distance threshold — for geometry measurement (`measureAttachGeometry.ts`), not
 * for actual matching. Reuses `directionalDistance`, so the definition of
 * "below"/"above" is a SINGLE source of truth shared with the actual matching
 * used by `attachNearestInternal`.
 */
export function classifyRelativeDirection(anchor: Rect, candidate: Rect): RelativeDirection {
  if (directionalDistance(anchor, candidate, 'nearestBelow') !== null) return 'below';
  if (directionalDistance(anchor, candidate, 'nearestAbove') !== null) return 'above';
  return 'beside';
}

interface BestPick {
  index: number;
  distance: number;
}

function pickBest(anchor: Rect, candidates: readonly AttachCandidate[], used: ReadonlySet<number>, strategy: AttachStrategy, maxDistancePt: number): BestPick | null {
  let best: BestPick | null = null;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    const dist = directionalDistance(anchor, candidates[i]!.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    if (!best || dist < best.distance) best = { index: i, distance: dist };
  }
  return best;
}

/**
 * [H3, step-13 spike] The name and subtitle stand close together in the same typeface —
 * a naive "nearest" picks the SUBTITLE part, because it lies closer (below/later)
 * to the anchor than the name itself. Prefer the EARLIER (in the stream) sibling at a
 * close vertical distance from `best` — the "Name above Subtitle" assumption.
 */
function preferEarlierSibling(
  anchor: Rect,
  candidates: readonly AttachCandidate[],
  used: ReadonlySet<number>,
  strategy: AttachStrategy,
  maxDistancePt: number,
  best: BestPick,
  config: PreferEarlierSiblingConfig,
): BestPick {
  const bestCandidate = candidates[best.index]!;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i) || i === best.index) continue;
    const candidate = candidates[i]!;
    if (candidate.tokenIndex >= bestCandidate.tokenIndex) continue;
    if (Math.abs(candidate.bbox.minY - bestCandidate.bbox.minY) > config.maxDeltaYPt) continue;
    const dist = directionalDistance(anchor, candidate.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    return { index: i, distance: dist };
  }
  return best;
}

/**
 * [Step 30, bug measured live, NARROWED after a regression] `preferEarlierSibling`
 * excludes a subtitle from ambiguity counting ONLY when it had to
 * actively SWITCH the choice from the subtitle to the name (`chosen.index !== best.index`
 * in `resolveEntityNames`). When the name is ALREADY geometrically nearest (a typical
 * "Name above Subtitle" layout on THE SAME line, the name starts further
 * to the left so it happens to be nearest to the anchor anyway), the switch never
 * occurs, so the subtitle is NEVER excluded — it gets counted as the "second
 * best candidate" and triggers the ambiguity penalty, even though this is EXACTLY the
 * same, expected "Name+Subtitle" pattern. Measured directly on real
 * data (p. 23-24 "Zew Cthulhu 7ed. Wrak.pdf", Step 30 Z5,
 * RAPORT-KROK-30.md): several entities on those pages were all getting a placeholder
 * instead of a confident name for exactly this reason.
 *
 * [Regression, measured live IMMEDIATELY after the first version] The first
 * version excluded EVERY sibling in the same Y band, regardless of
 * X position — this caught a `studioAnalysis.test.ts` test deliberately
 * constructed the opposite way: two INDEPENDENT, COMPETING name candidates
 * ("Candidate A"/"Candidate B") placed AT NEARLY THE SAME spot (the same
 * X, 1pt Y difference) are meant to represent GENUINE ambiguity that the engine
 * IS supposed to detect, and the "widened" exclusion was incorrectly merging them. A genuine name +
 * subtitle do NOT stand at the same spot — they lie ON THE SAME LINE, one AFTER
 * THE OTHER (the subtitle starts where the name ends, X does not overlap): measured directly,
 * a name token ends at X=143.0, and the following occupation-label token starts at X=146.6. Fix: ADDITIONALLY
 * require that a candidate (a) be LATER in the stream than the chosen one (the mirror
 * image of `preferEarlierSibling`'s direction, which looks BACKWARD) and (b) its X NOT
 * overlap the chosen one's X (it starts where the chosen one ends, or further) — this
 * precisely rejects the test's "two candidates at the same spot" case
 * (Candidate B starts at X=1, the chosen "Candidate A" ends at X=8 —
 * overlap), while preserving the fix for the genuine "Name+Subtitle" case.
 */
function findKnownSiblingIndex(
  anchor: Rect,
  candidates: readonly AttachCandidate[],
  used: ReadonlySet<number>,
  strategy: AttachStrategy,
  maxDistancePt: number,
  chosenIndex: number,
  config: PreferEarlierSiblingConfig,
): number | null {
  const chosenCandidate = candidates[chosenIndex]!;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i) || i === chosenIndex) continue;
    const candidate = candidates[i]!;
    if (candidate.tokenIndex <= chosenCandidate.tokenIndex) continue;
    if (candidate.bbox.minX < chosenCandidate.bbox.maxX) continue;
    if (Math.abs(candidate.bbox.minY - chosenCandidate.bbox.minY) > config.maxDeltaYPt) continue;
    const dist = directionalDistance(anchor, candidate.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    return i;
  }
  return null;
}

/**
 * [Step 21, bug measured live] Attaches candidates to anchors as a
 * GLOBAL match with minimal TOTAL distance (greedy over
 * pairs sorted ascending), NOT per-anchor in stream order.
 * The difference matters: p. 55 "Nie czas na krzyk" has 3 characters in a
 * two-column layout, where ONE character's grid can be geometrically CLOSER to the
 * NEIGHBOR's ATTACKS section (due to portrait/image spacing in its OWN column)
 * than to its own ATTACKS section. The "each anchor takes its own
 * nearest, anchors processed in stream order" version led to a
 * swap: the first anchor processed "stole" a neighboring
 * entity's ATTACKS section (because it was geometrically closer to it than its own), and
 * that neighbor got whatever was left — the first entity's own section. Measured
 * directly: both pairs of CONFUSED candidates have a LARGER distance than their
 * TRUE (correct) pairs — globally sorting by smallest distance
 * FIRST assigns the true, tightly-matched pairs (e.g. one entity<->her
 * own ATTACKS, distance ~25pt), before any further/ambiguous candidate
 * (another entity<->someone else's ATTACKS, distance ~120pt) gets a chance at all. For pages
 * WITHOUT ambiguity (typically one character per page) the result is identical to
 * before — each anchor gets its only/nearest candidate anyway,
 * processing order doesn't matter here.
 */
/**
 * [Step 22 Z2/Z3] The candidate nearest to an anchor with no match at all within
 * `maxDistancePt` — "candidate out of range" diagnostics (step-21
 * discovery #6: today this is silent, indistinguishable from "the page genuinely has nothing").
 *
 * [Step 29, bug measured live] The name is MISLEADING — this candidate is OFTEN
 * genuinely outside `maxDistancePt` (`reason: 'tooFar'`), but it ALSO
 * happens (a global, greedy match in `attachNearestInternal`) that it lies
 * WELL within the limit, it's just that another anchor got it first in
 * the sort by smallest distance (`reason: 'claimedByOther'`) —
 * measured directly: p. 23 "Zew Cthulhu 7ed. Wrak.pdf", one entity showed
 * "candidate 87pt, limit 400pt" as "out of range", even though 87 < 400,
 * precisely because its true candidate had been TAKEN by another,
 * geometrically closer anchor (caused by a DIFFERENT bug — a neighbor's section
 * without its own boundary had grown to cover the whole page). `distance`/`maxDistancePt`
 * ALONE don't say which case this is — the UI message must distinguish
 * `reason`, so it doesn't show a nonsensical "87pt > 400pt" (a distance SMALLER
 * than the limit, described as an overrun).
 */
export interface OutOfRangeCandidate {
  distance: number;
  candidate: AttachCandidate;
  reason: 'tooFar' | 'claimedByOther';
}

export interface AttachDiagnostics {
  attached: (AttachCandidate | null)[];
  /** For each anchor WITHOUT a match (`attached[i] === null`): the nearest candidate IGNORING `maxDistancePt`, if any exists in that direction on the page. `null` on a match OR when there are no candidates at all. */
  nearestOutOfRange: (OutOfRangeCandidate | null)[];
}

function attachNearestInternal(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): AttachDiagnostics {
  const allPairs: { anchorIndex: number; candidateIndex: number; distance: number }[] = [];
  for (let ai = 0; ai < anchors.length; ai++) {
    for (let ci = 0; ci < candidates.length; ci++) {
      const dist = directionalDistance(anchors[ai]!.bbox, candidates[ci]!.bbox, strategy);
      if (dist === null) continue;
      allPairs.push({ anchorIndex: ai, candidateIndex: ci, distance: dist });
    }
  }
  const withinLimit = allPairs.filter((p) => p.distance <= maxDistancePt).sort((a, b) => a.distance - b.distance);

  const usedAnchors = new Set<number>();
  const usedCandidates = new Set<number>();
  const attached: (AttachCandidate | null)[] = new Array(anchors.length).fill(null);
  for (const pair of withinLimit) {
    if (usedAnchors.has(pair.anchorIndex) || usedCandidates.has(pair.candidateIndex)) continue;
    usedAnchors.add(pair.anchorIndex);
    usedCandidates.add(pair.candidateIndex);
    attached[pair.anchorIndex] = candidates[pair.candidateIndex]!;
  }

  const nearestOutOfRange: (OutOfRangeCandidate | null)[] = anchors.map((_, ai) => {
    if (attached[ai]) return null;
    let best: { candidateIndex: number; distance: number } | null = null;
    for (const p of allPairs) {
      if (p.anchorIndex !== ai) continue;
      if (!best || p.distance < best.distance) best = { candidateIndex: p.candidateIndex, distance: p.distance };
    }
    if (!best) return null;
    // [Step 29, bug measured live] `best.distance <= maxDistancePt`
    // means this candidate WAS in range, but went to a different anchor in the
    // greedy global match above (otherwise `attached[ai]` would be
    // set) — see the comment at `OutOfRangeCandidate`.
    const reason: OutOfRangeCandidate['reason'] = best.distance > maxDistancePt ? 'tooFar' : 'claimedByOther';
    return { distance: best.distance, candidate: candidates[best.candidateIndex]!, reason };
  });

  return { attached, nearestOutOfRange };
}

export function attachNearest(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): (AttachCandidate | null)[] {
  return attachNearestInternal(anchors, candidates, strategy, maxDistancePt).attached;
}

/** [Step 22 Z2/Z3] Like `attachNearest`, but ALSO returns "candidate out of range" diagnostics — used ONLY by Profile Studio (preview/diagnostics), not by the real import pipeline (which keeps calling `attachNearest` unchanged). The same internal logic as `attachNearest` (`attachNearestInternal`), so the diagnostics can never diverge from the actual matching. */
export function attachNearestWithDiagnostics(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): AttachDiagnostics {
  return attachNearestInternal(anchors, candidates, strategy, maxDistancePt);
}

export interface MergedLabelledPairsAttachment {
  attached: (LabelledPairsMatch | null)[];
  /**
   * [Step 34 Z2, bug measured live] `attached[i].startIndex..endIndex`
   * is the bounding UNION of all attached matches — NOT a contiguous range
   * of tokens, when `attached[i]` was formed by MERGING disjoint matches
   * (e.g. the main derived-stats block, tokens 20-32, PLUS an armor-value pair in its OWN
   * paragraph, tokens 70-72 — the bounding `[20, 72)` also swallows ALL unclaimed
   * prose BETWEEN them). Code that needs "actually consumed
   * tokens" (e.g. `proseBlock`'s exclusions, so a note doesn't duplicate
   * the derived stats, but ALSO doesn't skip over unclaimed prose between
   * merged fragments) MUST iterate OVER THIS list (each entry's OWN,
   * contiguous `[startIndex,endIndex)`), NOT over `attached[i]`'s bounding range.
   */
  subMatches: LabelledPairsMatch[][];
  /** Diagnostics ONLY from the first (nearest) round — as in `attachNearestWithDiagnostics` (Studio). */
  nearestOutOfRange: (OutOfRangeCandidate | null)[];
}

/**
 * [Step 34 Z1, problem measured live, "Wrak.pdf" p. 24, a monster statblock] An
 * armor-value label/pair is sometimes written as its OWN, separate paragraph (a short
 * clause giving the armor value plus a descriptive note) far away (a different line, BELOW the attacks) from the rest of the derived-stats block
 * (the usual HP/MOV/BUILD/Move/MP line, on one line EARLIER on the page, right after
 * the attribute grid) — `matchLabelledPairs` returns this as TWO DISJOINT
 * matches of THE SAME pattern (each on its own satisfies `minPairs: 1`),
 * and a plain `attachNearest` (bipartite, ONE candidate per anchor) assigns to
 * the anchor ONLY the closer of the two — the second one (the armor pair) was being
 * COMPLETELY dropped, even though there was exactly ONE entity on the page it could
 * have belonged to (measured directly: `armour` did not appear AT ALL in
 * `CIFActor.statistics`, not merely truncated). Generalization (step 34's DoD:
 * "the same applies to every derived stat with a description, not just armor") — EVERY
 * `labelledPairs` pattern attached to an anchor CAN return more than one
 * match per page.
 *
 * Works in rounds: the first round is EXACTLY `attachNearest` (the same
 * safe bipartite algorithm as the rest of the engine) — on pages with EXACTLY
 * one match per anchor (all reference profiles so
 * far), the result is IDENTICAL to before this function, zero regressions.
 * Matches not claimed in the first round ("orphans") try to
 * attach in SUBSEQUENT rounds to the NEAREST STILL available anchor —
 * the SAME bipartite algorithm, so two anchors on a page never
 * bid against each other for THE SAME orphaned match (the closer one wins), and a candidate
 * beyond `maxDistancePt` of EVERY anchor is rejected just as before (A10 —
 * no match is still a valid result, not a guess). Pairs from each
 * extra match are ADDED (a union by `canonicalKey`, the first
 * — nearest — match wins on conflict) to the first round's
 * result, never replacing it.
 */
/**
 * [user report, repeated live three times, "Wrak.pdf", a monster statblock]
 * A range multiplier ONLY for the rounds attaching ORPHANED matches
 * (below), NOT for the first/main round. Measured directly: the true
 * distance to that entity's orphaned armor-value pair is 410.85pt — the profile author
 * (Profile Studio, the default value of a new attach rule) sets
 * `maxDistancePt` to 400pt, so the match was falling out as "out of range"
 * (armour never made it onto the sheet), DESPITE there being exactly
 * one anchor on the page this orphaned fragment could have belonged to. Previously
 * fixed manually IN THE PROFILE ITSELF (raising `maxDistancePt` to 450) —
 * but every rebuild of the profile in Profile Studio (a new attach rule)
 * resets to the default value of 400, so the same bug kept coming back on EVERY
 * subsequent edit. Fixing it in the ENGINE instead of the profile data: orphan
 * rounds by nature catch content DELIBERATELY placed far from the main block
 * (a separate paragraph), so they deserve a larger range than the first round —
 * without risking false matches in the first round (which is NOT covered by this
 * multiplier), because a candidate for this round must already be
 * "orphaned" (rejected by ALL anchors in the first round) anyway.
 */
const ORPHAN_ROUND_DISTANCE_MULTIPLIER = 1.5;

export function attachAndMergeLabelledPairs(
  anchors: readonly GeometricAnchor[],
  matches: readonly LabelledPairsMatch[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): MergedLabelledPairsAttachment {
  const toCandidate = (m: LabelledPairsMatch): AttachCandidate => ({ bbox: m.bbox, tokenIndex: m.startIndex });
  const primaryDiag = attachNearestInternal(anchors, matches.map(toCandidate), strategy, maxDistancePt);

  const byAnchor: LabelledPairsMatch[][] = anchors.map(() => []);
  const usedMatchIndices = new Set<number>();
  primaryDiag.attached.forEach((cand, ai) => {
    if (!cand) return;
    const idx = matches.findIndex((m) => m.startIndex === cand.tokenIndex);
    byAnchor[ai]!.push(matches[idx]!);
    usedMatchIndices.add(idx);
  });

  const orphanRoundMaxDistancePt = maxDistancePt * ORPHAN_ROUND_DISTANCE_MULTIPLIER;
  let leftoverIndices = matches.map((_, idx) => idx).filter((idx) => !usedMatchIndices.has(idx));
  while (leftoverIndices.length > 0) {
    const roundCandidates = leftoverIndices.map((idx) => toCandidate(matches[idx]!));
    const roundDiag = attachNearestInternal(anchors, roundCandidates, strategy, orphanRoundMaxDistancePt);
    let attachedAny = false;
    roundDiag.attached.forEach((cand, ai) => {
      if (!cand) return;
      const idx = leftoverIndices.find((li) => matches[li]!.startIndex === cand.tokenIndex)!;
      byAnchor[ai]!.push(matches[idx]!);
      usedMatchIndices.add(idx);
      attachedAny = true;
    });
    if (!attachedAny) break;
    leftoverIndices = leftoverIndices.filter((idx) => !usedMatchIndices.has(idx));
  }

  const attached: (LabelledPairsMatch | null)[] = byAnchor.map((list) => {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0]!;
    const seenKeys = new Set(list[0]!.pairs.map((p) => p.canonicalKey));
    const pairs = [...list[0]!.pairs];
    for (const extra of list.slice(1)) {
      for (const p of extra.pairs) {
        if (seenKeys.has(p.canonicalKey)) continue;
        seenKeys.add(p.canonicalKey);
        pairs.push(p);
      }
    }
    const bbox = list.reduce<Rect | null>((acc, m) => (acc ? unionRect(acc, m.bbox) : m.bbox), null)!;
    return {
      pairs,
      startIndex: Math.min(...list.map((m) => m.startIndex)),
      endIndex: Math.max(...list.map((m) => m.endIndex)),
      bbox,
    };
  });

  return { attached, subMatches: byAnchor, nearestOutOfRange: primaryDiag.nearestOutOfRange };
}

export interface NameCandidate extends AttachCandidate {
  text: string;
}

export type NameResolution =
  | { kind: 'confident'; text: string; confidence: number; tokenIndex: number }
  | { kind: 'placeholder'; placeholder: string; candidates: readonly string[] };

export interface ResolveEntityNamesConfig {
  strategy: AttachStrategy;
  maxDistancePt: number;
  preferEarlierSibling?: PreferEarlierSiblingConfig;
  nameConfidenceThreshold: number;
  /** Inserted in place of `{page}`/`{ordinal}` in `namePlaceholder`. */
  page: number;
  namePlaceholder: string;
  /**
   * [reported after step 30, "Why do I have to point it out manually when the
   * profile already contains this"] `tokenIndex`es of tokens recognized by the entity's OWN,
   * SEPARATE occupation/type pattern (`entityAssembly.typeLabelPattern`) —
   * REGARDLESS of whether the author has already narrowed it with `requireFontKeys`.
   * The author has ALREADY TOLD the profile "this is an occupation/type, not the name" by the
   * mere fact of pointing to a separate pattern — the engine shouldn't therefore ask
   * a human to resolve the choice between these two fields AGAIN (the ambiguity
   * penalty below), since the answer is already in the profile's configuration. Without this:
   * as long as the two patterns' `requireFontKeys` aren't explicitly different (the author hasn't
   * clicked enough examples yet), an occupation/type candidate still counts as
   * "an almost-as-close competitor" of the name, so `resolveEntityNames`
   * falsely penalizes confidence and the entity ends up in the review as a placeholder with
   * two candidates for MANUAL resolution — even though the profile ALREADY has
   * enough information to resolve it automatically.
   */
  knownSiblingTokenIndices?: ReadonlySet<number>;
}

/**
 * [S4] Below `nameConfidenceThreshold`, NEVER guess — a placeholder +
 * a list of candidates (sorted by distance) to resolve in the
 * review. Confidence = f(distance of the best candidate RELATIVE TO the threshold) WITH
 * a PENALTY for ambiguity (a second candidate almost as close as the first —
 * exactly the H3 "50% accuracy" case, where two short texts in the same
 * typeface stand close together). The formula is NOT CALIBRATED on a real
 * book — that's Z7's task (measurement across the whole book); here it is explicitly
 * documented and testable, not hardcoded without explanation.
 */
const AMBIGUITY_RATIO_THRESHOLD = 1.5;
const AMBIGUITY_CONFIDENCE_PENALTY = 0.5;

export function resolveEntityNames(anchors: readonly GeometricAnchor[], nameCandidates: readonly NameCandidate[], config: ResolveEntityNamesConfig): NameResolution[] {
  const used = new Set<number>();
  const order = anchors.map((_, i) => i).sort((a, b) => anchors[a]!.anchorTokenIndex - anchors[b]!.anchorTokenIndex);
  const result: NameResolution[] = new Array(anchors.length).fill(null) as NameResolution[];

  for (const ai of order) {
    const anchor = anchors[ai]!;
    const best = pickBest(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt);
    const placeholder = config.namePlaceholder.replace('{page}', String(config.page)).replace('{ordinal}', String(ai + 1));

    if (!best) {
      result[ai] = { kind: 'placeholder', placeholder, candidates: [] };
      continue;
    }

    const chosen = config.preferEarlierSibling
      ? preferEarlierSibling(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt, best, config.preferEarlierSibling)
      : best;

    // The second-best candidate (besides the chosen one) — an ambiguity signal. When
    // `preferEarlierSibling` switched the choice from `best` (geometrically
    // nearest) to an earlier sibling (name instead of subtitle),
    // `best` is an UNDERSTANDABLE, expected "competitor" (it IS the subtitle,
    // which would be nearest) — NOT genuine ambiguity. Exclude it from
    // the ambiguity count, otherwise every correct application of the
    // "name above subtitle" rule would be falsely penalized as uncertain.
    const ambiguityExclusions = new Set([...used, chosen.index]);
    if (chosen.index !== best.index) ambiguityExclusions.add(best.index);
    // [Step 30] The symmetric case: `chosen` is ALREADY the nearest (`best`),
    // so the exclusion above never triggers, even though the subtitle
    // still stands on the same line and is still the "expected competitor",
    // not genuine ambiguity — see the comment at `findKnownSiblingIndex`.
    if (config.preferEarlierSibling) {
      const sibling = findKnownSiblingIndex(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt, chosen.index, config.preferEarlierSibling);
      if (sibling !== null) ambiguityExclusions.add(sibling);
    }
    // [reported after step 30] A candidate recognized by its OWN
    // occupation/type pattern already has an "innocent explanation" — the profile has already classified it
    // as a DIFFERENT field, so it doesn't count as genuine name ambiguity,
    // regardless of geometry/`preferEarlierSibling`.
    if (config.knownSiblingTokenIndices) {
      nameCandidates.forEach((c, i) => {
        if (config.knownSiblingTokenIndices!.has(c.tokenIndex)) ambiguityExclusions.add(i);
      });
    }
    const secondBest = pickBest(anchor.bbox, nameCandidates, ambiguityExclusions, config.strategy, config.maxDistancePt);

    let confidence = Math.max(0, 1 - chosen.distance / config.maxDistancePt);
    if (secondBest && secondBest.distance <= chosen.distance * AMBIGUITY_RATIO_THRESHOLD) {
      confidence *= AMBIGUITY_CONFIDENCE_PENALTY;
    }

    used.add(chosen.index);

    if (confidence < config.nameConfidenceThreshold) {
      const candidateTexts = [chosen, ...(secondBest ? [secondBest] : [])].map((c) => (nameCandidates[c.index] as NameCandidate).text);
      result[ai] = { kind: 'placeholder', placeholder, candidates: candidateTexts };
    } else {
      // [Step 22, found while building Profile Studio] `chosen.index` is an index
      // WITHIN the `nameCandidates` array (a candidate's position in this
      // function's argument), NOT the true token index in the stream — these two numbers were
      // confused here, UNNOTICED until now, because `NameResolution.tokenIndex` had
      // no consumer in the product (`buildCIFActor.ts` only ever reads `.text`).
      // Profile Studio is the FIRST piece of code that actually uses this field (to
      // draw the name overlay over the correct token) — without this fix
      // it would point to a random, arbitrary token in the stream.
      const chosenCandidate = nameCandidates[chosen.index] as NameCandidate;
      result[ai] = { kind: 'confident', text: chosenCandidate.text, confidence, tokenIndex: chosenCandidate.tokenIndex };
    }
  }

  return result;
}
