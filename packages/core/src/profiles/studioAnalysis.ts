import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { ProfileV2 } from './schema.js';
import type { PageRoute } from './pageRoute.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { matchFontRoleCandidate, type FontRoleCandidateMatch } from './entityName.js';
import { findAttackDescriptionClaimedRanges } from './attackDescriptionCrossReference.js';
import { lastClaimedTokenIndex, matchProseBlock } from './proseBlock.js';
import {
  attachAndMergeLabelledPairs,
  attachNearest,
  attachNearestWithDiagnostics,
  resolveEntityNames,
  type AttachCandidate,
  type GeometricAnchor,
  type NameCandidate,
  type NameResolution,
  type OutOfRangeCandidate,
} from './entityAssembly.js';
import { resolvePatternSetForRoute, sectionListToAttachCandidates } from './assembleStatblocks.js';

/**
 * [Step 22 Z1-Z3] Diagnostic analysis of a profile on a page — the engine
 * behind Profile Studio (the "profile tester"). DELIBERATELY SEPARATE from
 * `assembleStatblocksOnPage` (the product), NOT a replacement for it: this function uses
 * EXACTLY the same matching primitives (`matchLabelledPairs`/`matchSectionList`/
 * `matchFontRoleCandidate`/`attachNearestWithDiagnostics`/`resolveEntityNames`)
 * so matching SEMANTICS itself is a SINGLE source of truth (zero risk of
 * divergence) — but it additionally collects diagnostics (what got REJECTED, where
 * two entities overlap, how many times each pattern matched anything at all),
 * which the real pipeline (used for the actual import) never computes,
 * because it doesn't need it. The rule selection (which `attach` is derived/attacks/
 * skills/name) DUPLICATES `assembleStatblocksOnPage`'s logic — the only part
 * that is NOT shared (see the comment at each rule below).
 */

export interface AttachDiagnosticResult<TMatch> {
  match: TMatch | null;
  /** The measured distance to the matched candidate (`match !== null`). */
  distance: number | null;
  /**
   * [step-21 discovery #6] Present ONLY when `match === null`, but some
   * candidate existed on the page — shows the profile author EXACTLY how much
   * the limit would need to be loosened (`reason: 'tooFar'`), OR that a candidate
   * was in range but was taken by another anchor (`reason: 'claimedByOther'`,
   * Step 29 — see `OutOfRangeCandidate` in `entityAssembly.ts`).
   */
  outOfRange: { distance: number; maxDistancePt: number; reason: OutOfRangeCandidate['reason'] } | null;
}

export type StudioRegionKind = 'grid' | 'derived' | 'attacks' | 'skills' | 'name' | 'typeLabel' | 'notes';

export interface StudioRegion {
  kind: StudioRegionKind;
  bbox: Rect;
}

export interface EntityAnalysis {
  ordinal: number;
  grid: LabelledPairsMatch;
  name: NameResolution;
  derived: AttachDiagnosticResult<LabelledPairsMatch>;
  attacks: AttachDiagnosticResult<SectionListMatch>;
  skills: AttachDiagnosticResult<SectionListMatch>;
  /** [reported after step 30] A free-form occupation/type label, its own, independent `fontRoleCandidate` pattern — see `entityAssembly.typeLabelPattern`. */
  typeLabel: AttachDiagnosticResult<FontRoleCandidateMatch>;
  /** [Step 34 Z2] Prose blocks attached geometrically — see `AssembledStatblock.notes` (`assembleStatblocks.ts`), THE SAME logic. */
  notes: { label: string; text: string }[];
  /** All bboxes "claimed" by this entity — input to overlap detection (`overlaps`) and to drawing overlays. */
  regions: StudioRegion[];
}

export interface OverlapWarning {
  entityOrdinalA: number;
  entityOrdinalB: number;
  regionKindA: StudioRegionKind;
  regionKindB: StudioRegionKind;
  intersection: Rect;
}

export type NameCandidateStatus = 'selected' | 'suggested' | 'other';

export interface NameCandidateDiagnostic {
  text: string;
  bbox: Rect;
  tokenIndex: number;
  status: NameCandidateStatus;
  /** The ordinal of the entity this candidate belongs to (chosen OR suggested) — `null` for `status: 'other'`. */
  entityOrdinal: number | null;
}

export interface PatternMatchCount {
  patternId: string;
  /** Number of OCCURRENCES of the pattern on the page (section headers / grids / name candidates) — INDEPENDENT of whether anything was actually attached to any entity. Zero across the WHOLE document usually means a typo in the regex (step-22 brief). */
  matchCount: number;
}

export interface PageAnalysis {
  page: number;
  /** [Step 39 Z1] The route CLASSIFIED for this page (`classifyPageRoute`, `pageRoute.ts`) — replaces the former `isPregen: boolean` (which ALWAYS meant "playerCharacter route, so skip it"; since step 39 this route CAN be supported, see `routeSupported`). */
  route: PageRoute;
  /** [Step 39 Z1] Whether the profile has a pattern set for `route` (`resolvePatternSetForRoute`) — `false` = page skipped (`entities: []`), like the former `isPregen: true`, but now with an explicit reason instead of the default assumption "every playerCharacter page is skipped". For the `npc` route ALWAYS `true` (the profile's root always has patterns). */
  routeSupported: boolean;
  entities: EntityAnalysis[];
  nameCandidates: NameCandidateDiagnostic[];
  overlaps: OverlapWarning[];
  patternMatchCounts: PatternMatchCount[];
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  if (minX >= maxX || minY >= maxY) return null;
  return { minX, maxX, minY, maxY };
}

function sectionListMatchBbox(match: SectionListMatch, tokens: readonly ProfileToken[]): Rect {
  if (match.items.length > 0) {
    return match.items.map((it) => it.bbox).reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
  }
  return tokens[match.headerTokenIndex]!.bbox;
}

function classifyNameCandidates(nameMatches: readonly FontRoleCandidateMatch[], names: readonly NameResolution[]): NameCandidateDiagnostic[] {
  const selectedByTokenIndex = new Map<number, number>();
  const suggestedByText = new Map<string, number>();
  names.forEach((n, ordinal) => {
    if (n.kind === 'confident') selectedByTokenIndex.set(n.tokenIndex, ordinal);
    else for (const t of n.candidates) if (!suggestedByText.has(t)) suggestedByText.set(t, ordinal);
  });
  return nameMatches.map((m) => {
    const selectedOrdinal = selectedByTokenIndex.get(m.tokenIndex);
    if (selectedOrdinal !== undefined) return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'selected' as const, entityOrdinal: selectedOrdinal };
    const suggestedOrdinal = suggestedByText.get(m.text);
    if (suggestedOrdinal !== undefined) return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'suggested' as const, entityOrdinal: suggestedOrdinal };
    return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'other' as const, entityOrdinal: null };
  });
}

function detectOverlaps(entities: readonly EntityAnalysis[]): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      for (const regionA of entities[i]!.regions) {
        for (const regionB of entities[j]!.regions) {
          const intersection = intersectRect(regionA.bbox, regionB.bbox);
          if (!intersection) continue;
          warnings.push({
            entityOrdinalA: entities[i]!.ordinal,
            entityOrdinalB: entities[j]!.ordinal,
            regionKindA: regionA.kind,
            regionKindB: regionB.kind,
            intersection,
          });
        }
      }
    }
  }
  return warnings;
}

/**
 * Analysis of ONE page. The caller supplies tokens of THAT page (like
 * `assembleStatblocksOnPage`) — route classification (`classifyPageRoute`,
 * `pageRoute.ts`) is a SEPARATE, EARLIER step, this file does NOT call it itself
 * (the caller — `analyzeProfileDocument` — decides and passes `route`).
 *
 * [Step 39 Z1] `route` replaces the former `isPregen: boolean` — when a profile
 * has no pattern set for this route (`resolvePatternSetForRoute` returns
 * `null`, e.g. the `playerCharacter` route without a `profile.playerCharacter` section),
 * the page is skipped THE SAME WAY as the former `isPregen: true` (`entities: []`),
 * but the result now CARRIES an explicit reason (`routeSupported: false`) instead of
 * the silent assumption "every page of this route is skipped".
 */
export function analyzeProfilePage(tokens: readonly ProfileToken[], profile: ProfileV2, page: number, route: PageRoute): PageAnalysis {
  const patternSet = resolvePatternSetForRoute(profile, route);
  if (!patternSet) {
    return { page, route, routeSupported: false, entities: [], nameCandidates: [], overlaps: [], patternMatchCounts: [] };
  }

  const anchorPatternId = patternSet.entityAssembly.anchor;
  const anchorPattern = patternSet.patterns[anchorPatternId];
  if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
    throw new Error(`analyzeProfilePage: anchor "${anchorPatternId}" must be a labelledPairs pattern, but is "${anchorPattern?.kind ?? 'missing'}"`);
  }
  const grids = matchLabelledPairs(tokens, anchorPattern);
  const anchors: GeometricAnchor[] = grids.map((g) => ({ bbox: g.bbox, anchorTokenIndex: g.startIndex }));

  // [Rule selection — DUPLICATES `assembleStatblocksOnPage`, see the file header]
  const derivedRule = patternSet.entityAssembly.attach.find((r) => {
    const p = patternSet.patterns[r.pattern];
    return p?.kind === 'labelledPairs' && r.pattern !== anchorPatternId;
  });
  const skillsPatternId = patternSet.entityAssembly.skillsPattern;
  const attackRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'sectionList' && r.pattern !== skillsPatternId);
  const skillsRule = skillsPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === skillsPatternId) : undefined;
  // [reported after step 30] `typeLabelPattern` excluded from the candidates for "this
  // fontRoleCandidate is the name" — see the identical comment in `assembleStatblocks.ts`.
  const typeLabelPatternId = patternSet.entityAssembly.typeLabelPattern;
  const nameRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'fontRoleCandidate' && r.pattern !== typeLabelPatternId);
  const typeLabelRule = typeLabelPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === typeLabelPatternId) : undefined;

  // [Step 34 Z1] `attachAndMergeLabelledPairs`, not `attachNearestWithDiagnostics`
  // — see the identical comment in `assembleStatblocks.ts` and the definition in
  // `entityAssembly.ts`: lets Studio show the SAME merged match
  // (a stat label in its own paragraph + the rest of the derived stats) that the real pipeline
  // now also computes — a single source of truth, per this file's header.
  let derivedDiag: { attached: (LabelledPairsMatch | null)[]; subMatches: LabelledPairsMatch[][]; nearestOutOfRange: (OutOfRangeCandidate | null)[] } = {
    attached: anchors.map(() => null),
    subMatches: anchors.map(() => []),
    nearestOutOfRange: anchors.map(() => null),
  };
  let derivedMaxDist = 0;
  if (derivedRule) {
    const pattern = patternSet.patterns[derivedRule.pattern];
    if (pattern?.kind === 'labelledPairs') {
      const derivedMatches = matchLabelledPairs(tokens, pattern);
      derivedDiag = attachAndMergeLabelledPairs(anchors, derivedMatches, derivedRule.strategy, derivedRule.maxDistancePt);
      derivedMaxDist = derivedRule.maxDistancePt;
    }
  }

  // [reported after step 30, "Why do I have to point it out manually when the
  // profile already contains this" — see the identical comment in `assembleStatblocks.ts`]
  // Raw matches of the occupation/type pattern computed BEFORE resolving the name,
  // so their `tokenIndex` can feed into `resolveEntityNames` as
  // `knownSiblingTokenIndices`.
  let typeLabelPattern = typeLabelRule ? patternSet.patterns[typeLabelRule.pattern] : undefined;
  if (typeLabelPattern?.kind !== 'fontRoleCandidate') typeLabelPattern = undefined;
  const typeLabelMatches: FontRoleCandidateMatch[] = typeLabelPattern ? matchFontRoleCandidate(tokens, typeLabelPattern) : [];
  const typeLabelMatchTokenIndices = new Set(typeLabelMatches.map((m) => m.tokenIndex));

  // [Step 24 Z4b] The name is resolved BEFORE the ATTACKS/Skills sections — see
  // the identical comment in `assembleStatblocksOnPage` (`assembleStatblocks.ts`),
  // the SAME reason (p. 56, two field labels sitting close together).
  let names: NameResolution[] = anchors.map((_, i) => ({
    kind: 'placeholder',
    placeholder: patternSet.entityAssembly.namePlaceholder.replace('{page}', String(page)).replace('{ordinal}', String(i + 1)),
    candidates: [],
  }));
  let nameMatches: FontRoleCandidateMatch[] = [];
  // [reported after step 30, bug measured live — see the identical
  // comment in `assembleStatblocks.ts`] The token(s) that name matching
  // would consider the "nearest candidate" for ANY anchor, computed
  // INDEPENDENTLY of the confidence threshold — a placeholder due to ambiguity
  // (S4) STILL "occupies" this token geometrically, just not confidently enough to
  // show it as `name`. Used below at `typeLabel`.
  let nameClaimedTokenIndices = new Set<number>();
  if (nameRule) {
    const pattern = patternSet.patterns[nameRule.pattern];
    if (pattern?.kind === 'fontRoleCandidate') {
      nameMatches = matchFontRoleCandidate(tokens, pattern);
      const nameCandidates: NameCandidate[] = nameMatches.map((m) => ({ text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex }));
      names = resolveEntityNames(anchors, nameCandidates, {
        strategy: nameRule.strategy,
        maxDistancePt: nameRule.maxDistancePt,
        preferEarlierSibling: nameRule.preferEarlierSibling,
        nameConfidenceThreshold: patternSet.entityAssembly.nameConfidenceThreshold,
        page,
        namePlaceholder: patternSet.entityAssembly.namePlaceholder,
        knownSiblingTokenIndices: typeLabelMatchTokenIndices,
      });
      nameClaimedTokenIndices = new Set(
        attachNearest(anchors, nameCandidates, nameRule.strategy, nameRule.maxDistancePt)
          .filter((c): c is AttachCandidate => c !== null)
          .map((c) => c.tokenIndex),
      );
    }
  }

  // [Step 20 Z2, extended in Step 24 Z4b, Step 34 Z2 — see the identical
  // comment in `assembleStatblocks.ts`] `confidentNameTokenIndices` (Step 24
  // Z4b, any role) PLUS (not instead) raw candidates with the `heading` role
  // (Step 34 Z2 — NOT the whole unfiltered `nameMatches`, `accent` is sometimes noise
  // INSIDE an ordinary skills list, see `assembleStatblocks.ts`) — a token
  // that looks like a GENUINE title/heading is a boundary even when it has no
  // own grid ON THIS page (e.g. an announcement of the next monster at the end of the
  // page).
  const anchorStartIndices = grids.map((g) => g.startIndex);
  const confidentNameTokenIndices = names.filter((n): n is Extract<NameResolution, { kind: 'confident' }> => n.kind === 'confident').map((n) => n.tokenIndex);
  const headingNameTokenIndices = nameMatches.filter((m) => tokens[m.tokenIndex]?.fontRole === 'heading').map((m) => m.tokenIndex);
  const hardStopTokenIndices = [...anchorStartIndices, ...confidentNameTokenIndices, ...headingNameTokenIndices];

  let attackMatches: SectionListMatch[] = [];
  let attackDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let attackMaxDist = 0;
  if (attackRule) {
    const pattern = patternSet.patterns[attackRule.pattern];
    if (pattern?.kind === 'sectionList') {
      attackMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      attackDiag = attachNearestWithDiagnostics(anchors, sectionListToAttachCandidates(attackMatches, tokens), attackRule.strategy, attackRule.maxDistancePt);
      attackMaxDist = attackRule.maxDistancePt;
    }
  }

  let skillsMatches: SectionListMatch[] = [];
  let skillsDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let skillsMaxDist = 0;
  if (skillsRule) {
    const pattern = patternSet.patterns[skillsRule.pattern];
    if (pattern?.kind === 'sectionList') {
      skillsMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      skillsDiag = attachNearestWithDiagnostics(anchors, sectionListToAttachCandidates(skillsMatches, tokens), skillsRule.strategy, skillsRule.maxDistancePt);
      skillsMaxDist = skillsRule.maxDistancePt;
    }
  }

  // [reported after step 30, bug measured live — see the identical
  // comment in `assembleStatblocks.ts`] EVERY token that name matching
  // would consider its best candidate for ANY anchor
  // (`nameClaimedTokenIndices` — NOT just `confident`, since a placeholder due
  // to ambiguity would bypass the exclusion) is excluded from the pool of
  // occupation/type candidates — without this, when `requireFontKeys` of both patterns
  // (name/occupation) hasn't yet been narrowed, `typeLabel` would come out identical to
  // `name` (the same, geometrically nearest token chosen INDEPENDENTLY by
  // both calls).
  let typeLabelDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let typeLabelMaxDist = 0;
  if (typeLabelPattern && typeLabelRule) {
    const typeLabelCandidates: AttachCandidate[] = typeLabelMatches
      .filter((m) => !nameClaimedTokenIndices.has(m.tokenIndex))
      .map((m) => ({ bbox: m.bbox, tokenIndex: m.tokenIndex }));
    typeLabelDiag = attachNearestWithDiagnostics(anchors, typeLabelCandidates, typeLabelRule.strategy, typeLabelRule.maxDistancePt);
    typeLabelMaxDist = typeLabelRule.maxDistancePt;
  }

  // [Step 34 Z2] See the identical comment in `assembleStatblocks.ts`.
  const claimedTokenIndices = new Set<number>();
  for (const g of grids) for (let t = g.startIndex; t < g.endIndex; t++) claimedTokenIndices.add(t);
  // [Step 34 Z2] See the identical comment in `assembleStatblocks.ts` —
  // `subMatches` (each entry's OWN contiguous range), NOT the bounding `attached[i]`.
  for (const subs of derivedDiag.subMatches) for (const d of subs) for (let t = d.startIndex; t < d.endIndex; t++) claimedTokenIndices.add(t);
  // [Step 34 Z2] See the identical comment in `assembleStatblocks.ts` — only
  // `items` (INCLUSIVE), NOT the whole `[headerTokenIndex, endIndex)`.
  for (const a of attackMatches) {
    claimedTokenIndices.add(a.headerTokenIndex);
    for (const item of a.items) for (let t = item.startTokenIndex; t <= item.endTokenIndex; t++) claimedTokenIndices.add(t);
    for (const r of findAttackDescriptionClaimedRanges(tokens, a, hardStopTokenIndices)) for (let t = r.start; t < r.end; t++) claimedTokenIndices.add(t);
  }
  for (const s of skillsMatches) {
    claimedTokenIndices.add(s.headerTokenIndex);
    for (const item of s.items) for (let t = item.startTokenIndex; t <= item.endTokenIndex; t++) claimedTokenIndices.add(t);
  }
  for (const n of names) if (n.kind === 'confident') claimedTokenIndices.add(n.tokenIndex);
  // [Step 34 Z2] See the identical comment in `assembleStatblocks.ts` — only
  // ACTUALLY attached (`typeLabelDiag.attached`), not the whole raw pool.
  for (const c of typeLabelDiag.attached) if (c) claimedTokenIndices.add(c.tokenIndex);
  const notesPatternIds = patternSet.entityAssembly.notesPatterns ?? [];
  const notesPatterns = notesPatternIds.map((id) => patternSet.patterns[id]).filter((p): p is Extract<typeof p, { kind: 'proseBlock' }> => p?.kind === 'proseBlock');

  const entities: EntityAnalysis[] = grids.map((grid, i) => {
    const derivedMatch = derivedDiag.attached[i] ?? null;
    const derived: AttachDiagnosticResult<LabelledPairsMatch> = derivedMatch
      ? { match: derivedMatch, distance: rectGapDistance(grid.bbox, derivedMatch.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(derivedDiag.nearestOutOfRange[i] ?? null, derivedMaxDist) };

    const attackAttached = attackDiag.attached[i] ?? null;
    const attackMatch = attackAttached ? (attackMatches.find((m) => m.headerTokenIndex === attackAttached.tokenIndex) ?? null) : null;
    const attacks: AttachDiagnosticResult<SectionListMatch> = attackMatch
      ? { match: attackMatch, distance: rectGapDistance(grid.bbox, tokens[attackMatch.headerTokenIndex]!.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(attackDiag.nearestOutOfRange[i] ?? null, attackMaxDist) };

    const skillsAttached = skillsDiag.attached[i] ?? null;
    const skillsMatch = skillsAttached ? (skillsMatches.find((m) => m.headerTokenIndex === skillsAttached.tokenIndex) ?? null) : null;
    const skills: AttachDiagnosticResult<SectionListMatch> = skillsMatch
      ? { match: skillsMatch, distance: rectGapDistance(grid.bbox, tokens[skillsMatch.headerTokenIndex]!.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(skillsDiag.nearestOutOfRange[i] ?? null, skillsMaxDist) };

    const typeLabelAttached = typeLabelDiag.attached[i] ?? null;
    const typeLabelMatch = typeLabelAttached ? (typeLabelMatches.find((m) => m.tokenIndex === typeLabelAttached.tokenIndex) ?? null) : null;
    const typeLabel: AttachDiagnosticResult<FontRoleCandidateMatch> = typeLabelMatch
      ? { match: typeLabelMatch, distance: rectGapDistance(grid.bbox, typeLabelMatch.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(typeLabelDiag.nearestOutOfRange[i] ?? null, typeLabelMaxDist) };

    const name = names[i]!;
    const notes: { label: string; text: string }[] = [];
    const noteRegionBboxes: Rect[] = [];
    const referenceTokenIndex = notesPatterns.length > 0 ? lastClaimedTokenIndex(tokens, { grid, derived: derivedMatch, attacks: attackMatch, skills: skillsMatch }, hardStopTokenIndices) : null;
    const referenceBbox = referenceTokenIndex !== null ? tokens[referenceTokenIndex]!.bbox : grid.bbox;
    // [Step 34 Z2, bug measured live — see the identical comment in
    // `assembleStatblocks.ts`] A private copy per entity, extended by the
    // range of EVERY match BEFORE trying the next pattern in the same
    // list — without this, two note-section labels sitting close together on the
    // page (e.g. two distinct prose sections back-to-back) can return IDENTICAL content.
    const claimedForNotes = new Set(claimedTokenIndices);
    const ownNameText = name.kind === 'confident' ? name.text : undefined;
    for (const notePattern of notesPatterns) {
      const match = matchProseBlock(tokens, notePattern, referenceBbox, {
        hardStopTokenIndices,
        excludedTokenIndices: claimedForNotes,
        referenceTokenIndex: referenceTokenIndex ?? undefined,
        ownNameText,
      });
      if (match) {
        notes.push({ label: match.label, text: match.text });
        noteRegionBboxes.push(match.bbox);
        for (let t = match.startIndex; t < match.endIndex; t++) claimedForNotes.add(t);
      }
    }

    const regions: StudioRegion[] = [{ kind: 'grid', bbox: grid.bbox }];
    if (derived.match) regions.push({ kind: 'derived', bbox: derived.match.bbox });
    if (attacks.match) regions.push({ kind: 'attacks', bbox: sectionListMatchBbox(attacks.match, tokens) });
    if (skills.match) regions.push({ kind: 'skills', bbox: sectionListMatchBbox(skills.match, tokens) });
    if (name.kind === 'confident') regions.push({ kind: 'name', bbox: tokens[name.tokenIndex]!.bbox });
    if (typeLabel.match) regions.push({ kind: 'typeLabel', bbox: typeLabel.match.bbox });
    for (const bbox of noteRegionBboxes) regions.push({ kind: 'notes', bbox });

    return { ordinal: i, grid, name, derived, attacks, skills, typeLabel, notes, regions };
  });

  const patternMatchCounts: PatternMatchCount[] = Object.entries(patternSet.patterns).map(([patternId, pattern]) => {
    if (pattern.kind === 'labelledPairs') return { patternId, matchCount: matchLabelledPairs(tokens, pattern).length };
    if (pattern.kind === 'sectionList') return { patternId, matchCount: matchSectionList(tokens, pattern).length };
    // [Step 34 Z2] `proseBlock` doesn't scan the page textually (the match is
    // RELATIVE TO an anchor, not a regex) — "0 hits across the whole book = a typo in
    // the regex" (this diagnostic's purpose, see `PatternMatchCount`) doesn't
    // apply here; entities[].notes below already shows the real result per entity.
    if (pattern.kind === 'proseBlock') return { patternId, matchCount: 0 };
    return { patternId, matchCount: matchFontRoleCandidate(tokens, pattern).length };
  });

  return {
    page,
    route,
    routeSupported: true,
    entities,
    nameCandidates: classifyNameCandidates(nameMatches, names),
    overlaps: detectOverlaps(entities),
    patternMatchCounts,
  };
}


function toOutOfRange(entry: OutOfRangeCandidate | null, maxDistancePt: number): { distance: number; maxDistancePt: number; reason: OutOfRangeCandidate['reason'] } | null {
  return entry ? { distance: entry.distance, maxDistancePt, reason: entry.reason } : null;
}

export interface DocumentPageSummary {
  page: number;
  /** [Step 39 Z1] See `PageAnalysis.route`/`.routeSupported` — replaces the former `isPregen: boolean`. */
  route: PageRoute;
  routeSupported: boolean;
  entityCount: number;
  fullCount: number;
  warningCount: number;
  placeholderNameCount: number;
}

export interface DocumentAnalysis {
  pageCount: number;
  pages: PageAnalysis[];
  /** Match-count breakdown per pattern, SUMMED across the whole document — a pattern with `matchCount: 0` usually means a typo in the regex (step-22 brief). */
  patternMatchTotals: PatternMatchCount[];
  totalEntities: number;
  totalWarnings: number;
  totalPlaceholderNames: number;
  pageSummaries: DocumentPageSummary[];
}

/** [Step 22 Z4] Aggregates `PageAnalysis[]` (already computed by `analyzeProfileDocument`) into a whole-document summary — a PURE function, zero pdf.js, directly testable on synthetic `PageAnalysis`. */
export function aggregateDocumentAnalysis(pages: readonly PageAnalysis[]): DocumentAnalysis {
  const patternTotals = new Map<string, number>();
  let totalEntities = 0;
  let totalWarnings = 0;
  let totalPlaceholderNames = 0;
  const pageSummaries: DocumentPageSummary[] = [];

  for (const p of pages) {
    for (const c of p.patternMatchCounts) patternTotals.set(c.patternId, (patternTotals.get(c.patternId) ?? 0) + c.matchCount);
    totalEntities += p.entities.length;
    totalWarnings += p.overlaps.length + p.entities.filter((e) => e.derived.outOfRange || e.attacks.outOfRange || e.skills.outOfRange || e.typeLabel.outOfRange).length;
    const placeholderCount = p.entities.filter((e) => e.name.kind === 'placeholder').length;
    totalPlaceholderNames += placeholderCount;
    const fullCount = p.entities.filter(
      (e) => e.name.kind === 'confident' && !e.derived.outOfRange && !e.attacks.outOfRange && !e.skills.outOfRange && !e.typeLabel.outOfRange,
    ).length;
    const pageWarningCount = p.overlaps.length + p.entities.filter((e) => e.derived.outOfRange || e.attacks.outOfRange || e.skills.outOfRange || e.typeLabel.outOfRange).length;
    pageSummaries.push({ page: p.page, route: p.route, routeSupported: p.routeSupported, entityCount: p.entities.length, fullCount, warningCount: pageWarningCount, placeholderNameCount: placeholderCount });
  }

  return {
    pageCount: pages.length,
    pages: [...pages],
    patternMatchTotals: [...patternTotals.entries()].map(([patternId, matchCount]) => ({ patternId, matchCount })),
    totalEntities,
    totalWarnings,
    totalPlaceholderNames,
    pageSummaries,
  };
}

/** [Step 22 Z5] The shape of the diagnostics export — READABLE for a human (brief: "not a dump of internal structures"), not 1:1 with `DocumentAnalysis`. Excludes internal fields (raw `SectionListMatch`/tokens), keeping ONLY what a profile author actually needs to read/attach to a bug report. */
/** [Step 29] `'poza-zasiegiem'` [out-of-range] = the candidate is genuinely farther than `limit`; `'zajety'` [claimed] = the candidate was in range, but went to a different entity in the global match (see `OutOfRangeCandidate`, `entityAssembly.ts`) — two different states that the previous export version conflated under one "out of range". */
export interface DiagnosticsExportEntity {
  ordinal: number;
  name: string;
  nameStatus: 'confident' | 'placeholder';
  nameCandidates?: readonly string[];
  derived: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  attacks: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  skills: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  /** [reported after step 30] `'brak'` [none] when the profile didn't specify `typeLabelPattern` OR nothing matched — the same convention as `derived`/`attacks`/`skills` above (none of them distinguish "pattern not configured" from "configured, but no match" either). */
  typeLabel: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
}

export interface DiagnosticsExportOverlap {
  encjaA: number;
  encjaB: number;
  obszarA: StudioRegionKind;
  obszarB: StudioRegionKind;
}

export interface DiagnosticsExportPage {
  strona: number;
  /** [Step 39 Z1] This page's route (`PageAnalysis.route`) — `'npc'` or `'playerCharacter'`. */
  trasa: PageRoute;
  /** [Step 39 Z1] Replaces the former `pominietaJakoPregen`  — `false` = page skipped because the profile has no patterns for `trasa` (`PageAnalysis.routeSupported`). */
  trasaObslugiwana: boolean;
  encje: DiagnosticsExportEntity[];
  zachodzenia: DiagnosticsExportOverlap[];
}

export interface DiagnosticsExport {
  liczbaStron: number;
  liczbaEncji: number;
  liczbaOstrzezen: number;
  liczbaNazwPlaceholder: number;
  trafieniaPerWzorzec: Record<string, number>;
  strony: DiagnosticsExportPage[];
}

function attachResultToExport<TMatch>(result: AttachDiagnosticResult<TMatch>): DiagnosticsExportEntity['derived'] {
  if (result.match) return 'ok';
  if (result.outOfRange) {
    const status = result.outOfRange.reason === 'tooFar' ? 'poza-zasiegiem' : 'zajety';
    return { status, dystans: Math.round(result.outOfRange.distance), limit: result.outOfRange.maxDistancePt };
  }
  return 'brak';
}

/** [Step 22 Z5] `DocumentAnalysis` (ALREADY computed) -> a shape to save as a JSON file. A PURE function (zero `Date.now()`/randomness — determinism, a sibling principle to the project's `check:size`), the caller (`ProfileStudio.ts`) adds any date/filename on the module side. */
export function buildDiagnosticsExport(analysis: DocumentAnalysis): DiagnosticsExport {
  return {
    liczbaStron: analysis.pageCount,
    liczbaEncji: analysis.totalEntities,
    liczbaOstrzezen: analysis.totalWarnings,
    liczbaNazwPlaceholder: analysis.totalPlaceholderNames,
    trafieniaPerWzorzec: Object.fromEntries(analysis.patternMatchTotals.map((c) => [c.patternId, c.matchCount])),
    strony: analysis.pages
      .filter((p) => !p.routeSupported || p.entities.length > 0)
      .map((p) => ({
        strona: p.page,
        trasa: p.route,
        trasaObslugiwana: p.routeSupported,
        encje: p.entities.map((e) => ({
          ordinal: e.ordinal,
          name: e.name.kind === 'confident' ? e.name.text : e.name.placeholder,
          nameStatus: e.name.kind,
          nameCandidates: e.name.kind === 'placeholder' && e.name.candidates.length > 0 ? e.name.candidates : undefined,
          derived: attachResultToExport(e.derived),
          attacks: attachResultToExport(e.attacks),
          skills: attachResultToExport(e.skills),
          typeLabel: attachResultToExport(e.typeLabel),
        })),
        zachodzenia: p.overlaps.map((o) => ({ encjaA: o.entityOrdinalA, encjaB: o.entityOrdinalB, obszarA: o.regionKindA, obszarB: o.regionKindB })),
      })),
  };
}
