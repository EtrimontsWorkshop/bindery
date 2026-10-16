import type { Rect } from '../../geometry.js';
import type { Diagnostic } from '../../text/types.js';
import type { FieldExtractionResult } from '../extract/extractField.js';
import type { DetectionRegion } from '../pdf/types.js';

/**
 * One field's fully-resolved value for ONE statblock instance —
 * literally `extractField`'s own result type, reused rather than
 * redefined: an `ExtractedValue` IS a `FieldExtractionResult`, nothing about
 * "building Actor data from it" needs a different shape.
 */
export type ExtractedValue = FieldExtractionResult;

/** One entry within a `ProfileCollection` — its own name plus its `itemFields`' values, scoped to the text span `splitCollectionEntries` carved out for it. */
export interface ExtractedCollectionEntry {
  /** Stable within the collection: the entry's own printed name (normalized) and how many entries of that name came before it. Identifies the entry between two imports of the same statblock, which the position in the list does not. */
  key: string;
  sourceBbox: Rect;
  name: ExtractedValue;
  fieldValues: Record<string, ExtractedValue>;
}

/**
 * The extraction result for one statblock — one per `DetectionCandidate` that `import/extractInstance.ts` actually ran the field-
 * extraction engine over. Carries the candidate's own `regions`/
 * `confidence` through unchanged — `importStatblocks` (module) can still
 * decide to skip a low-confidence instance without this module needing an
 * opinion on what threshold that is.
 */
export interface ExtractedActorInstance {
  id: string;
  regions: readonly DetectionRegion[];
  confidence: number;
  name: ExtractedValue;
  fieldValues: Record<string, ExtractedValue>;
  collections: Record<string, ExtractedCollectionEntry[]>;
  /** Ids of the collections whose text was not located in this statblock (see `CollectionSplitResult.sectionFound`) — unknown, not empty. */
  missingCollectionIds: string[];
}

/** Plain data for one embedded Item, ready for `createEmbeddedDocuments('Item', [...])` — never a literal item type/path, both come from the profile's own `ProfileCollection`. */
export interface BuiltItemData {
  name: string;
  type: string;
  system: Record<string, unknown>;
  /** `ProfileCollection.id` this Item came from, and the entry's stable key — what lets a later import tell its own Items from the ones a person added by hand. */
  collectionId: string;
  entryKey: string;
}

/**
 * Plain data for one Actor, ready for `Actor.create()` — the
 * boundary between core's pure building/validation and the module layer's
 * actual Foundry document creation. `items` are built ALONGSIDE (not
 * created separately) so the module layer can choose to pass them straight
 * into `Actor.create({..., items})` in one call.
 */
export interface BuiltActorData {
  name: string;
  type: string;
  img?: string;
  folder?: string;
  system: Record<string, unknown>;
  items: BuiltItemData[];
  /** Collections whose text was located, i.e. the ones an update may replace Items of. A collection that is not listed was not found in the statblock, and the Items already on the Actor stay. */
  replaceableCollectionIds: string[];
}

export type DuplicatePolicy = 'skip' | 'overwrite' | 'copy';

/** What `resolveDuplicateAction` decided to do about ONE instance, given whether an existing Actor with the same name was found. */
export type DuplicateAction = 'create' | 'update' | 'skip';

export interface ImportInstanceReport {
  instanceId: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  actorName: string;
  /** UUID of the created or updated Actor — absent for a skipped or failed instance. */
  actorUuid?: string;
  pageNumber?: number;
  diagnostics: Diagnostic[];
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  instances: ImportInstanceReport[];
}

/** Progress callback shape — same non-blocking callback contract as `pdf/buildPagesForDetection.ts`/`buildImageExtraction.ts`. */
export interface ImportProgress {
  instancesProcessed: number;
  totalInstances: number;
}
