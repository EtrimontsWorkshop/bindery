import type { Diagnostic } from '../../text/types.js';
import type { SchemaFieldDescriptor } from '../schema/types.js';
import type { ProfileCollection, ProfileField, StatblockProfile } from './schema.js';

/**
 * [Task 1] Checks a `StatblockProfile` against a LIVE schema tree (from
 * `describeSchema`/`attachCurrentValues`, already resolved by the module
 * layer for whatever system is actually installed right now) — this is a
 * SEPARATE, later check from `validateProfile` (structural validation of
 * the profile file itself): a profile can be perfectly well-formed JSON
 * and still reference a path the CURRENT system no longer has (the exact
 * scenario `templateSchemaFingerprint` exists to warn about).
 *
 * Pure: takes plain descriptor trees, not a live Foundry Actor — testable
 * with hand-built mock trees, no Foundry dependency.
 */

function findDescriptor(tree: readonly SchemaFieldDescriptor[], path: string): SchemaFieldDescriptor | undefined {
  for (const descriptor of tree) {
    if (descriptor.path === path) return descriptor;
    if (descriptor.children) {
      const found = findDescriptor(descriptor.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function checkField(field: ProfileField, tree: readonly SchemaFieldDescriptor[], contextLabel: string): Diagnostic[] {
  const descriptor = findDescriptor(tree, field.actorSchemaPath);
  if (!descriptor) {
    return [{ severity: 'error', code: 'STATBLOCK_PROFILE_PATH_NOT_FOUND', params: { path: field.actorSchemaPath, context: contextLabel } }];
  }
  if (descriptor.type !== field.dataType) {
    return [
      {
        severity: 'error',
        code: 'STATBLOCK_PROFILE_TYPE_MISMATCH',
        params: { path: field.actorSchemaPath, expected: field.dataType, actual: descriptor.type, context: contextLabel },
      },
    ];
  }
  return [];
}

function checkCollection(collection: ProfileCollection, itemSchemas: ReadonlyMap<string, readonly SchemaFieldDescriptor[]>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const itemTree = itemSchemas.get(collection.itemType);
  if (!itemTree) {
    diagnostics.push({ severity: 'error', code: 'STATBLOCK_PROFILE_ITEM_TYPE_NOT_FOUND', params: { itemType: collection.itemType, collectionId: collection.id } });
    return diagnostics;
  }
  for (const field of collection.itemFields) {
    diagnostics.push(...checkField(field, itemTree, `collection "${collection.id}"`));
  }
  return diagnostics;
}

/**
 * @param actorSchema The introspected schema tree for `profile.actorType` in the CURRENTLY installed system.
 * @param itemSchemas Introspected schema trees for every Item type referenced by `profile.collections`, keyed by `itemType`.
 */
export function validateProfileAgainstSchema(
  profile: StatblockProfile,
  actorSchema: readonly SchemaFieldDescriptor[],
  itemSchemas: ReadonlyMap<string, readonly SchemaFieldDescriptor[]>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const field of profile.fields) {
    diagnostics.push(...checkField(field, actorSchema, 'top-level field'));
  }
  for (const collection of profile.collections) {
    diagnostics.push(...checkCollection(collection, itemSchemas));
  }
  return diagnostics;
}
