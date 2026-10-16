import type { Rect } from '../../geometry.js';
import { extractField } from '../extract/extractField.js';
import type { LabelContext } from '../extract/sources/labelSource.js';
import type { ExtractionBlock } from '../extract/types.js';
import type { DetectionCandidate } from '../pdf/types.js';
import type { FieldSource, ProfileCollection, ProfileField, StatblockProfile } from '../profile/schema.js';
import { resolveTransformChain } from './resolveTransformChain.js';
import { splitCollectionEntriesDetailed } from './splitCollectionEntries.js';
import type { ExtractedActorInstance, ExtractedCollectionEntry, ExtractedValue } from './types.js';

const ZERO_RECT: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
/** Always applied to the printed name, not configurable — a plain, universal cleanup rather than a fully custom chain (see `extractStatblockInstance`'s own comment for why). */
const NAME_TRANSFORMS = [{ kind: 'trim' as const }, { kind: 'normalizeWhitespace' as const }];

function extractOneField(block: ExtractionBlock, field: ProfileField, profile: Pick<StatblockProfile, 'valueMaps'>, context: LabelContext): ExtractedValue {
  if (!field.source) {
    return { found: false, raw: null, value: undefined, sourceBbox: null, diagnostics: [{ severity: 'info', code: 'STATBLOCK_FIELD_NO_SOURCE', params: { fieldId: field.id } }] };
  }
  const { chain, diagnostics: chainDiagnostics } = resolveTransformChain(field, profile);
  const result = extractField(block, field.source, chain, { dataType: field.dataType }, context);
  return { ...result, diagnostics: [...chainDiagnostics, ...result.diagnostics] };
}

function extractFieldValues(block: ExtractionBlock, fields: readonly ProfileField[], profile: Pick<StatblockProfile, 'valueMaps'>, context: LabelContext): Record<string, ExtractedValue> {
  const result: Record<string, ExtractedValue> = {};
  for (const field of fields) result[field.id] = extractOneField(block, field, profile, context);
  return result;
}

/** Every printed label a profile looks for, so that a value can stop where the next one begins. */
function labelsOf(sources: readonly (FieldSource | undefined)[], required: readonly { pattern: string; isRegex: boolean }[] = []): LabelContext {
  const labels = required.map((l) => ({ pattern: l.pattern, isRegex: l.isRegex }));
  for (const source of sources) if (source?.kind === 'label' && source.labelPattern !== '') labels.push({ pattern: source.labelPattern, isRegex: source.labelIsRegex });
  return { otherLabels: labels };
}

function normalizeKeyPart(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractCollectionEntries(block: ExtractionBlock, collection: ProfileCollection, profile: Pick<StatblockProfile, 'valueMaps'>): { entries: ExtractedCollectionEntry[]; sectionFound: boolean } {
  const { entries: entryBlocks, sectionFound } = splitCollectionEntriesDetailed(block, collection.splitRule);
  const context = labelsOf([collection.nameSource, ...collection.itemFields.map((f) => f.source)]);
  const seen = new Map<string, number>();
  const entries = entryBlocks.map((entryBlock, index) => {
    const name = extractField(entryBlock, collection.nameSource, NAME_TRANSFORMS, { dataType: 'string' }, context);
    const printed = typeof name.value === 'string' ? normalizeKeyPart(name.value) : '';
    const base = printed === '' ? `entry-${index}` : printed;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return { key: `${base}#${ordinal}`, sourceBbox: entryBlock.bbox, name, fieldValues: extractFieldValues(entryBlock, collection.itemFields, profile, context) };
  });
  return { entries, sectionFound };
}

/**
 * Turns one `DetectionCandidate` into a fully-extracted
 * `ExtractedActorInstance` by running the field-extraction engine over
 * it for real — the piece detection deliberately leaves undone
 * (`computeCandidateConfidence` only checks LOCATABILITY, not actual cast
 * values; `ProfileField.transforms` now closes that gap). Lives in `import/`, not `extract/` or `pdf/`,
 * because it depends on BOTH (`DetectionCandidate` from `pdf/`, the
 * extraction primitives from `extract/`) — putting it in either of those
 * would create a dependency cycle.
 *
 * Uses `candidate.regions[0]` as the single `ExtractionBlock` bbox for
 * every region-based source, collections included — the same precedent
 * `pdf/detectStatblocks.ts` already set for `computeCandidateConfidence`
 * (a candidate spanning multiple pages/columns has no single meaningful
 * union bbox across pages; the first region is "where the statblock
 * starts", the most useful anchor for a region source).
 */
export function extractStatblockInstance(candidate: DetectionCandidate, profile: StatblockProfile): ExtractedActorInstance {
  const block: ExtractionBlock = { bbox: candidate.regions[0]?.bbox ?? ZERO_RECT, elements: candidate.elements };
  const context = labelsOf([profile.nameSource, ...profile.fields.map((f) => f.source)], profile.detection.requiredLabels);

  const name = extractField(block, profile.nameSource, NAME_TRANSFORMS, { dataType: 'string' }, context);

  const fieldValues = extractFieldValues(block, profile.fields, profile, context);

  const collections: Record<string, ExtractedCollectionEntry[]> = {};
  const missingCollectionIds: string[] = [];
  for (const collection of profile.collections) {
    const { entries, sectionFound } = extractCollectionEntries(block, collection, profile);
    collections[collection.id] = entries;
    if (!sectionFound) missingCollectionIds.push(collection.id);
  }

  return {
    id: candidate.id,
    regions: candidate.regions,
    confidence: candidate.confidence,
    name,
    fieldValues,
    collections,
    missingCollectionIds,
  };
}
