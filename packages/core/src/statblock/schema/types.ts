/**
 * [Statblock import, Task 1] Duck-typed shape matching a real Foundry
 * `foundry.data.fields.DataField` instance closely enough to walk it
 * generically — the same "verified empirically, zero import of the real
 * class" pattern as `PdfTextItemLike` in `text/types.ts` for pdf.js. Zero
 * dependency on Foundry globals (A1/`check:boundary`): the module layer
 * builds these from real field instances via `field.constructor.name` +
 * the handful of properties every field subclass actually carries at
 * runtime (verified against `fvtt-types` for Foundry v14: `SchemaField`,
 * `NumberField`, `StringField`, `HTMLField`, `ArrayField`, `BooleanField`,
 * etc. — see `packages/module/src/statblock/schema/toFieldLike.ts`).
 *
 * `choices`/`initial` are pre-resolved to concrete values (or left
 * `undefined`) by the caller BEFORE reaching this shape — a Foundry field's
 * `choices`/`initial` can themselves be functions, and only the module
 * layer (which has the live field instance and, for `initial`, a data
 * context to call it with) can safely resolve that. Core never calls a
 * function it didn't define.
 */
export interface FoundryFieldLike {
  /** `field.constructor.name`, e.g. `"NumberField"`, `"SchemaField"`. */
  className: string;
  label?: string;
  hint?: string;
  readonly?: boolean;
  /** Already resolved from a function/array/record, never itself a function. */
  choices?: readonly (string | number)[] | Record<string | number, string>;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Already resolved (or `undefined` if the field's `initial` was a function the caller chose not to invoke). */
  initial?: unknown;
  /** Present when this field is schema-shaped (`SchemaField`/`EmbeddedDataField`) — its nested fields. */
  fields?: Record<string, FoundryFieldLike>;
  /** Present when this field is a collection (`ArrayField`/`SetField`/`EmbeddedCollectionField`) — the shape of ONE element. */
  element?: FoundryFieldLike;
}

/**
 * [Task 1] The taxonomy exposed to the profile-building UI (per the brief,
 * verbatim: "string, number, boolean, html, choices, array, object").
 * `'choices'` takes priority over the field's base primitive type — a
 * `NumberField` or `StringField` WITH `choices` set is reported as
 * `'choices'`, not `'number'`/`'string'`, because that's the more useful
 * fact for a profile author picking a mapping target. `'unsupported'` is
 * for field classes with no sane generic representation (e.g.
 * `JavaScriptField`) — surfaced so the UI can grey them out instead of
 * silently omitting them (A7-style: degrade visibly, don't disappear).
 */
export type SchemaFieldKind = 'string' | 'number' | 'boolean' | 'html' | 'choices' | 'array' | 'object' | 'unsupported';

export interface SchemaFieldChoice {
  value: string | number;
  label: string;
}

/**
 * [Task 1] One mappable field, flattened to a dot path relative to
 * `actor.system` (never including the `"system."` prefix itself — every
 * consumer already knows it's scoped to `system`, the same convention the
 * old, now-deleted CoC7 adapter used for its own canonical keys). Produced
 * by `describeSchemaField` (pure, this package) from a `FoundryFieldLike`
 * tree, then enriched by the module layer with `currentValue` (needs a
 * live Actor instance) and localization (needs `game.i18n`).
 */
export interface SchemaFieldDescriptor {
  /** Dot path into `actor.system`, e.g. `"attributes.hp.value"`. `''` only for the synthetic root node. */
  path: string;
  /** Localized where possible; falls back to `path` when the field's own `label` is blank (common — many systems rely on i18n keys resolved elsewhere, not `DataField.label`). */
  label: string;
  type: SchemaFieldKind;
  choices?: SchemaFieldChoice[];
  min?: number;
  max?: number;
  integer?: boolean;
  initial?: unknown;
  /** Filled in by `attachCurrentValues` (this package) from a template Actor's live `system` data — `undefined` until that pass runs. */
  currentValue?: unknown;
  /** Nested fields (object-shaped) or the shape of one element (array-shaped). Absent for scalar leaves. */
  children?: SchemaFieldDescriptor[];
}
