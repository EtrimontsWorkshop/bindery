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

const profileFieldSchema = z.object({
  id: z.string().min(1),
  /** Dot path into `actor.system`, discovered via schema introspection — never a literal in module code. */
  actorSchemaPath: z.string().min(1),
  dataType: profileFieldDataTypeSchema,
  capture: fieldCaptureSchema,
  /** Optional reference into `valueMaps[].id` for raw-text -> canonical-value conversion. */
  valueMapId: z.string().optional(),
});

const collectionSplitRuleSchema = z.object({
  kind: z.enum(['repeatingLinePattern', 'sectionHeaderThenEntries', 'fixedDelimiter']),
  /** e.g. locate a heading like "ATTACKS" (captured, never hardcoded), then treat each following entry until the next heading/anchor as one item. */
  sectionHeaderPattern: z.string().optional(),
  entryBoundaryPattern: z.string().optional(),
});

const profileCollectionSchema = z.object({
  id: z.string().min(1),
  /** e.g. "weapon" — a string from the user's chosen system's own Item subtypes. */
  itemType: z.string().min(1),
  /** UUID of an exemplar embedded Item on `templateActorUuid`, introspected the same way as the Actor itself. */
  templateItemUuid: z.string().min(1),
  splitRule: collectionSplitRuleSchema,
  /** Same shape as top-level `fields`, scoped to one collection entry. */
  itemFields: z.array(profileFieldSchema),
});

const valueMapSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['stripUnits', 'diceNotation', 'regexReplace', 'lookupTable']),
  params: z.record(z.string(), z.unknown()),
});

const detectionConfigSchema = z.object({
  // How to recognize "a new statblock starts here" while scanning the whole document.
  anchor: z.object({
    kind: z.enum(['labelPattern', 'fontRoleAndPattern', 'vectorFrame']),
    pattern: z.string().optional(),
    fontKey: z.string().optional(),
  }),
  // How to know where ONE statblock ends and the next begins.
  boundary: z.object({
    kind: z.enum(['nextAnchor', 'fixedLineCount', 'vectorFrame']),
  }),
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
