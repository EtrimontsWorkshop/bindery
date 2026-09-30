import { z } from 'zod';

/**
 * [Task 1] `StatblockProfile` schema — same contract as the old, deleted
 * `profiles/schema.ts` (types derived FROM the zod schema via `z.infer`,
 * not the other way around, to avoid the type and the validator ever
 * drifting apart): a profile is untrusted input (authored by hand or
 * exported from another world), so EVERY read validates it again, never
 * just on first load.
 *
 * Unlike the old, deleted CoC7-era profile schema, nothing here names a
 * game system, a canonical stat key, or a fixed section shape — every
 * string that used to be a hardcoded assumption (which field, which
 * label, which section) is now data the profile author captured by
 * pointing at their own system's Actor (rule 1/2 of the statblock-import
 * brief, see `docs/statblock-import/PLAN.md`).
 *
 * [Task 3 revision] `FieldSource`/`StyleFilter` (how to locate a field's
 * value at RUN TIME — label/region/style) now live HERE as their
 * canonical, validated definition — they used to be a plain TS interface
 * in `extract/sources/types.ts` with no schema at all, which worked while
 * only Task 2's own tests constructed them by hand, but a `ProfileField`
 * now actually CARRIES one (`source`, added below) as real profile data,
 * so it needs validation like everything else here. `extract/sources/types.ts`
 * re-exports these rather than redefining them.
 */

export const STATBLOCK_PROFILE_SCHEMA_VERSION = 1 as const;

const rectSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

/**
 * Mirrors `SchemaFieldKind` from `../schema/types.js` MINUS `'unsupported'`
 * — nothing should ever be mapped onto a field the introspector couldn't
 * classify. Kept as its own literal enum (zod needs a literal tuple here,
 * not a type import) — `profile/schema.test.ts` asserts the two lists stay
 * in sync.
 */
const profileFieldDataTypeSchema = z.enum(['string', 'number', 'boolean', 'html', 'choices', 'array', 'object']);

const fieldCaptureSchema = z.object({
  /** Where the user clicked/dragged in the exemplar PDF page (PDF-point space). */
  exampleBbox: rectSchema,
  examplePageNumber: z.number().int().positive(),
  /** Captured font key of the example — an optional extra constraint when relocating this field elsewhere. */
  fontKey: z.string().optional(),
  /** If the field has a printed label (e.g. "HP:") near it, the label text/regex to anchor off of. */
  labelPattern: z.string().optional(),
  /** How to relocate this field's value in a DIFFERENT statblock instance elsewhere in the document. */
  relativePosition: z.enum(['sameLineAfterLabel', 'belowAnchor', 'fixedOffsetFromAnchor']),
});

/**
 * [Task 2, moved here in Task 3] "The largest font in the block" etc. —
 * see `extract/sources/styleFilterSource.ts` for how this is actually
 * applied against a block's elements. `largestFontInBlock` composes with
 * the other criteria (narrows to the largest size AMONG elements already
 * passing them, or among the whole block when nothing else is set).
 */
const styleFilterSchema = z.object({
  fontNamePattern: z.string().optional(),
  minFontSize: z.number().optional(),
  maxFontSize: z.number().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  largestFontInBlock: z.boolean().optional(),
});

const normalizedRectSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

/** [Task 2] "Text after a label until the next label, end of line, or end of block." See `extract/sources/labelSource.ts`. */
const labelSourceSchema = z.object({
  kind: z.literal('label'),
  labelPattern: z.string().min(1),
  labelIsRegex: z.boolean(),
  stopAt: z.enum(['nextLabel', 'endOfLine', 'endOfBlock']),
  /** Required when `stopAt === 'nextLabel'` — validated properly (not just at runtime) via the `superRefine` on `fieldSourceSchema` below. */
  nextLabelPattern: z.string().optional(),
  nextLabelIsRegex: z.boolean().optional(),
});

/** [Task 2] "A rectangle normalized relative to the block's bounding box." See `extract/sources/regionSource.ts`. */
const regionSourceSchema = z.object({
  kind: z.literal('region'),
  normalizedRect: normalizedRectSchema,
});

/** [Task 2] "Every element matching a style predicate." See `extract/sources/styleFilterSource.ts`. */
const styleFilterSourceSchema = z.object({
  kind: z.literal('styleFilter'),
  filter: styleFilterSchema,
});

const fieldSourceSchema = z
  .discriminatedUnion('kind', [labelSourceSchema, regionSourceSchema, styleFilterSourceSchema])
  .refine((source) => source.kind !== 'label' || source.stopAt !== 'nextLabel' || !!source.nextLabelPattern, {
    message: "a 'label' source with stopAt:'nextLabel' requires nextLabelPattern",
  });

/**
 * [Task 4] The transform chain steps a profile author can actually configure
 * on a field — mirrors `extract/transforms/types.ts`'s `TransformStep`
 * union MINUS its `'valueMap'` variant. `valueMap` is deliberately excluded
 * here: a profile already has a top-level, shareable `valueMaps: ValueMap[]`
 * registry (Task 1) plus `ProfileField.valueMapId` referencing it — embedding
 * a full `ValueMap` a second time, inline, in every field's own transform
 * chain would duplicate the same lookup table across every field that uses
 * it instead of defining it once. `import/extractInstance.ts` resolves
 * `valueMapId` (if set) and appends it as the FINAL step of the chain built
 * from `transforms` below — see that file's own comment for why "always
 * last" is a documented simplification, not a hard requirement of the
 * format itself.
 */
const transformStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trim') }),
  z.object({ kind: z.literal('normalizeWhitespace') }),
  z.object({ kind: z.literal('joinWrappedLines') }),
  z.object({ kind: z.literal('stripLigaturesAndOddChars') }),
  z.object({ kind: z.literal('regexExtract'), pattern: z.string().min(1), group: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal('parseNumber') }),
  z.object({ kind: z.literal('nthNumber'), n: z.number().int() }),
  z.object({ kind: z.literal('split'), separator: z.string().min(1), separatorIsRegex: z.boolean().optional() }),
  z.object({ kind: z.literal('join'), separator: z.string() }),
  z.object({ kind: z.literal('textToHtml') }),
  z.object({ kind: z.literal('defaultValue'), value: z.unknown() }),
]);

const profileFieldSchema = z.object({
  id: z.string().min(1),
  /** Dot path into `actor.system`, discovered via schema introspection — never a literal in module code. */
  actorSchemaPath: z.string().min(1),
  dataType: profileFieldDataTypeSchema,
  /** The ORIGINAL example the profile author pointed at — kept for the profile-builder UI's own reference, never used at extraction time. */
  capture: fieldCaptureSchema,
  /**
   * [Task 3] The GENERALIZED extraction rule Task 2's engine actually runs
   * against every OTHER statblock instance found by Task 3's detector —
   * `capture` above is a single example, this is what makes the field
   * relocatable everywhere else. Optional only because Tasks 1/2 shipped
   * before a profile-builder UI exists to derive one FROM `capture`
   * automatically; a profile with fields missing `source` simply
   * contributes nothing to Task 3's confidence score or to a future
   * "extract every field" pass (see PLAN.md's Task 3 open questions).
   */
  source: fieldSourceSchema.optional(),
  /**
   * [Task 4] The transform chain run on this field's raw matched text before
   * casting to `dataType` — closes the gap Task 3 flagged (question #17):
   * `extractField` always needed a chain, but nothing in the profile
   * supplied one until now. Defaults to empty (no transforms beyond the
   * cast itself) so every profile written before this field existed is
   * still valid.
   */
  transforms: z.array(transformStepSchema).default([]),
  /** Optional reference into `valueMaps[].id` for raw-text -> canonical-value conversion, applied as the last step of the chain above. */
  valueMapId: z.string().optional(),
});

const collectionSplitRuleSchema = z.object({
  kind: z.enum(['repeatingLinePattern', 'sectionHeaderThenEntries', 'fixedDelimiter']),
  /** e.g. locate a heading like "ATTACKS" (captured, never hardcoded), then treat each following entry until the next heading/anchor as one item. */
  sectionHeaderPattern: z.string().optional(),
  sectionHeaderIsRegex: z.boolean().optional(),
  entryBoundaryPattern: z.string().optional(),
  entryBoundaryIsRegex: z.boolean().optional(),
});

const profileCollectionSchema = z.object({
  id: z.string().min(1),
  /** e.g. "weapon" — a string from the user's chosen system's own Item subtypes. */
  itemType: z.string().min(1),
  /** UUID of an exemplar embedded Item on `templateActorUuid`, introspected the same way as the Actor itself. */
  templateItemUuid: z.string().min(1),
  splitRule: collectionSplitRuleSchema,
  /** [Task 4] Where within ONE already-split entry its own printed name lives — same shape/reuse as the profile's top-level `nameSource`, see there for why this isn't just another `itemFields` entry. */
  nameSource: fieldSourceSchema,
  /** Same shape as top-level `fields`, scoped to one collection entry. */
  itemFields: z.array(profileFieldSchema),
});

const valueMapSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['stripUnits', 'diceNotation', 'regexReplace', 'lookupTable']),
  params: z.record(z.string(), z.unknown()),
});

/** [Task 3] A label the detector expects to find within every genuine statblock instance — the raw material for the confidence score ("how many required labels/fields did we actually extract"), separate from `fields[]`/`collections[]` (which describe WHERE a VALUE lives, not just whether a label is present). */
const requiredLabelSchema = z.object({
  pattern: z.string().min(1),
  isRegex: z.boolean(),
});

/**
 * [Task 3 revision] Anchor: "a heading STYLE or a text PATTERN" — `textPattern`
 * matches by text alone; `headingStyle` matches by `styleFilter` (reusing
 * the same style-predicate vocabulary as field extraction), optionally
 * ALSO narrowed by `pattern`. Boundary: the four end-rules from the brief
 * verbatim — `nextAnchor` (until the next anchor, spanning columns/pages
 * freely — this is what lets a statblock legitimately break across a
 * column or page), `verticalGap` (stop at an unusually large vertical gap
 * between consecutive lines — reset at every column/page break, so
 * crossing one never LOOKS like a gap on its own), `endOfColumnOrPage` (a
 * hard stop at the bottom of the current column/page — for books where a
 * statblock never legitimately spans one, so two side-by-side or
 * back-to-back statblocks are never merged), `endLabel` (stop at a
 * dedicated closing marker). Regardless of `boundary.kind`, the START of
 * the NEXT anchor is always an implicit hard cap — see
 * `pdf/detectStatblocks.ts`.
 */
const detectionConfigSchema = z.object({
  anchor: z
    .object({
      kind: z.enum(['textPattern', 'headingStyle']),
      pattern: z.string().optional(),
      patternIsRegex: z.boolean().optional(),
      styleFilter: styleFilterSchema.optional(),
    })
    .refine((anchor) => anchor.kind !== 'textPattern' || !!anchor.pattern, { message: "anchor kind:'textPattern' requires pattern" })
    .refine((anchor) => anchor.kind !== 'headingStyle' || !!anchor.styleFilter, { message: "anchor kind:'headingStyle' requires styleFilter" }),
  boundary: z
    .object({
      kind: z.enum(['nextAnchor', 'verticalGap', 'endOfColumnOrPage', 'endLabel']),
      /** Required when `kind === 'verticalGap'` — a gap (PDF points) between consecutive lines larger than this ends the candidate. */
      gapThreshold: z.number().positive().optional(),
      /** Required when `kind === 'endLabel'`. */
      endLabelPattern: z.string().optional(),
      endLabelIsRegex: z.boolean().optional(),
    })
    .refine((boundary) => boundary.kind !== 'verticalGap' || boundary.gapThreshold !== undefined, { message: "boundary kind:'verticalGap' requires gapThreshold" })
    .refine((boundary) => boundary.kind !== 'endLabel' || !!boundary.endLabelPattern, { message: "boundary kind:'endLabel' requires endLabelPattern" }),
  requiredLabels: z.array(requiredLabelSchema),
  pageRange: z.array(z.object({ from: z.number().int().positive(), to: z.number().int().positive().optional() })).optional(),
});

export const statblockProfileSchema = z.object({
  schemaVersion: z.literal(STATBLOCK_PROFILE_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  /** Metadata/hint only — NEVER a condition in code (never assume language). */
  language: z.string().optional(),

  /** e.g. "npc" — a string from the user's chosen system's own Actor subtypes. */
  actorType: z.string().min(1),
  /** UUID of the exemplar Actor in the world this profile was built from. */
  templateActorUuid: z.string().min(1),
  /** Hash of the Actor type's introspected schema at profile-build time — detects drift when the target system updates. */
  templateSchemaFingerprint: z.string().min(1),

  detection: detectionConfigSchema,
  /**
   * [Task 4] Where within a matched statblock instance the printed name
   * lives. Kept as its OWN top-level source rather than folded into
   * `fields[]` because `ProfileField.actorSchemaPath` is a dot path into
   * `actor.system` (per its own doc comment) and a Document's `name` is a
   * sibling of `system`, not a path inside it — reusing `FieldSource`'s
   * shape (the exact same label/region/styleFilter vocabulary as every
   * other captured value) rather than inventing a parallel mechanism.
   */
  nameSource: fieldSourceSchema,
  fields: z.array(profileFieldSchema),
  collections: z.array(profileCollectionSchema),
  valueMaps: z.array(valueMapSchema),

  /** When true, Actor fields NOT covered by `fields`/`collections` copy their value from `templateActorUuid` instead of being left unset. */
  inheritUnmappedFromTemplate: z.boolean(),
});

export type StatblockProfile = z.infer<typeof statblockProfileSchema>;
export type ProfileField = z.infer<typeof profileFieldSchema>;
export type ProfileFieldDataType = z.infer<typeof profileFieldDataTypeSchema>;
export type FieldCapture = z.infer<typeof fieldCaptureSchema>;
export type ProfileCollection = z.infer<typeof profileCollectionSchema>;
export type CollectionSplitRule = z.infer<typeof collectionSplitRuleSchema>;
export type ValueMap = z.infer<typeof valueMapSchema>;
export type DetectionConfig = z.infer<typeof detectionConfigSchema>;
export type RequiredLabel = z.infer<typeof requiredLabelSchema>;
export type StyleFilter = z.infer<typeof styleFilterSchema>;
export type NormalizedRect = z.infer<typeof normalizedRectSchema>;
export type LabelSource = z.infer<typeof labelSourceSchema>;
export type RegionSource = z.infer<typeof regionSourceSchema>;
export type StyleFilterSource = z.infer<typeof styleFilterSourceSchema>;
export type FieldSource = z.infer<typeof fieldSourceSchema>;
export type ProfileTransformStep = z.infer<typeof transformStepSchema>;

export interface ProfileValidationOk {
  ok: true;
  profile: StatblockProfile;
}
export interface ProfileValidationFailed {
  ok: false;
  /** Readable validation errors (field path + message) — never an exception. */
  issues: string[];
}
export type ProfileValidationResult = ProfileValidationOk | ProfileValidationFailed;

/** Validates untrusted JSON as a `StatblockProfile`. Never throws — a bad profile = `ok: false` + readable errors. */
export function validateProfile(input: unknown): ProfileValidationResult {
  const result = statblockProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}
