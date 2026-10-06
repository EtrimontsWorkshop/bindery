import type { Diagnostic } from '../../text/types.js';
import { castAndValidate } from '../extract/castAndValidate.js';
import { findDescriptor } from '../profile/validateAgainstSchema.js';
import type { ProfileField, StatblockProfile } from '../profile/schema.js';
import type { SchemaFieldDescriptor } from '../schema/types.js';
import { descriptorToConstraints, flattenLeafDescriptors } from './descriptorLookup.js';
import { getPath, setPath } from './setPath.js';
import type { BuiltActorData, BuiltItemData, ExtractedActorInstance, ExtractedValue } from './types.js';

/** Never a literal system name/term — plain English fallbacks for the rare case a statblock's own name couldn't be located at all (still imports the rest of the data rather than skipping the whole instance; the user can always rename after review). */
const FALLBACK_ACTOR_NAME = 'Unnamed';
const FALLBACK_ITEM_NAME = 'Unnamed Item';

export interface SchemaContext {
  /** The template Actor's introspected schema (`introspectDocumentInstance('Actor', ...)`), WITH `currentValue` attached — required for `inheritUnmappedFromTemplate`. */
  actorDescriptors: readonly SchemaFieldDescriptor[];
  /** Introspected schema per `ProfileCollection.id` (not `itemType` — two collections could share an item type but have different template items), from the collection's own `templateItemUuid`. Absent for a collection whose template item couldn't be resolved — degrades to "every item field unmapped" for that collection rather than throwing. */
  itemDescriptorsByCollectionId?: ReadonlyMap<string, readonly SchemaFieldDescriptor[]>;
  /**
   * Paths (relative to the Actor's `system`) of resource objects the system itself declares as having a current and a maximum part (`value`/`max`) — what Foundry calls a token bar. Supplied by the module layer from the system's own configuration, never guessed here. Used to keep the two parts consistent: when only one is mapped, the other gets the same number.
   */
  resourcePaths?: readonly string[];
}

export interface BuildActorDataOptions {
  folder?: string;
  img?: string;
}

export interface BuildActorDataResult {
  data: BuiltActorData;
  diagnostics: Diagnostic[];
}

function resolveName(extracted: ExtractedValue, fallback: string, diagnostics: Diagnostic[], pageNumber: number | undefined, code: string): string {
  if (typeof extracted.value === 'string' && extracted.value.trim().length > 0) return extracted.value;
  diagnostics.push({ severity: 'warning', code, pageNumber, params: { fallback } });
  return fallback;
}

/**
 * Assigns every `field.actorSchemaPath` this list of fields covers onto
 * `system`, casting/validating each value against the REAL target schema
 * (`descriptors`) via `castAndValidate` — reused a SECOND time here (extraction already ran it once, against the field's own bare `dataType`, at
 * extraction time): the first pass confirms the raw text parsed into
 * roughly the right JS shape, this pass confirms it actually fits the
 * LIVE Actor/Item schema's own min/max/choices, which the extraction phase
 * has no way to know. Returns the set of paths it touched, so the caller
 * can skip them when applying template inheritance afterwards.
 */
function applyFieldsToSystem(system: Record<string, unknown>, fields: readonly ProfileField[], valuesById: Record<string, ExtractedValue>, descriptors: readonly SchemaFieldDescriptor[] | undefined, diagnostics: Diagnostic[], pageNumber: number | undefined): Set<string> {
  const mappedPaths = new Set(fields.map((field) => field.actorSchemaPath));

  if (!descriptors) {
    if (fields.length > 0) diagnostics.push({ severity: 'error', code: 'STATBLOCK_IMPORT_SCHEMA_UNAVAILABLE', pageNumber, params: {} });
    return mappedPaths;
  }

  for (const field of fields) {
    const descriptor = findDescriptor(descriptors, field.actorSchemaPath);
    if (!descriptor) {
      diagnostics.push({ severity: 'error', code: 'STATBLOCK_IMPORT_PATH_NOT_FOUND', pageNumber, params: { field: field.actorSchemaPath } });
      continue;
    }
    const extracted = valuesById[field.id];
    if (!extracted || !extracted.found || extracted.value === undefined) {
      diagnostics.push({ severity: 'warning', code: 'STATBLOCK_IMPORT_FIELD_NOT_FOUND', pageNumber, params: { field: field.actorSchemaPath } });
      continue;
    }
    const { value, diagnostics: castDiagnostics } = castAndValidate(extracted.value, descriptorToConstraints(descriptor));
    for (const d of castDiagnostics) diagnostics.push({ ...d, pageNumber, params: { ...d.params, field: field.actorSchemaPath, raw: extracted.raw ?? '' } });
    if (value === undefined) continue;
    setPath(system, field.actorSchemaPath, value);
  }
  return mappedPaths;
}

/**
 * A resource's current and maximum parts belong together: a statblock prints one number ("HP 7") and a freshly imported creature should start full. When exactly one of the two was filled from the statblock, the other gets the same number — returns the paths it set, so template inheritance doesn't overwrite them.
 */
function completeResourcePairs(system: Record<string, unknown>, resourcePaths: readonly string[] | undefined, descriptors: readonly SchemaFieldDescriptor[] | undefined): Set<string> {
  const filled = new Set<string>();
  if (!resourcePaths || !descriptors) return filled;
  for (const base of resourcePaths) {
    const valuePath = `${base}.value`;
    const maxPath = `${base}.max`;
    const valueDescriptor = findDescriptor(descriptors, valuePath);
    const maxDescriptor = findDescriptor(descriptors, maxPath);
    if (valueDescriptor?.type !== 'number' || maxDescriptor?.type !== 'number') continue;
    const value = getPath(system, valuePath);
    const max = getPath(system, maxPath);
    if (typeof max === 'number' && value === undefined) {
      setPath(system, valuePath, max);
      filled.add(valuePath);
    } else if (typeof value === 'number' && max === undefined) {
      setPath(system, maxPath, value);
      filled.add(maxPath);
    }
  }
  return filled;
}

/** `inheritUnmappedFromTemplate`: every scalar leaf the profile did NOT map gets the template's own current value instead of being left unset. */
function applyTemplateInheritance(system: Record<string, unknown>, descriptors: readonly SchemaFieldDescriptor[] | undefined, mappedPaths: ReadonlySet<string>): void {
  if (!descriptors) return;
  for (const descriptor of flattenLeafDescriptors(descriptors)) {
    if (mappedPaths.has(descriptor.path) || descriptor.currentValue === undefined) continue;
    setPath(system, descriptor.path, descriptor.currentValue);
  }
}

/**
 * "From extraction results, builds Actor data" — pure, no Foundry:
 * takes ONE `ExtractedActorInstance` (from `extractStatblockInstance`)
 * plus the profile and a schema context (introspected descriptors the
 * MODULE layer fetched from the template Actor/Items) and returns plain
 * `BuiltActorData`, ready for `Actor.create({..., items})`, plus every
 * `Diagnostic` collected along the way. Never throws; a field that can't be
 * mapped/cast is skipped with a diagnostic, the rest of the instance still
 * builds — `importStatblocks` (module) decides what "too many errors to
 * import this one" means, this function always returns something.
 */
export function buildActorData(instance: ExtractedActorInstance, profile: StatblockProfile, schemaContext: SchemaContext, options: BuildActorDataOptions = {}): BuildActorDataResult {
  const diagnostics: Diagnostic[] = [];
  const pageNumber = instance.regions[0]?.pageNumber;

  const name = resolveName(instance.name, FALLBACK_ACTOR_NAME, diagnostics, pageNumber, 'STATBLOCK_IMPORT_NAME_NOT_FOUND');

  const system: Record<string, unknown> = {};
  const mappedPaths = applyFieldsToSystem(system, profile.fields, instance.fieldValues, schemaContext.actorDescriptors, diagnostics, pageNumber);
  for (const path of completeResourcePairs(system, schemaContext.resourcePaths, schemaContext.actorDescriptors)) mappedPaths.add(path);
  if (profile.inheritUnmappedFromTemplate) applyTemplateInheritance(system, schemaContext.actorDescriptors, mappedPaths);

  const items: BuiltItemData[] = [];
  for (const collection of profile.collections) {
    const itemDescriptors = schemaContext.itemDescriptorsByCollectionId?.get(collection.id);
    const entries = instance.collections[collection.id] ?? [];
    for (const entry of entries) {
      const itemName = resolveName(entry.name, FALLBACK_ITEM_NAME, diagnostics, pageNumber, 'STATBLOCK_IMPORT_ITEM_NAME_NOT_FOUND');
      const itemSystem: Record<string, unknown> = {};
      const itemMappedPaths = applyFieldsToSystem(itemSystem, collection.itemFields, entry.fieldValues, itemDescriptors, diagnostics, pageNumber);
      if (profile.inheritUnmappedFromTemplate) applyTemplateInheritance(itemSystem, itemDescriptors, itemMappedPaths);
      items.push({ name: itemName, type: collection.itemType, system: itemSystem });
    }
  }

  return {
    data: { name, type: profile.actorType, img: options.img, folder: options.folder, system, items },
    diagnostics,
  };
}
