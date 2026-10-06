import { attachCurrentValues, describeSchema, type SchemaFieldDescriptor, type SchemaFieldKind } from '@bindery/core';
import { toFieldLike } from './toFieldLike.js';

/**
 * Foundry-side glue for the SchemaIntrospector — everything here
 * touches `CONFIG`/`game`/`foundry.utils` and therefore lives in
 * `packages/module`, never `packages/core` (A1/`check:boundary`). The
 * actual recursive schema walk is `describeSchemaField` in
 * `packages/core` — this file's only job is: (1) find the right field
 * tree for a given document type, (2) adapt it to the duck-typed shape
 * core's walker expects, (3) apply the two things ONLY Foundry can answer
 * (localization, the system's declared `htmlFields` registry), (4) fall
 * back to `foundry.utils.flattenObject` when no `DataModel` exists at all
 * (older, `template.json`-only systems — degrade, don't fail).
 *
 * Sources, verified against `fvtt-types` (see the note about its Foundry-13-vs-14 pin in `toFieldLike.ts`):
 * - `game.system.documentTypes.Actor`/`.Item` — the CURRENT system's
 *   declared subtypes, keyed by type name, each with optional `htmlFields`
 *   (paths, relative to `system`, that the system marks as rich text even
 *   when the field class itself is a plain `StringField`).
 * - `CONFIG.Actor.dataModels`/`CONFIG.Item.dataModels` — the `DataModel`
 *   class registered for each subtype; `.schema` (a static getter) gives
 *   the root `SchemaField`.
 */

type DocumentTypeKey = 'Actor' | 'Item';

interface DataModelsConfig {
  dataModels?: Record<string, { schema?: unknown }>;
}

interface SystemDocumentTypes {
  documentTypes?: Partial<Record<DocumentTypeKey, Record<string, { htmlFields?: string[] }>>>;
}

function getDataModelSchema(kind: DocumentTypeKey, type: string): unknown | undefined {
  const config = CONFIG[kind] as DataModelsConfig | undefined;
  return config?.dataModels?.[type]?.schema;
}

function getHtmlFieldPaths(kind: DocumentTypeKey, type: string): readonly string[] {
  const system = game.system as unknown as SystemDocumentTypes | undefined;
  return system?.documentTypes?.[kind]?.[type]?.htmlFields ?? [];
}

/** Overrides `type: 'string'` to `type: 'html'` for every descriptor whose path is in `htmlPaths` — mutates in place. A field the system already typed as `HTMLField` is unaffected (already `'html'`, and never in this override list anyway). */
function applyHtmlFieldOverrides(descriptors: readonly SchemaFieldDescriptor[], htmlPaths: readonly string[]): void {
  if (htmlPaths.length === 0) return;
  const htmlPathSet = new Set(htmlPaths);
  const walk = (list: readonly SchemaFieldDescriptor[]): void => {
    for (const descriptor of list) {
      if (descriptor.type === 'string' && htmlPathSet.has(descriptor.path)) descriptor.type = 'html';
      if (descriptor.children) walk(descriptor.children);
    }
  };
  walk(descriptors);
}

/** `DataField.label` is a LOCALIZATION KEY on many systems, a plain string on others, or blank (in which case `describeSchemaField` already fell back to the path) — `game.i18n.localize` on a string that isn't a registered key just returns it unchanged, so this is always safe to call. */
function localizeLabels(descriptors: readonly SchemaFieldDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.label) descriptor.label = game.i18n!.localize(descriptor.label as never) || descriptor.label;
    if (descriptor.children) localizeLabels(descriptor.children);
  }
}

/** All Actor (or Item) subtypes the currently active system declares — the system-agnostic replacement for hardcoding a list of known types. */
export function listDocumentSubtypes(kind: DocumentTypeKey): string[] {
  const system = game.system as unknown as SystemDocumentTypes | undefined;
  return Object.keys(system?.documentTypes?.[kind] ?? {});
}

/**
 * Introspects a document TYPE (no live instance needed) via its registered
 * `DataModel`. Returns `null` when the system has no `DataModel` for this
 * type at all (a legacy `template.json`-only system) — the caller falls
 * back to `describeDocumentInstanceViaFallback` with a real document
 * instance in that case, since there is nothing to introspect without one.
 */
export function introspectDocumentType(kind: DocumentTypeKey, type: string): SchemaFieldDescriptor[] | null {
  const schema = getDataModelSchema(kind, type);
  if (!schema) return null;
  const descriptors = describeSchema(toFieldLike(schema));
  applyHtmlFieldOverrides(descriptors, getHtmlFieldPaths(kind, type));
  localizeLabels(descriptors);
  return descriptors;
}

const INTERNAL_LEADING_UNDERSCORE = (segment: string): boolean => segment.startsWith('_');

function inferPrimitiveKind(value: unknown): SchemaFieldKind {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'unsupported';
}

/**
 * Fallback for a system with no `DataModel` registered for this document's
 * type: flattens the REAL document's data (not just its schema — there is
 * no schema) and reports every `system.*` path found, typed by the actual
 * JS value at that path. Loses the richer metadata a real schema would
 * give (label/hint/choices/min/max) — a plain path + inferred primitive
 * type + current value is still usable, just less helpful (A7: degrade,
 * don't fail, rather than refuse to support the system at all).
 *
 * Only `system.*` keys are kept — Document-level fields (`_id`, `name`,
 * `ownership`, `flags`, ...) are never mappable targets, matching the
 * primary (`DataModel`) path, which only ever sees `actor.system`'s own
 * schema and never these fields in the first place. Any key with a
 * leading-underscore segment ANYWHERE in its remaining path (e.g. an
 * internal bookkeeping key nested inside `system`) is skipped too.
 */
export function describeDocumentInstanceViaFallback(doc: { toObject(): Record<string, unknown> }): SchemaFieldDescriptor[] {
  const flat = foundry.utils.flattenObject(doc.toObject()) as Record<string, unknown>;
  const descriptors: SchemaFieldDescriptor[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (!key.startsWith('system.')) continue;
    const path = key.slice('system.'.length);
    if (path.split('.').some(INTERNAL_LEADING_UNDERSCORE)) continue;
    descriptors.push({ path, label: path, type: inferPrimitiveKind(value), currentValue: value });
  }
  return descriptors;
}

export interface DocumentSchemaIntrospection {
  descriptors: SchemaFieldDescriptor[];
  /** `true` when no `DataModel` was found and `describeDocumentInstanceViaFallback` was used instead — the caller/UI should say so, not present degraded results as if they were the full picture. */
  usedFallback: boolean;
}

/**
 * The main entry point: given a LIVE document (an Actor or an embedded
 * Item the user pointed at as their exemplar), returns every mappable
 * field with its current value filled in. Tries the real `DataModel`
 * schema first; falls back to flattening the instance's own data when the
 * system doesn't register one.
 */
export function introspectDocumentInstance(kind: DocumentTypeKey, doc: { type: string; system: unknown; toObject(): Record<string, unknown> }): DocumentSchemaIntrospection {
  const byType = introspectDocumentType(kind, doc.type);
  if (byType) {
    attachCurrentValues(byType, doc.system);
    return { descriptors: byType, usedFallback: false };
  }
  return { descriptors: describeDocumentInstanceViaFallback(doc), usedFallback: true };
}

/** Every Item subtype the current system declares, with its introspected schema — the pool a profile author picks `ProfileCollection.itemType`/`templateItemUuid` from. Subtypes with no `DataModel` are omitted (nothing to show without a live exemplar instance — see `describeDocumentInstanceViaFallback` for that per-instance path instead). */
export function introspectAllItemTypes(): Record<string, SchemaFieldDescriptor[]> {
  const result: Record<string, SchemaFieldDescriptor[]> = {};
  for (const type of listDocumentSubtypes('Item')) {
    const descriptors = introspectDocumentType('Item', type);
    if (descriptors) result[type] = descriptors;
  }
  return result;
}
