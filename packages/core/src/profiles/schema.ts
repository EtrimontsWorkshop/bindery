import { z } from 'zod';

/**
 * [Step 18 Z2] Profile v2 schema — an implementation of `Bindery-MDD-v2.1.md` §5.5
 * LITERALLY (the JSON shape from the brief, field by field). Profiles come from
 * unknown authors (outside this repo, MDD §10 `registerProfile`/
 * `loadProfileFromURL`) — validation on load is MANDATORY, never
 * `as`/trusting the structure without checking.
 *
 * [R2, status-blocking] A profile is EXCLUSIVELY parsing instructions (field
 * labels, regexes, distance thresholds, section headers as patterns) — NEVER
 * content values (character names, descriptions, spell lists). This schema
 * enforces that ONLY structurally (field types) — it cannot distinguish a short
 * attribute-abbreviation label (allowed) from a character or place name
 * (content, disallowed) entered into the same
 * `labels` field, since both are valid strings. Content auditing remains
 * the responsibility of the profile reviewer (analogous to R1 in this repo —
 * enforced by not committing samples, not by an automated scanner).
 */

const pageRangeSchema = z.tuple([z.number().int(), z.number().int()]);

const excludeZoneSchema = z.object({
  kind: z.string(),
  yFrom: z.number().min(0).max(1),
  yTo: z.number().min(0).max(1),
});

const pagesSchema = z.object({
  include: z.array(pageRangeSchema).min(1),
  excludeZones: z.array(excludeZoneSchema).optional().default([]),
});

const fingerprintSchema = z.object({
  metadata: z.record(z.string(), z.string()).optional().default({}),
  keywords: z.array(z.string()).optional().default([]),
  antiKeywords: z.array(z.string()).optional().default([]),
  minScore: z.number().min(0).max(1),
});

/** `labelledPairs` — attribute grid / derived-stats block (a set of labels, in ANY order and count — S2). */
const labelledPairsPatternSchema = z.object({
  kind: z.literal('labelledPairs'),
  /** Label (PDF key) -> the result's canonical key. Labels only, NOT values (R2). */
  labels: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0, 'labels must not be empty'),
  valuePattern: z.string(),
  minPairs: z.number().int().min(1),
  maxPairs: z.number().int().optional(),
  terminate: z
    .object({
      onRepeatedLabel: z.boolean().optional().default(false),
      maxGapPt: z.number().positive().optional(),
    })
    .optional()
    .default({}),
  /** [S1] A value is sometimes split by hyphenation/spacing into several tokens (e.g. a fraction like "12/12" followed by a separate descriptive status word) — join before matching. */
  allowTrailingWords: z.boolean().optional().default(false),
  unit: z.string().optional(),
  /**
   * [Step 19 Z4, bug measured on a real book] `allowTrailingWords`
   * checks ONLY its OWN pattern's labels (`looksLikeLabel`), to know
   * when to stop absorbing descriptive words — but it has no notion of the headers
   * of OTHER patterns (e.g. a following attacks-list section). Measured directly: the last pair
   * of `derivedBlock` (a derived-stat label near the end of that block), with no further label of its OWN pattern
   * after it, absorbed the literal header token of the NEXT section
   * (plus its introductory line) as "descriptive words". If supplied,
   * any token matching this pattern immediately stops the absorption (the token is NOT
   * consumed).
   *
   * [Step 27 Z2, renamed] Formerly `stopBeforeToken` — the same name as in
   * `sectionList` below suggested the SAME scope (it confused me myself while
   * writing the step-26 brief, see RAPORT-KROK-26.md discovery #4), but these are
   * TWO DIFFERENT mechanisms: this field limits absorbing descriptive words FOR
   * ONE PAIR (see `allowTrailingWords` next to it), while `terminateSectionBefore`
   * in `sectionList` ends the WHOLE SECTION. The new name reads together with
   * `allowTrailingWords` as one coherent feature, instead of two unrelated
   * fields with an identical name and different meaning.
   */
  trailingWordsStopBefore: z.string().optional(),
});

/** `sectionList` — a section header (regex) + a list of entries matched by `itemPattern`. */
const sectionListPatternSchema = z.object({
  kind: z.literal('sectionList'),
  sectionHeader: z.string(),
  // [Step 34, bug measured live, "Wrak.pdf"] An empty `itemPattern` compiles
  // to `new RegExp('', 'gu')` — it matches an EMPTY string at EVERY position of the
  // buffer, so `matchSectionList` returns hundreds of entries with NO group
  // (`groups: {}`), and each one's `name` is an empty value, which Foundry
  // (`StringField`, `blank:false`) turns into `undefined` during validation —
  // "name: may not be undefined" when creating an Item, INSTEAD OF a readable
  // profile error at load time. Requiring a non-empty pattern here
  // (A7 — degrade when the profile loads, not deep inside Foundry in an emergency)
  // moves this same bug to a place where the author can fix it.
  itemPattern: z.string().min(1, 'itemPattern must not be empty'),
  /** [S1] A description is sometimes split by hyphenation into several tokens — join before matching. */
  rejoinHyphenated: z.boolean().optional().default(false),
  /**
   * [Step 19 Z1, fixed bug] A table COLUMN header (e.g. a percentage-damage
   * column label used in some translated CoC7 books) directly AFTER the section header, BEFORE
   * the first genuine entry — measured directly: without skipping this
   * header, the greedy name group in `itemPattern` swallowed it together with
   * the first real name (the column label plus the entry's actual name, instead of the name alone).
   * Excluding this from `itemPattern` itself (a negative lookahead) turned out to be
   * fragile — it only works at the START of a match, not inside a growing
   * greedy group. Instead: if the text DIRECTLY after the section header
   * matches this pattern, skip it entirely BEFORE building the
   * item buffer.
   */
  skipAfterHeader: z.string().optional(),
  /**
   * [Step 19 Z4, bug measured on a real book] The section item buffer
   * (between its header and the NEXT occurrence of `sectionHeader` or the
   * end of the token stream) had NO limit at all for the LAST
   * section on the page — when there is no next section header after it, the buffer would run
   * all the way to the end of the page, catching content belonging to a completely different
   * character (e.g. a skills list with percentage values
   * following an attack description, falsely recognized as further attack entries). If supplied, any
   * token matching this pattern STOPS the buffer from growing further (the token is NOT
   * consumed anymore) — the profile's equivalent of "this section ends here",
   * independent of whether a next `sectionHeader` is present. In this book it
   * works as "any standalone token that looks like a Heading:"
   * (`^\p{Lu}[\p{L} ]*:$`, e.g. a colon-terminated category heading such as a skills-list or a sanity-loss heading).
   *
   * [Step 27 Z2, renamed] Formerly `stopBeforeToken` — the name said nothing
   * about SCOPE (it ends the WHOLE SECTION, not a single entry), which confused
   * later sessions (the step-26 brief, its own report, and indirectly the
   * step-20 analysis too — see RAPORT-KROK-27.md). The answer to "how to limit a SINGLE
   * entry" lies in `itemPattern`, via a lookahead recognizing the boundary of
   * the next entry (the p. 56 fix from step 26) — a DIFFERENT mechanism from this
   * field, deliberately — see `docs/writing-profiles.md`.
   */
  terminateSectionBefore: z.string().optional(),
  /**
   * [Step 40, reported live] Words/phrases (in any language the book uses), by
   * which we recognize that a list entry is a RANGED weapon (e.g. a
   * language-specific word meaning "firearm") — case-insensitive matching as a SUBSTRING of the matched
   * entry's `name` group. The system adapter (e.g. CoC7) interprets the presence of
   * such a match as the `ranged` flag in `CIFAttack.properties`, NEVER
   * hardcoded the other way around in the engine/adapter (R2 — a language dictionary is
   * profile content, not engine logic). Deliberately SEPARATED from `itemPattern`:
   * if this were an extra regex group inside `itemPattern`, every re-run of
   * "Start over" + clicking examples in Profile Studio (see
   * `inferItemPatternFromExamples.ts`) would silently overwrite it — the same
   * persistence risk that already once caused the ".22 pistol
   * disappears" bug (see `NAME_CLASS` in `inferItemPatternFromExamples.ts`). This field
   * is NOT inferred from clicking examples — the author enters it directly
   * (Profile Studio, "Advanced") and it survives every regeneration of
   * `itemPattern`. Empty by default — backward compatible, all entries
   * treated as before (never `ranged`).
   */
  rangedKeywords: z.array(z.string()).optional().default([]),
});

/** `fontRoleCandidate` — a candidate for an entity name: short text with a font role != the excluded ones (S3, an INPUT filter to geometric pairing, not a standalone decision). */
const fontRoleCandidatePatternSchema = z.object({
  kind: z.literal('fontRoleCandidate'),
  excludeRoles: z.array(z.string()).optional().default(['body']),
  maxLength: z.number().int().positive().optional().default(60),
  excludeRepeatedAcrossPages: z.boolean().optional().default(true),
  excludeHyphenContinuations: z.boolean().optional().default(true),
  /**
   * [Step 29 Z3] Font key(s) (`ProfileToken.fontKey`, see `types.ts`)
   * learned from a click in Profile Studio, "Name" tab — an ADDITIONAL
   * condition ON TOP OF (not instead of) `excludeRoles`: when non-empty, a token must have
   * a `fontKey` BELONGING to this set to become a candidate. A
   * ORDER-OF-MAGNITUDE narrowing of the font role's precision alone (step 12's H2: role
   * alone "!= body" gives 2401 candidates for 15 entities in the Polish book — a role is a
   * RANKING of frequency/size per DOCUMENT, spanning MANY different
   * typefaces, not an identifier of the SPECIFIC typeface used just for names).
   * Optional and empty by default — BACKWARD COMPATIBLE: absent = behavior
   * identical to before Step 29 (both existing CoC7 profiles keep working
   * unchanged, the step's brief explicitly requires this).
   */
  requireFontKeys: z.array(z.string()).optional().default([]),
});

/**
 * [Step 34 Z2] "Notes located within the PDF" — a prose block attached
 * GEOMETRICALLY to an entity's anchor, not by text matching (descriptions of
 * creatures/tactics lying in prose next to a statblock have no common
 * header/regex to latch onto — unlike `labelledPairs`/`sectionList`,
 * which ALWAYS have some textual marker). Per R2 ("a profile carries
 * parsing instructions, never content") — `offset` is EXCLUSIVELY a position
 * RELATIVE TO THE END OF THIS ENTITY'S OWN CONTENT (the last token of the grid/derived
 * stats/attacks/skills — `proseBlock.ts`'s `lastClaimedTokenBbox`, NOT
 * the start of the anchor — a bug measured live showed that a fixed distance FROM
 * THE ANCHOR breaks down when different entities have different lengths of their own content),
 * measured ONCE by the profile author (Studio, "Measure") on one example,
 * NEVER literal PDF text. The block's actual EXTENT (how far down it reaches) is NOT
 * stored as a fixed height — it's computed on the fly during matching, and
 * stopped at the entity/column boundary (`hardStopTokenIndices`/`columnBand`,
 * steps 29-31, see `proseBlock.ts`), per the brief's "Safeguards".
 */
const proseBlockPatternSchema = z.object({
  kind: z.literal('proseBlock'),
  /** The label IN THE RESULTING note (e.g. "Description", "Tactics") — in-world-language text appended when assembling the note, NOT searched for in the PDF. */
  label: z.string().min(1),
  offset: z.object({
    /** X offset from `anchor.bbox.minX` to the left edge of the example. */
    dxPt: z.number(),
    /** Y offset from `anchor.bbox.minY` to the TOP edge of the example (PDF: larger Y = higher on the page). */
    dyPt: z.number(),
  }),
  /** [Advanced] A hard limit on a single block's length — degrading (truncating) instead of being unbounded, in case the entity/column boundary fails on an unusual layout. */
  maxLengthChars: z.number().int().positive().optional().default(2000),
  /** Tolerance radius (pt) around the computed starting point, within which the nearest token is searched for — like `maxDistancePt` in the rest of the engine. */
  searchRadiusPt: z.number().positive().optional().default(60),
  /**
   * [reported live after step 39, "Wrak.pdf" Investigators] By default (`false`/
   * absent) `offset` is computed RELATIVE TO THE SAME fixed point as the rest
   * of the fields (the end of the attribute grid/derived stats/attacks/skills) — this works
   * perfectly when the note fields have a FIXED position (a typical layout: grid,
   * then always the same fields in the same places). It fails, however, when
   * the note fields are STACKED ONE BELOW ANOTHER WITH VARIABLE LENGTH between
   * them (e.g. one character's longer biography shifts ALL subsequent
   * fields lower than for another character with a shorter biography) — measured
   * directly: across 6 Investigator pages of this book, the position of a given note's heading
   * relative to the fixed point varied by more than 70pt, well beyond `searchRadiusPt`. `true`
   * instead computes `offset` RELATIVE TO THE END OF THE PREVIOUS note in the
   * `notesPatterns` list (the first note in the list always uses the fixed point,
   * since it has no predecessor) — stable regardless of the length of the text
   * above it, provided `notesPatterns` are in the same order in
   * which the fields actually appear on the page. Disabled by default —
   * an additional, backward-compatible field (existing profiles, which already work
   * with the fixed point, keep their behavior unchanged).
   */
  chainFromPrevious: z.boolean().optional().default(false),
  /**
   * [reported live, "Wrak.pdf" Investigators — "I only select these two, and
   * everything from those paragraphs gets filled into them"] By default
   * (`false`) collection stops at the FIRST next token of role
   * `accent` ending in a colon — this works well when a note should catch
   * ONLY the content up to the nearest SUBheading. But when the author wants
   * ONE click (e.g. on a top-level biography heading, which always uses the LARGER
   * `heading` style, 11pt in this book, unlike the smaller `accent`
   * subheadings used for fields such as appearance or personality traits) to catch EVERYTHING up to the
   * NEXT heading of THE SAME style (here: a heading introducing a list of social contacts, also
   * `heading`) — skipping OVER any number of smaller subheadings
   * along the way — `true` compares the STOPPING token's font role to the role
   * of the START token ITSELF (the clicked example), instead of a hardcoded
   * `accent`. A trailing colon is still required (the same signal as by default
   * — genuine subheadings in this book ALWAYS have one, see the comment at
   * the engine in `proseBlock.ts`).
   */
  stopAtSameFontRole: z.boolean().optional().default(false),
  /**
   * [reported live, "Wrak.pdf" Investigators, a social-contacts note in the right
   * column] By default (`false`) `offset` (when `chainFromPrevious` is
   * disabled) is computed relative to the end of the entity's ENTIRE OWN content (grid +
   * derived stats + ATTACKS + Skills) — a correct assumption when the note lies
   * BELOW that content in THE SAME column. It fails, however, for a note in a
   * SEPARATE column, independent of the length of the Skills list — measured
   * directly: the position of that note's heading relative to the fixed point including
   * Skills varied by >70pt across 6 characters (a different number of
   * skills = a different list length = a different end), but relative to the
   * attribute grid ALONE (without attacks/skills) it is stable (+/-12pt). `true`
   * computes `offset` solely relative to the end of the anchor grid, ignoring
   * attacks/skills when determining the reference point.
   */
  anchorGridOnly: z.boolean().optional().default(false),
});

const patternSchema = z.discriminatedUnion('kind', [labelledPairsPatternSchema, sectionListPatternSchema, fontRoleCandidatePatternSchema, proseBlockPatternSchema]);

const attachRuleSchema = z.object({
  /** Pattern id from `patterns` (not a literal — any key defined by the profile author). */
  pattern: z.string(),
  /**
   * [Step 18 Z7, `nearest` added after measuring across the whole book] MDD §5.5
   * only defines `nearestBelow`/`nearestAbove` (a vertical layout: name above
   * the grid, derived stats below the grid). Measured directly on `Zew_Cthulhu_Nie_czas_
   * na_krzyk_v1_0.pdf`: pages with multiple characters lay
   * out the grid and its derived-stats block SIDE BY SIDE on the same line (columns), not
   * one below the other — `nearestBelow` never finds a candidate, regardless
   * of `maxDistancePt`, because the directional condition is never satisfied. `nearest`
   * is the same mechanism without the directional requirement — plain Euclidean distance between
   * bboxes. The profile author chooses the strategy per pattern/publication, the engine
   * never guesses the page layout on its own.
   */
  strategy: z.enum(['nearestBelow', 'nearestAbove', 'nearest']),
  maxDistancePt: z.number().positive(),
  /** [S3] Name and subtitle stand close together in the same typeface — prefer the EARLIER (above/before) sibling at a close vertical distance. */
  preferEarlierSibling: z
    .object({
      maxDeltaYPt: z.number().positive(),
    })
    .optional(),
});

const entityAssemblySchema = z.object({
  anchor: z.string(),
  attach: z.array(attachRuleSchema).optional().default([]),
  /** [S4] Below the threshold, do NOT guess a name — a placeholder + candidates in the review. A wrong name is worse than none. */
  nameConfidenceThreshold: z.number().min(0).max(1),
  namePlaceholder: z.string(),
  /** [S1] A statblock can span across page boundaries. */
  allowCrossPage: z.boolean().optional().default(false),
  /**
   * [Step 20 Z2b] Pattern id (a key of `patterns`, must be `sectionList`, must
   * have a corresponding entry in `attach`) to fill `CIFActor.skills` —
   * the statblock's list of general skills (a "Skills:" heading followed by
   * comma-separated skill-percentage entries), separate from the ATTACKS section. Optional and EXPLICIT
   * (not guessed from `kind`), because a profile can have MORE THAN ONE
   * `sectionList` pattern (ATTACKS + Skills) — without an explicit pointer the engine has
   * no way to tell which is which (`kind` alone isn't enough
   * when there are two of them). Absence of this field = behavior identical to before
   * Step 20 Z2b (the only `sectionList` in `attach` is always attacks).
   */
  skillsPattern: z.string().optional(),
  /**
   * [reported after step 30, "Splitting the name from the type/occupation"] Pattern id
   * (a key of `patterns`, must be `fontRoleCandidate`, must have a corresponding
   * entry in `attach`) to fill `CIFActor.typeLabel` — a free-form
   * occupation/type label from the rulebook (e.g. a job title or a monster-type name), SEPARATE
   * from the entity name. The same reason for existing as `skillsPattern` above: a profile
   * can have TWO `fontRoleCandidate` patterns (name + occupation/type) — without an explicit
   * pointer the engine has no way to tell which is which. Absence of this field =
   * behavior identical to before this report (the only `fontRoleCandidate`
   * in `attach` is always the name, `typeLabel` is never filled).
   */
  typeLabelPattern: z.string().optional(),
  /**
   * [Step 34 Z2] Ids of `proseBlock` patterns ("Notes located within the PDF") to
   * fill `CIFActor.notes` — each attached to the anchor INDEPENDENTLY,
   * with its OWN `offset` (not via `attach`, unlike the rest of the fields: the
   * `offset` alone IS a complete geometric-matching instruction, there is no
   * separate list of "candidates" to pair by strategy/maxDistancePt as with
   * labelledPairs/sectionList/fontRoleCandidate). Several ids = several
   * independently labeled blocks in the final note (e.g. "Description"/"Tactics"),
   * kept separate, not merged together. Empty by default — absent = behavior
   * identical to before this step (`CIFActor.notes` always `[]`).
   */
  notesPatterns: z.array(z.string()).optional().default([]),
});

const imageAssociationSchema = z.object({
  associateWithEntity: z
    .object({
      strategy: z.enum(['nearest']),
      searchDirection: z.array(z.enum(['above', 'below', 'left', 'right'])).min(1),
      sameColumnOnly: z.boolean().optional().default(false),
      maxDistancePt: z.number().positive(),
    })
    .optional(),
  /**
   * [at user request, a book with a bespoke background on every page]
   * By default, `Z1-full-bleed-background`/`Z9-high-body-text-coverage`
   * (`classify.ts`) treat a full-bleed image with dense text ON
   * TOP as decoration — calibrated to 95.7% precision on a
   * reference set (not in this repo), where such a layout
   * almost always means a repeating background texture. Some publications (e.g.
   * Wrak, every page with a unique full-bleed illustration) break this assumption —
   * this flag lets a profile OPT OUT of both decoration rules for
   * full-bleed images, without changing the globally calibrated heuristic
   * for other books. Disabled by default (no change in behavior).
   */
  treatFullBleedAsContent: z.boolean().optional().default(false),
  /**
   * [at user request, EXPERIMENTAL] For images revealed by
   * `treatFullBleedAsContent` (`Z1-full-bleed-forced-content` in classify.ts),
   * attempts to detect and crop an EMPTY, uniform margin around the actual
   * illustration by analyzing the PIXELS of the already-decoded image — see
   * `images/cropUniformMargins.ts` for the full rationale and known limitations
   * (this is a heuristic, not parsing of PDF structure; pages filled with content
   * nearly to the edge deliberately will NOT be cropped). Has no effect when
   * `treatFullBleedAsContent` is disabled. Disabled by default.
   */
  autoCropUniformMargins: z.boolean().optional().default(false),
  /**
   * [at user request, after fixing the "Wrak" crop] Cropped
   * images (`autoCropUniformMargins`) lose the adjacency of the page's bright
   * margin, which in the PDF optically brightened them (a contrast effect, not a
   * decoding bug — pixel-for-pixel agreement with the source measured directly,
   * see `brightenImage.ts`). This flag is a DELIBERATE, cosmetic departure from
   * pixel fidelity — hence a separate, explicit toggle instead of default
   * behavior. Has no effect when `autoCropUniformMargins` is disabled
   * or a given image wasn't actually cropped. Disabled by default.
   */
  brightenAutoCroppedImages: z.boolean().optional().default(false),
  /**
   * [Step 42 Z1] The starting value of the "remove background" toggle in the
   * token-prep panel (`TokenPrepApp`, `packages/module`) for images from
   * THIS profile — ONLY sets the control's initial state in the panel,
   * the user can change it per-image before confirming. Does not affect
   * `buildImageExtraction.ts` (image extraction/classification unchanged) —
   * background removal happens ONLY in the panel, at the moment of manual
   * token preparation, never automatically/in the background. Disabled by default.
   */
  removeTokenBackgroundDefault: z.boolean().optional().default(false),
});

/**
 * [Step 39 Z2] A set of patterns + entity-assembly rules for ONE import
 * route (`PageRoute`, `pageRoute.ts`) — exactly what a profile has had at the
 * root level since step 18 (`patterns`/`entityAssembly`), now factored out
 * so that THIS SAME structure can occur A SECOND TIME for the `playerCharacter`
 * route (see `playerCharacter` on `profileV2Schema` below).
 */
const patternSetSchema = z.object({
  patterns: z.record(z.string(), patternSchema).refine((v) => Object.keys(v).length > 0, 'patterns must not be empty'),
  entityAssembly: entityAssemblySchema,
});

export const profileV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  /** Edition REQUIRED in the game-line identifier (e.g. "coc7"). */
  gameLine: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  /** [S2] A profile targets a SPECIFIC publication, not the whole game line. */
  publication: z.string().min(1),
  author: z.string().optional(),
  license: z.string().optional(),
  provides: z.array(z.enum(['actors', 'scenes', 'images', 'journals'])).min(1),
  fingerprint: fingerprintSchema,
  pages: pagesSchema,
  /** Patterns for the `npc` route (`pageRoute.ts`) — field name unchanged since step 18, backward compatible with EVERY existing profile. */
  patterns: patternSetSchema.shape.patterns,
  entityAssembly: patternSetSchema.shape.entityAssembly,
  images: imageAssociationSchema.optional(),
  /**
   * [Step 39 Z2] A second, OPTIONAL section of patterns — the `playerCharacter`
   * route (pregen, ready-to-play Investigators, `pageRoute.ts`). Structure identical to
   * `patterns`/`entityAssembly` above — the same kinds of patterns, the same
   * shape of `entityAssembly` — DELIBERATELY NOT aliased/shared labels with the `npc`
   * route: the same book may use `APP` [WG] for NPCs and `APP` [WYG] for Investigators (step
   * 38, discovery #1), and the sheet layout (grid+derived stats separate vs. grid+
   * Sanity+HP on one line, comma-separated skills list vs.
   * one skill per line) differs more than just one label — a single
   * pattern with aliases would risk catching an NPC's label via the player sheet
   * and vice versa. Absence of this section = the `playerCharacter` route unsupported =
   * pages of that route skipped (with a `Diagnostic`, `buildActorsForDocument.ts`) —
   * EVERY existing profile (without this field) behaves EXACTLY as before
   * this step, with no flag at all.
   */
  playerCharacter: patternSetSchema.optional(),
});

export type ProfileV2 = z.infer<typeof profileV2Schema>;
export type PatternSet = z.infer<typeof patternSetSchema>;
export type LabelledPairsPattern = z.infer<typeof labelledPairsPatternSchema>;
export type SectionListPattern = z.infer<typeof sectionListPatternSchema>;
export type FontRoleCandidatePattern = z.infer<typeof fontRoleCandidatePatternSchema>;
export type ProseBlockPattern = z.infer<typeof proseBlockPatternSchema>;
export type PatternDef = z.infer<typeof patternSchema>;

export interface ProfileValidationOk {
  ok: true;
  profile: ProfileV2;
}
export interface ProfileValidationFailed {
  ok: false;
  /** Readable validation errors (field path + message) — NEVER an exception (step 18 Z2's DoD). */
  issues: string[];
}

/** Validates untrusted JSON as a v2 profile. Never throws — a bad profile = `ok: false` + readable errors. */
export function validateProfile(input: unknown): ProfileValidationOk | ProfileValidationFailed {
  const result = profileV2Schema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}
