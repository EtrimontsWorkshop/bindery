import type { FoundryFieldLike, SchemaFieldChoice, SchemaFieldDescriptor, SchemaFieldKind } from './types.js';

/**
 * Field-class-name -> kind lookup, one entry per `FoundryFieldLike.className`
 * this project has actually seen in `fvtt-types` for Foundry v14's
 * `foundry.data.fields.*`. Deliberately a closed map, not a heuristic:
 * an unrecognized class name falls through to `'unsupported'` rather than
 * guessing (A7 — degrade visibly).
 *
 * Schema-shaped and array-shaped classes are handled separately in
 * `describeSchemaField` (via `field.fields`/`field.element`, not via this
 * map), because the SAME class name can carry either a scalar or a
 * container depending on `field.choices` — see the `'choices'` override
 * below.
 */
const PRIMITIVE_KIND_BY_CLASS_NAME: Record<string, SchemaFieldKind> = {
  BooleanField: 'boolean',
  NumberField: 'number',
  AngleField: 'number',
  AlphaField: 'number',
  HueField: 'number',
  IntegerSortField: 'number',
  HTMLField: 'html',
  StringField: 'string',
  FilePathField: 'string',
  ColorField: 'string',
  DocumentIdField: 'string',
  DocumentUUIDField: 'string',
  ForeignDocumentField: 'string',
  ObjectField: 'object',
  TypedObjectField: 'object',
  JSONField: 'object',
};

/**
 * `choices` on a real Foundry field can be an array, a
 * `Record<value, label>`, or a zero-arg function returning either — the
 * module layer resolves the function BEFORE building a `FoundryFieldLike`
 * (core never calls functions it didn't define), so here we only need to
 * normalize the two resolved shapes into `SchemaFieldChoice[]`.
 */
function normalizeChoices(choices: FoundryFieldLike['choices']): SchemaFieldChoice[] {
  if (!choices) return [];
  if (Array.isArray(choices)) return choices.map((value) => ({ value, label: String(value) }));
  return Object.entries(choices).map(([value, label]) => ({ value, label: String(label) }));
}

function classifyFieldKind(field: FoundryFieldLike): SchemaFieldKind {
  if (field.choices !== undefined) return 'choices';
  if (field.className === 'SchemaField' || field.className === 'EmbeddedDataField') return 'object';
  if (field.className === 'ArrayField' || field.className === 'SetField' || field.className === 'EmbeddedCollectionField') return 'array';
  return PRIMITIVE_KIND_BY_CLASS_NAME[field.className] ?? 'unsupported';
}

/**
 * Recursively walks a `FoundryFieldLike` tree into the flat,
 * UI-facing `SchemaFieldDescriptor` shape. Pure — no Foundry dependency,
 * no I/O, no live Actor data (see `attachCurrentValues` for that separate
 * pass). `readonly` fields are skipped entirely at the point they'd be
 * added as a child (derived/read-only fields are not mappable) — a
 * `readonly` field's value is computed elsewhere (`prepareDerivedData`),
 * never something a PDF-derived value should be written into.
 *
 * `path` is the dot path to THIS field already (relative to `actor.system`,
 * `''` for the synthetic root); children get `path.childKey` unless `path`
 * is empty, in which case they start fresh at `childKey`.
 */
export function describeSchemaField(field: FoundryFieldLike, path: string): SchemaFieldDescriptor {
  const type = classifyFieldKind(field);
  const descriptor: SchemaFieldDescriptor = {
    path,
    label: field.label?.trim() || path,
    type,
  };
  if (field.min !== undefined) descriptor.min = field.min;
  if (field.max !== undefined) descriptor.max = field.max;
  if (field.integer !== undefined) descriptor.integer = field.integer;
  if (field.initial !== undefined) descriptor.initial = field.initial;
  if (type === 'choices') descriptor.choices = normalizeChoices(field.choices);

  if (field.fields) {
    descriptor.children = Object.entries(field.fields)
      .filter(([, child]) => !child.readonly)
      .map(([key, child]) => describeSchemaField(child, path ? `${path}.${key}` : key));
  } else if (field.element) {
    // The shape of ONE array element, not one descriptor per actual element
    // (there is no "actual data" here — this is schema, not an instance).
    // Represented as a single synthetic child so the UI can show "this is
    // a list of <shape>" without special-casing arrays-of-scalars vs
    // arrays-of-objects at the call site.
    descriptor.children = [describeSchemaField(field.element, path)];
  }

  return descriptor;
}

/**
 * Convenience entry point for a whole Actor/Item type's schema:
 * unwraps the synthetic root's children directly, since callers never want
 * a descriptor FOR the root itself (it has no meaningful path/label/type).
 */
export function describeSchema(rootField: FoundryFieldLike): SchemaFieldDescriptor[] {
  return describeSchemaField(rootField, '').children ?? [];
}
