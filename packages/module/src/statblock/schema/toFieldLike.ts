import type { FoundryFieldLike } from '@bindery/core';

/**
 * Runtime shape of a `foundry.data.fields.DataField`
 * instance — the handful of properties every field subclass ACTUALLY
 * carries at runtime (verified against `fvtt-types`'
 * `foundry/common/data/fields.d.mts`: `SchemaField.fields`, `ArrayField.element`,
 * `NumberField.min/max/integer`, `DataField.label/hint/readonly`,
 * `StringField.choices`). Declared locally instead of importing the real
 * (heavily generic, awkward to hold in a plain variable) Foundry field
 * classes — the same "duck-type the real thing, verified empirically"
 * choice as `PdfTextItemLike` for pdf.js in `packages/core`. The ONE cast
 * from a real field to this shape lives in `toFieldLike` below, matching
 * the "one conversion function, not scattered `as` casts" convention
 * already established for `pageOverlayGeometry.ts`.
 *
 * NOTE: `fvtt-types`
 * in this repo is pinned to Foundry 13 typings while `module.json` declares
 * a Foundry 14 minimum. This runtime shape has been stable across that
 * boundary in every Foundry release so far, but it hasn't been verified
 * against a real v14 install yet — do that before relying on this in a
 * live world.
 */
interface RuntimeDataField {
  constructor: { name: string };
  label?: string;
  hint?: string;
  readonly?: boolean;
  choices?: unknown;
  min?: number;
  max?: number;
  integer?: boolean;
  initial?: unknown;
  fields?: Record<string, RuntimeDataField>;
  element?: RuntimeDataField;
}

/**
 * A field's `choices`/`initial` can themselves be zero-arg functions on the
 * real Foundry field (`NumberField.choices`, `DataField.Options.InitialType`)
 * — resolved HERE, at the one place with a live field instance, so
 * `packages/core`'s pure `describeSchemaField` never needs to call a
 * function it didn't define.
 */
function resolveMaybeFunction<T>(value: T | (() => T) | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T)() : value;
}

/** Converts a real (or real-enough) Foundry `DataField` into the duck-typed shape `packages/core`'s pure walker consumes. */
export function toFieldLike(field: unknown): FoundryFieldLike {
  const f = field as RuntimeDataField;
  const result: FoundryFieldLike = { className: f.constructor?.name ?? 'Unknown' };
  if (f.label !== undefined) result.label = f.label;
  if (f.hint !== undefined) result.hint = f.hint;
  if (f.readonly !== undefined) result.readonly = f.readonly;
  if (f.min !== undefined) result.min = f.min;
  if (f.max !== undefined) result.max = f.max;
  if (f.integer !== undefined) result.integer = f.integer;

  const choices = resolveMaybeFunction(f.choices as unknown);
  if (choices !== undefined) result.choices = choices as FoundryFieldLike['choices'];

  const initial = resolveMaybeFunction(f.initial);
  if (initial !== undefined) result.initial = initial;

  if (f.fields) {
    result.fields = Object.fromEntries(Object.entries(f.fields).map(([key, child]) => [key, toFieldLike(child)]));
  }
  if (f.element) {
    result.element = toFieldLike(f.element);
  }
  return result;
}
