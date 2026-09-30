import type { Rect } from '../../geometry.js';
import type { Diagnostic } from '../../text/types.js';
import type { FieldExtractionResult } from '../extract/extractField.js';
import type { DetectionRegion } from '../pdf/types.js';

/**
 * [Task 4] One field's fully-resolved value for ONE statblock instance —
 * literally `extractField`'s own result type (Task 2), reused rather than
 * redefined: an `ExtractedValue` IS a `FieldExtractionResult`, nothing about
 * "building Actor data from it" needs a different shape.
 */
export type ExtractedValue = FieldExtractionResult;

/** One entry within a `ProfileCollection` — its own name plus its `itemFields`' values, scoped to the text span `splitCollectionEntries` carved out for it. */
export interface ExtractedCollectionEntry {
  sourceBbox: Rect;
  name: ExtractedValue;
  fieldValues: Record<string, ExtractedValue>;
}

/**
 * [Task 4] "From extraction results, builds Actor data" — the brief's own
 * words; this is that "extraction result", one per `DetectionCandidate`
 * (Task 3) that `import/extractInstance.ts` actually ran the field-
 * extraction engine (Task 2) over. Carries the candidate's own `regions`/
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
}

/** Plain data for one embedded Item, ready for `createEmbeddedDocuments('Item', [...])` — never a literal item type/path, both come from the profile's own `ProfileCollection`. */
export interface BuiltItemData {
  name: string;
  type: string;
  system: Record<string, unknown>;
}

/**
 * [Task 4] Plain data for one Actor, ready for `Actor.create()` — the
 * boundary between core's pure building/validation and the module layer's
 * actual Foundry document creation. `items` are built ALONGSIDE (not
 * created separately) so the module layer can choose to pass them straight
 * into `Actor.create({..., items})` in one call, per the brief's "razem z
 * Actorem" option.
 */
export interface BuiltActorData {
  name: string;
  type: string;
  img?: string;
  folder?: string;
  system: Record<string, unknown>;
  items: BuiltItemData[];
}

export type DuplicatePolicy = 'skip' | 'overwrite' | 'copy';

/** What `resolveDuplicateAction` decided to do about ONE instance, given whether an existing Actor with the same name was found. */
export type DuplicateAction = 'create' | 'update' | 'skip';

export interface ImportInstanceReport {
  instanceId: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  actorName: string;
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

/** Progress callback shape — same "postęp jako callback/event, bez blokowania UI" contract as `pdf/buildPagesForDetection.ts`/`buildImageExtraction.ts`. */
export interface ImportProgress {
  instancesProcessed: number;
  totalInstances: number;
}
