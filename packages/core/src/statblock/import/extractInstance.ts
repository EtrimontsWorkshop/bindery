import type { Rect } from '../../geometry.js';
import { extractField } from '../extract/extractField.js';
import type { ExtractionBlock } from '../extract/types.js';
import type { DetectionCandidate } from '../pdf/types.js';
import type { ProfileCollection, ProfileField, StatblockProfile } from '../profile/schema.js';
import { resolveTransformChain } from './resolveTransformChain.js';
import { splitCollectionEntries } from './splitCollectionEntries.js';
import type { ExtractedActorInstance, ExtractedCollectionEntry, ExtractedValue } from './types.js';

const ZERO_RECT: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
/** Always applied to the printed name, not configurable — a plain, universal cleanup rather than a fully custom chain (see `extractStatblockInstance`'s own comment for why). */
const NAME_TRANSFORMS = [{ kind: 'trim' as const }, { kind: 'normalizeWhitespace' as const }];

function extractOneField(block: ExtractionBlock, field: ProfileField, profile: Pick<StatblockProfile, 'valueMaps'>): ExtractedValue {
  if (!field.source) {
    return { found: false, raw: null, value: undefined, sourceBbox: null, diagnostics: [{ severity: 'info', code: 'STATBLOCK_FIELD_NO_SOURCE', params: { fieldId: field.id } }] };
  }
  const { chain, diagnostics: chainDiagnostics } = resolveTransformChain(field, profile);
  const result = extractField(block, field.source, chain, { dataType: field.dataType });
  return { ...result, diagnostics: [...chainDiagnostics, ...result.diagnostics] };
}

function extractFieldValues(block: ExtractionBlock, fields: readonly ProfileField[], profile: Pick<StatblockProfile, 'valueMaps'>): Record<string, ExtractedValue> {
  const result: Record<string, ExtractedValue> = {};
  for (const field of fields) result[field.id] = extractOneField(block, field, profile);
  return result;
}

function extractCollectionEntries(block: ExtractionBlock, collection: ProfileCollection, profile: Pick<StatblockProfile, 'valueMaps'>): ExtractedCollectionEntry[] {
  const entryBlocks = splitCollectionEntries(block, collection.splitRule);
  return entryBlocks.map((entryBlock) => ({
    sourceBbox: entryBlock.bbox,
    name: extractField(entryBlock, collection.nameSource, NAME_TRANSFORMS, { dataType: 'string' }),
    fieldValues: extractFieldValues(entryBlock, collection.itemFields, profile),
  }));
}

/**
 * [Task 4] Turns one Task 3 `DetectionCandidate` into a fully-extracted
 * `ExtractedActorInstance` by running Task 2's field-extraction engine over
 * it for real — the piece Task 3 deliberately left undone
 * (`computeCandidateConfidence` only checks LOCATABILITY, not actual cast
 * values; see PLAN.md's Task 3 question #17, now closed by `transforms`
 * existing on `ProfileField`). Lives in `import/`, not `extract/` or `pdf/`,
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

  const name = extractField(block, profile.nameSource, NAME_TRANSFORMS, { dataType: 'string' });

  const fieldValues = extractFieldValues(block, profile.fields, profile);

  const collections: Record<string, ExtractedCollectionEntry[]> = {};
  for (const collection of profile.collections) {
    collections[collection.id] = extractCollectionEntries(block, collection, profile);
  }

  return {
    id: candidate.id,
    regions: candidate.regions,
    confidence: candidate.confidence,
    name,
    fieldValues,
    collections,
  };
}
