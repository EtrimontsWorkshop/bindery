import type { Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { PatternSet, ProfileV2 } from './schema.js';
import type { PageRoute } from './pageRoute.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { findAttackDescriptionClaimedRanges, findAttackDescriptionsBelow } from './attackDescriptionCrossReference.js';
import { matchFontRoleCandidate } from './entityName.js';
import { lastClaimedTokenIndex, matchProseBlock, type ProseBlockMatch } from './proseBlock.js';
import { attachAndMergeLabelledPairs, attachNearest, resolveEntityNames, type AttachCandidate, type GeometricAnchor, type NameCandidate, type NameResolution } from './entityAssembly.js';

/**
 * [Step 39 Z1] Selects the pattern set matching the page's route. `'npc'`
 * is the profile's root-level fields (`patterns`/`entityAssembly`, unchanged since
 * step 18 — EVERY existing profile always has them). `'playerCharacter'` is the
 * optional second section (`profile.playerCharacter`, `schema.ts`) — `null` when the
 * profile doesn't have it (the author hasn't yet configured patterns for player characters).
 * The caller (`assembleStatblocksOnPage` below, `studioAnalysis.ts`) treats
 * `null` as "route unsupported" — the page is skipped, patterns are NEVER
 * mixed between routes.
 */
export function resolvePatternSetForRoute(profile: ProfileV2, route: PageRoute): PatternSet | null {
  if (route === 'npc') return { patterns: profile.patterns, entityAssembly: profile.entityAssembly };
  return profile.playerCharacter ?? null;
}

/**
 * [Step 18 Z4] Combines Z2 (the pattern engine) and Z3 (geometric assembly) into
 * ONE function driven directly by the configured profile (`entityAssembly`
 * from §5.5) — one entity (NPC/monster OR, since step 39, a pregen Investigator) per
 * page, ready to feed a CIFActor (Z6). The anchor is always a
 * `labelledPairs` pattern (attribute grid) pointed to by `entityAssembly.anchor`
 * of the SELECTED pattern set (`resolvePatternSetForRoute` above) — another
 * pattern kind as the anchor is not supported in this scope (an attribute grid ALWAYS
 * exists for both categories, see Z0 and step 38).
 */

export interface AssembledStatblock {
  /** Which grid on the page (0-indexed, order in the stream) — for `namePlaceholder`'s `{ordinal}` and identification. */
  ordinal: number;
  /**
   * [Step 39 Z1] The route whose pattern set built this entity —
   * the adapter (`coc7.ts`) uses it to decide what type of actor to create
   * (`npc` vs `character`). Optional — an additive field like `skills`/
   * `attackBelowTexts`/`notes` above (code constructing `AssembledStatblock`
   * directly, e.g. test fixtures predating this field, doesn't need to
   * change); ALWAYS filled in by `assembleStatblocksOnPage`.
   */
  route?: PageRoute;
  grid: LabelledPairsMatch;
  derived: LabelledPairsMatch | null;
  attacks: SectionListMatch | null;
  /**
   * [Step 33 Z4] Parallel to `attacks.items` (the same index) — a description
   * found in prose BELOW the attacks list, introduced by its OWN
   * subheading starting with that attack's full name, see
   * `attackDescriptionCrossReference.ts`. `[]` when `attacks` is `null`;
   * `null` at a position where nothing was found (A7 — no match is a
   * valid result, not an error). Optional — an additive field (like `skills`
   * above), so code constructing `AssembledStatblock` directly (e.g.
   * test fixtures predating this field) doesn't need to change.
   */
  attackBelowTexts?: (string | null)[];
  /** [Step 20 Z2b] The general skills list (a "Skills:" heading followed by comma-separated skill-percentage entries), see `entityAssembly.skillsPattern`. `null` when the profile didn't specify `skillsPattern` OR the page doesn't have one. */
  skills: SectionListMatch | null;
  name: NameResolution;
  /** [reported after step 30] A free-form occupation/type label (e.g. a short job title), see `entityAssembly.typeLabelPattern`. `null` when the profile didn't specify this pattern OR nothing matched within range. */
  typeLabel: string | null;
  /**
   * [Step 34 Z2] Prose blocks attached geometrically (`entityAssembly.notesPatterns`,
   * `proseBlock.ts`) — one entry per pattern that found ANYTHING for this
   * entity (no entry, not `null`, when nothing was found — A10). `[]` when
   * the profile has no `notesPatterns` OR none matched. Optional —
   * an additive field like `attackBelowTexts`/`skills` above.
   */
  notes?: { label: string; text: string }[];
  bbox: Rect;
}

function toGeometricAnchors(matches: readonly LabelledPairsMatch[]): GeometricAnchor[] {
  return matches.map((m) => ({ bbox: m.bbox, anchorTokenIndex: m.startIndex }));
}

/** [Step 22] Exported for reuse in Profile Studio (`studioAnalysis.ts`) — THE SAME conversion used here, so diagnostics see exactly the same candidates as the real pipeline. */
export function toAttachCandidates(matches: readonly LabelledPairsMatch[]): AttachCandidate[] {
  return matches.map((m) => ({ bbox: m.bbox, tokenIndex: m.startIndex }));
}

/** [Step 22] As above — exported for Profile Studio. */
export function sectionListToAttachCandidates(matches: readonly SectionListMatch[], tokens: readonly ProfileToken[]): AttachCandidate[] {
  return matches.map((m) => ({ bbox: tokens[m.headerTokenIndex]!.bbox, tokenIndex: m.headerTokenIndex }));
}

/**
 * Builds statblocks for ONE page. The caller supplies tokens of THAT page
 * (see `ProfileToken` — token.page is optional, but required if the profile
 * sets `excludeRepeatedAcrossPages`, which means passing tokens from the
 * whole document to `matchFontRoleCandidate` itself, see `entityName.ts`).
 * Route classification (`classifyPageRoute`, `pageRoute.ts`) is a separate,
 * EARLIER step — the caller (`buildActorsForDocument.ts`) has already decided
 * `route`; this function ONLY selects the pattern set matching it
 * (`resolvePatternSetForRoute` above) and never mixes patterns between
 * routes [Step 39 Z1]. `null` (no `playerCharacter` section in the profile) =
 * route unsupported = `[]`, WITHOUT throwing — the caller is responsible for
 * a `Diagnostic` explaining the skipped page (A10).
 */
export function assembleStatblocksOnPage(tokens: readonly ProfileToken[], profile: ProfileV2, page: number, route: PageRoute): AssembledStatblock[] {
  const patternSet = resolvePatternSetForRoute(profile, route);
  if (!patternSet) return [];

  const anchorPatternId = patternSet.entityAssembly.anchor;
  const anchorPattern = patternSet.patterns[anchorPatternId];
  if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
    throw new Error(`assembleStatblocksOnPage: anchor "${anchorPatternId}" must be a labelledPairs pattern (attribute grid), but is "${anchorPattern?.kind ?? 'missing'}"`);
  }
  const grids = matchLabelledPairs(tokens, anchorPattern);
  const anchors = toGeometricAnchors(grids);

  const derivedRule = patternSet.entityAssembly.attach.find((r) => {
    const p = patternSet.patterns[r.pattern];
    return p?.kind === 'labelledPairs' && r.pattern !== anchorPatternId;
  });
  // [Step 20 Z2b] `skillsPattern` excluded from the candidates for "this sectionList is
  // the attacks" BELOW — without this, when a profile has TWO sectionList patterns (ATTACKS +
  // Skills), `.find()` by `kind` alone could hit Skills
  // instead of ATTACKS, depending on the order in `attach`.
  const skillsPatternId = patternSet.entityAssembly.skillsPattern;
  const attackRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'sectionList' && r.pattern !== skillsPatternId);
  const skillsRule = skillsPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === skillsPatternId) : undefined;
  // [reported after step 30] `typeLabelPattern` excluded from the candidates for "this
  // fontRoleCandidate is the name" BELOW — the same reason as `skillsPattern`
  // above: a profile can have TWO `fontRoleCandidate` patterns (name + occupation/type).
  const typeLabelPatternId = patternSet.entityAssembly.typeLabelPattern;
  const nameRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'fontRoleCandidate' && r.pattern !== typeLabelPatternId);
  const typeLabelRule = typeLabelPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === typeLabelPatternId) : undefined;

  // [Step 34 Z1] `attachAndMergeLabelledPairs`, not `attachNearest` — see the
  // comment at its definition (`entityAssembly.ts`): allows MORE THAN
  // one disjoint match of the same pattern to attach to ONE
  // anchor (e.g. an armor-rating field in its OWN paragraph, separate from the rest of the derived stats).
  let derivedAttached: (LabelledPairsMatch | null)[] = anchors.map(() => null);
  let derivedSubMatches: LabelledPairsMatch[][] = anchors.map(() => []);
  if (derivedRule) {
    const pattern = patternSet.patterns[derivedRule.pattern];
    if (pattern?.kind === 'labelledPairs') {
      const derivedMatches = matchLabelledPairs(tokens, pattern);
      const merged = attachAndMergeLabelledPairs(anchors, derivedMatches, derivedRule.strategy, derivedRule.maxDistancePt);
      derivedAttached = merged.attached;
      derivedSubMatches = merged.subMatches;
    }
  }

  // [reported after step 30, "Why do I have to point it out manually when the
  // profile already contains this"] Raw matches of the occupation/type pattern computed NOW, BEFORE
  // resolving the name, solely so that their `tokenIndex` can feed into
  // `resolveEntityNames` as `knownSiblingTokenIndices` — the mere fact that the author
  // pointed to a SEPARATE occupation/type pattern is already sufficient information for
  // the engine NOT to ask a human again to resolve the choice between these two
  // fields (see the comment at `knownSiblingTokenIndices`, `entityAssembly.ts`).
  let typeLabelPattern = typeLabelRule ? patternSet.patterns[typeLabelRule.pattern] : undefined;
  if (typeLabelPattern?.kind !== 'fontRoleCandidate') typeLabelPattern = undefined;
  const typeLabelMatches = typeLabelPattern ? matchFontRoleCandidate(tokens, typeLabelPattern) : [];
  const typeLabelMatchTokenIndices = new Set(typeLabelMatches.map((m) => m.tokenIndex));

  // [Step 24 Z4b, bug measured live] The name is resolved BEFORE the
  // ATTACKS/Skills sections (not after them, as previously) — needed for the boundaries
  // below. `resolveEntityNames` already filters raw fontRoleCandidate
  // candidates geometrically (S4) anyway, so the same result that ends up
  // in `AssembledStatblock.name` anyway now ALSO SERVES as a boundary.
  let names: NameResolution[] = anchors.map((_, i) => ({
    kind: 'placeholder',
    placeholder: patternSet.entityAssembly.namePlaceholder.replace('{page}', String(page)).replace('{ordinal}', String(i + 1)),
    candidates: [],
  }));
  // [reported after step 30, bug measured live] The token(s) that
  // name matching would consider the "nearest candidate" for ANY
  // anchor — computed INDEPENDENTLY of the confidence threshold (`attachNearest`, not
  // `resolveEntityNames`), because a placeholder due to ambiguity (S4)
  // STILL "occupies" this token geometrically, just not confidently
  // enough to show it as `name`. See its use below at `typeLabel`.
  let nameClaimedTokenIndices = new Set<number>();
  let allNameCandidateTokenIndices: number[] = [];
  if (nameRule) {
    const pattern = patternSet.patterns[nameRule.pattern];
    if (pattern?.kind === 'fontRoleCandidate') {
      const nameMatches = matchFontRoleCandidate(tokens, pattern);
      // [Step 34 Z2, bug #2 measured live, "Wrak.pdf" p. 23]
      // ALL raw candidates (`nameMatches` unfiltered) is too wide a net —
      // `fontRoleCandidate` with `excludeRoles: ['body']` lets through EVERY short
      // token in a style other than `body`, and the `accent` role sometimes gets
      // (rarely, through noise in font classification by frequency, see Step 18 Z7)
      // assigned INSIDE an ordinary Skills list (measured: a run of comma-separated
      // skill-percentage entries on p. 23 has `accent` even though it's an ordinary
      // list entry) — such a token as a boundary was CUTTING OFF that same
      // character's own, genuine skill entry, causing the Z2 note
      // to start there instead of returning `null`. `heading` is a NARROWER, more reliable
      // role — assigned by frequency/size AT THE WHOLE-DOCUMENT LEVEL (see
      // `fontRegistry.ts`) exclusively to genuine section titles/entity names (e.g.
      // a monster's name as an announcement on p. 23, THE SAME role as its actual
      // heading on p. 24) — never to ordinary bold text in the body.
      const headingNameMatches = nameMatches.filter((m) => tokens[m.tokenIndex]?.fontRole === 'heading');
      allNameCandidateTokenIndices = headingNameMatches.map((m) => m.tokenIndex);
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

  // [reported after step 30, bug measured live] `typeLabel` — its OWN,
  // independent `fontRoleCandidate` pattern (usually a different `requireFontKeys` than
  // the name, e.g. italics instead of bold), so WITHOUT `resolveEntityNames`'s confidence
  // threshold/ambiguity penalty — the same `attachNearest` as the rest of the
  // derived-stats fields. BUT: when the author hasn't yet narrowed `requireFontKeys`
  // (or the clicked token had no recognized `fontKey`), both
  // candidate pools (name/occupation) are IDENTICAL — each of the two INDEPENDENT
  // calls (each with its OWN, fresh `used`) then picks the SAME,
  // geometrically nearest token, so `typeLabel` comes out identical to
  // `name` — reported directly: "both fields show the name, not the name and
  // the occupation". Fix: EVERY token that name matching would consider its
  // best candidate for ANY anchor (`nameClaimedTokenIndices`
  // — NOT just `confident`, because in the first version of this fix a placeholder due to
  // ambiguity bypassed the exclusion, so `typeLabel` still
  // landed on literally the same token as the "almost-chosen" name), is
  // excluded from the pool of occupation/type candidates.
  let typeLabelAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  if (typeLabelPattern) {
    const typeLabelCandidates: AttachCandidate[] = typeLabelMatches
      .filter((m) => !nameClaimedTokenIndices.has(m.tokenIndex))
      .map((m) => ({ bbox: m.bbox, tokenIndex: m.tokenIndex }));
    typeLabelAttached = attachNearest(anchors, typeLabelCandidates, typeLabelRule!.strategy, typeLabelRule!.maxDistancePt);
  }

  // [Step 20 Z2, extended in Step 24 Z4b] Boundaries of OTHER characters on this
  // page — see the `hardStopTokenIndices` comment in `matchSectionList`
  // (patterns.ts). Each character's attribute grid had already bounded this since step 20,
  // but p. 56 showed a case measured directly that this did NOT
  // catch: the next character's name sometimes precedes its own grid with
  // its OWN description (a short note that a paired body part is a separate
  // creature with the same stats), so this
  // prose lay BEFORE the grid boundary and got absorbed as the "damage
  // description" of the PREVIOUS character's last attack entry (measured: one of the
  // previous character's attacks got the full name and description of the next character in `damage`). The resolved name
  // (`names`, ONLY `confident` — a placeholder has no reliable
  // `tokenIndex`) of the next character is an EARLIER boundary than its grid,
  // exactly where that prose begins.
  const anchorStartIndices = grids.map((g) => g.startIndex);
  const confidentNameTokenIndices = names.filter((n): n is Extract<NameResolution, { kind: 'confident' }> => n.kind === 'confident').map((n) => n.tokenIndex);
  // [Step 34 Z2, bug measured live, "Wrak.pdf" p. 23] `confident`
  // names ALONE are not enough: an entity can have its OWN title/heading
  // on this page without a full attribute grid next to it (e.g. an announcement/
  // introductory description of a monster at the end of a page, whose real statblock is ONLY on
  // the NEXT page — a monster's name as an intro heading on p. 23, its grid
  // only on p. 24). Such a token NEVER becomes `confident` (no anchor
  // ON THIS page for it to attach to), so `confidentNameTokenIndices`
  // alone missed it — the ATTACKS/Skills/Notes of the LAST character on
  // the page (with no next anchor AFTER it on the same page) ran
  // unbounded all the way to the end of the stream, absorbing that intro as its OWN
  // content (measured: that last character's note got the whole introductory description of the next monster).
  // Fix: ADDITIONALLY (not INSTEAD) every raw name-pattern candidate with the
  // `heading` role (`allNameCandidateTokenIndices`) is also a boundary. `heading`, not
  // the whole unfiltered `nameMatches` — see the comment at its calculation above:
  // `accent` sometimes gets (rarely, font-classification noise) assigned INSIDE an ordinary
  // Skills list, so using it here without a filter would CUT OFF that same
  // character's own, genuine entry (measured live as a SECOND bug the
  // same day, the same file/page). `confidentNameTokenIndices` stays
  // SEPARATE (not just `heading`) — this is backward compatibility with Step 24 Z4b
  // (a synthetic fixture with two body-part entities), where a `confident` name does NOT have the
  // `heading` role and must still work as a boundary.
  const hardStopTokenIndices = [...anchorStartIndices, ...confidentNameTokenIndices, ...allNameCandidateTokenIndices];

  let attackAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  let attackMatches: SectionListMatch[] = [];
  if (attackRule) {
    const pattern = patternSet.patterns[attackRule.pattern];
    if (pattern?.kind === 'sectionList') {
      attackMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      attackAttached = attachNearest(anchors, sectionListToAttachCandidates(attackMatches, tokens), attackRule.strategy, attackRule.maxDistancePt);
    }
  }

  let skillsAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  let skillsMatches: SectionListMatch[] = [];
  if (skillsRule) {
    const pattern = patternSet.patterns[skillsRule.pattern];
    if (pattern?.kind === 'sectionList') {
      skillsMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      skillsAttached = attachNearest(anchors, sectionListToAttachCandidates(skillsMatches, tokens), skillsRule.strategy, skillsRule.maxDistancePt);
    }
  }

  // [Step 34 Z2] Everything already matched by OTHER patterns on this page —
  // excluded from prose-block candidates, so a note does NOT duplicate content
  // already shown elsewhere on the sheet (grid/derived stats/attacks/skills/
  // name/typeLabel PAGE-WIDE, not just for one entity — safer than
  // "only what was actually attached", because it also prevents prose "accidentally"
  // matching geometrically to the wrong anchor from breaking the
  // boundary between neighboring entities) — PLUS ranges already consumed
  // by step-33 Z4 (`findAttackDescriptionClaimedRanges`), so two
  // independent mechanisms never show THE SAME content twice (step-34
  // brief, "Relationship to Z4 from step 33").
  const claimedTokenIndices = new Set<number>();
  for (const g of grids) for (let t = g.startIndex; t < g.endIndex; t++) claimedTokenIndices.add(t);
  // [Step 34 Z2, bug measured live] `derivedAttached[i]` can be a
  // MERGE of disjoint matches (Z1, `attachAndMergeLabelledPairs`) —
  // its `startIndex..endIndex` is a bounding UNION, NOT a contiguous range. It's
  // necessary to iterate over `derivedSubMatches` (each entry its OWN, genuinely contiguous range),
  // otherwise the exclusion also "swallows" unclaimed prose between merged
  // fragments (measured directly: a stray pair of stat labels
  // between the main derived-stats block and an orphaned armor-rating label were disappearing from the pool
  // of note candidates, even though they weren't PART of any pair).
  for (const subs of derivedSubMatches) for (const d of subs) for (let t = d.startIndex; t < d.endIndex; t++) claimedTokenIndices.add(t);
  // [Step 34 Z2, bug measured live] `SectionListMatch.endIndex` is the
  // SEARCH BOUNDARY (how far the section buffer SEARCHED for further entries,
  // see `matchSectionList`/`terminateSectionBefore`), NOT "all of this is
  // already shown as an attack" — on one monster (p. 24 "Wrak.pdf") it stretches
  // ALL THE WAY to the end of the page (no next header/anchor AFTER it), so
  // excluding the whole `[headerTokenIndex, endIndex)` would swallow a special-ability note
  // and the rest of the note as "already claimed", even though what's genuinely written
  // out is ONLY the entries in `items` (`startTokenIndex..endTokenIndex`, INCLUSIVE).
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
  // [Step 34 Z2, bug measured live] NOT the entire pool of raw
  // `typeLabelMatches` candidates — `fontRoleCandidate` with `excludeRoles: ['body']` catches
  // EVERY short accent-style token on the page (e.g. one monster's page, several
  // note subheadings are ALL
  // typeLabel "candidates", even though none was ACTUALLY attached
  // as anyone's occupation/type) — excluding the WHOLE pool would swallow exactly the
  // note subheadings this mechanism exists to catch.
  // Only tokens ACTUALLY ATTACHED (`typeLabelAttached`) are genuinely "already
  // shown elsewhere on the sheet".
  for (const c of typeLabelAttached) if (c) claimedTokenIndices.add(c.tokenIndex);

  const notesPatternIds = patternSet.entityAssembly.notesPatterns ?? [];
  const notesPatterns = notesPatternIds.map((id) => patternSet.patterns[id]).filter((p): p is Extract<typeof p, { kind: 'proseBlock' }> => p?.kind === 'proseBlock');

  return grids.map((grid, i) => {
    const attackCandidate = attackAttached[i];
    const skillsCandidate = skillsAttached[i];
    const typeLabelCandidate = typeLabelAttached[i];
    const attacks = attackCandidate ? (attackMatches.find((m) => m.headerTokenIndex === attackCandidate.tokenIndex) ?? null) : null;
    const derivedForEntity = derivedAttached[i] ?? null;
    const skillsForEntity = skillsCandidate ? (skillsMatches.find((m) => m.headerTokenIndex === skillsCandidate.tokenIndex) ?? null) : null;
    const referenceTokenIndex = notesPatterns.length > 0 ? lastClaimedTokenIndex(tokens, { grid, derived: derivedForEntity, attacks, skills: skillsForEntity }, hardStopTokenIndices) : null;
    const referenceBbox = referenceTokenIndex !== null ? tokens[referenceTokenIndex]!.bbox : grid.bbox;
    // [reported live, "Wrak.pdf" Investigators, `anchorGridOnly`] `referenceBbox`
    // above marks the end of the entity's ENTIRE content (grid+derived stats+attacks+
    // skills) — correct for notes BELOW that content in THE SAME
    // column, but for a note in a SEPARATE column (e.g. a note addressed to the
    // player's allies)
    // this unnecessarily ties its position to the LENGTH of the Skills list,
    // which is geometrically independent and different for each character. This
    // variant is computed EXCLUSIVELY from the anchor grid itself (without attacks/
    // skills) — see `lastClaimedTokenIndex`'s own, analogous
    // reason for skipping `derived`.
    const referenceBboxGridOnly = referenceTokenIndex !== null ? tokens[lastClaimedTokenIndex(tokens, { grid }, hardStopTokenIndices)]!.bbox : grid.bbox;
    const notes: { label: string; text: string }[] = [];
    // [Step 34 Z2, bug measured live, "Wrak.pdf" p. 24, two note
    // blocks close together] `claimedTokenIndices`
    // ALONE is NOT enough when the author adds MORE THAN one note pattern
    // — without accumulation, the SECOND pattern in the list doesn't know the first already
    // claimed a short piece of text, and (when both offsets point close together) finds
    // THE SAME token as the "nearest unclaimed", producing TWO notes with
    // IDENTICAL content instead of one genuine one and one `null`. Fix:
    // a private copy per ENTITY (doesn't mutate the `claimedTokenIndices` shared
    // with other entities), extended by the range of EVERY match BEFORE
    // trying the next pattern in the same list.
    const claimedForNotes = new Set(claimedTokenIndices);
    const entityName = names[i]!;
    const ownNameText = entityName.kind === 'confident' ? entityName.text : undefined;
    // [reported live after Step 39, "Wrak.pdf" Investigators, `chainFromPrevious`]
    // The reference point for patterns with `chainFromPrevious: true` — starts at
    // THE SAME fixed point as the rest (`referenceBbox`), but AFTER EVERY
    // successful match (regardless of its own `chainFromPrevious` —
    // the next pattern should get the FRESHEST end, not the end from two
    // patterns back, in case one in the middle was still old-style) it moves to
    // the end of the note JUST matched. The block's last token (not the union bbox
    // of the whole block — multi-line text would collapse `minX` to the left edge
    // of an EARLIER line, not the actual end), the same pattern
    // `lastClaimedTokenBbox` uses for grid/derived/attacks/skills.
    let chainBbox = referenceBbox;
    for (const notePattern of notesPatterns) {
      const fixedReference = notePattern.anchorGridOnly ? referenceBboxGridOnly : referenceBbox;
      const searchFrom = notePattern.chainFromPrevious ? chainBbox : fixedReference;
      const match: ProseBlockMatch | null = matchProseBlock(tokens, notePattern, searchFrom, {
        hardStopTokenIndices,
        excludedTokenIndices: claimedForNotes,
        referenceTokenIndex: referenceTokenIndex ?? undefined,
        ownNameText,
      });
      if (match) {
        notes.push({ label: match.label, text: match.text });
        for (let t = match.startIndex; t < match.endIndex; t++) claimedForNotes.add(t);
        chainBbox = tokens[match.endIndex - 1]!.bbox;
      }
    }
    return {
      ordinal: i,
      route,
      grid,
      derived: derivedForEntity,
      attacks,
      attackBelowTexts: attacks ? findAttackDescriptionsBelow(tokens, attacks, hardStopTokenIndices) : [],
      skills: skillsForEntity,
      name: names[i]!,
      typeLabel: typeLabelCandidate ? (typeLabelMatches.find((m) => m.tokenIndex === typeLabelCandidate.tokenIndex)?.text ?? null) : null,
      notes,
      bbox: grid.bbox,
    };
  });
}
