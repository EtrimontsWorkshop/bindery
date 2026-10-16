import type { Diagnostic } from '../../text/types.js';
import { validateProfileAgainstSchema } from '../profile/validateAgainstSchema.js';
import type { StatblockProfile } from '../profile/schema.js';
import type { DetectionCandidate } from '../pdf/types.js';
import { computeSchemaFingerprint } from '../schema/computeSchemaFingerprint.js';
import { buildActorData, type BuildActorDataOptions, type SchemaContext } from './buildActorData.js';
import { extractStatblockInstance } from './extractInstance.js';
import type { BuiltActorData, ExtractedActorInstance, ExtractedValue } from './types.js';

export interface PreparedStatblock {
  instance: ExtractedActorInstance;
  data: BuiltActorData;
  /** Everything found out on the way to `data`: the profile against the current schema, extraction, casting and building. */
  diagnostics: Diagnostic[];
  /** `false` when any diagnostic is an error: such a statblock must not be written, because the Actor would be incomplete while the import reported success. */
  canImport: boolean;
}

/** Extraction results carry their own diagnostics; the ones that say something is wrong (not just "nothing found") are brought up to the level of the whole statblock. */
function extractionProblems(label: string, value: ExtractedValue, pageNumber: number | undefined): Diagnostic[] {
  return value.diagnostics.filter((d) => d.severity === 'error').map((d) => ({ ...d, pageNumber, params: { ...d.params, field: d.params?.['field'] ?? label } }));
}

/**
 * One statblock, from a detected candidate to the plain data of its Actor and Items, with every diagnostic of every step
 * and the verdict whether it may be written. The review preview and the import both run this and nothing else, so what
 * is previewed is what is imported. Pure: no Foundry, no I/O.
 */
export function prepareStatblock(candidate: DetectionCandidate, profile: StatblockProfile, schemaContext: SchemaContext, options: BuildActorDataOptions = {}): PreparedStatblock {
  const instance = extractStatblockInstance(candidate, profile);
  const built = buildActorData(instance, profile, schemaContext, options);
  const pageNumber = instance.regions[0]?.pageNumber;
  const diagnostics: Diagnostic[] = [];

  if (profile.templateSchemaFingerprint !== computeSchemaFingerprint(schemaContext.actorDescriptors)) {
    diagnostics.push({ severity: 'warning', code: 'STATBLOCK_IMPORT_SCHEMA_CHANGED', pageNumber, params: {} });
  }
  if (!candidate.meetsRequirements) {
    diagnostics.push({ severity: 'warning', code: 'STATBLOCK_IMPORT_REQUIRED_LABELS_MISSING', pageNumber, params: { labels: candidate.missingRequiredLabels.join(', ') } });
  }
  const itemSchemas = new Map(profile.collections.flatMap((c) => {
    const descriptors = schemaContext.itemDescriptorsByCollectionId?.get(c.id);
    return descriptors ? [[c.itemType, descriptors] as const] : [];
  }));
  for (const d of validateProfileAgainstSchema(profile, schemaContext.actorDescriptors, itemSchemas)) {
    // A path that is gone is reported by `buildActorData` as the field is built; a type that changed is only found here.
    if (d.code !== 'STATBLOCK_PROFILE_TYPE_MISMATCH') continue;
    diagnostics.push({ ...d, pageNumber });
  }

  diagnostics.push(...extractionProblems('name', instance.name, pageNumber));
  for (const field of profile.fields) {
    const value = instance.fieldValues[field.id];
    if (value) diagnostics.push(...extractionProblems(field.actorSchemaPath, value, pageNumber));
  }
  for (const collection of profile.collections) {
    for (const entry of instance.collections[collection.id] ?? []) {
      diagnostics.push(...extractionProblems(`${collection.id}.name`, entry.name, pageNumber));
      for (const field of collection.itemFields) {
        const value = entry.fieldValues[field.id];
        if (value) diagnostics.push(...extractionProblems(`${collection.id}.${field.actorSchemaPath}`, value, pageNumber));
      }
    }
  }
  diagnostics.push(...built.diagnostics);

  return { instance, data: built.data, diagnostics, canImport: !diagnostics.some((d) => d.severity === 'error') };
}
