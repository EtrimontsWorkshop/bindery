import {
  chooseExistingActor,
  countUnmarkedItems,
  originFlags,
  prepareStatblock,
  resolveDuplicateAction,
  selectItemsToReplace,
  type BuiltItemData,
  type DetectionCandidate,
  type DuplicatePolicy,
  type ImportProgress,
  type ImportReport,
  type SchemaContext,
  type StatblockOrigin,
  type StatblockProfile,
} from '@bindery/core';
import { MODULE_ID } from '../../settings.js';
import { introspectDocumentInstance } from '../schema/introspectActor.js';

/**
 * The Foundry-facing orchestrator — `Actor.create`/
 * `createEmbeddedDocuments`/`fromUuid`/`game.actors` all live ONLY here,
 * never in `packages/core` (`check:boundary`). Everything that decides
 * WHAT to write (`prepareStatblock` — extraction, building, validation —
 * `findNearestImage`, `resolveDuplicateAction`) is pure core code, already
 * unit-tested on hand-built mocks without Foundry; this file just calls them in order and performs
 * the actual document writes. Like `pdf/buildPagesForDetection.ts` before
 * it, this file has no automated test of its own — the same precedent
 * (`buildCIFFromDocument.ts` has none either) — verified manually in a live
 * world instead; the parts that decide which Items to keep and delete are plain functions below, tested on their own.
 */

export interface ImportStatblocksOptions {
  folder?: string;
  duplicatePolicy: DuplicatePolicy;
  /** Resolves the file path of the picture chosen for one statblock (by its candidate id) — it becomes the Actor's portrait and its token image. Omit, or return `undefined`, for an Actor without a picture. */
  resolveImagePath?: (candidateId: string) => Promise<string | undefined>;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

interface MinimalDocument {
  type: string;
  system: unknown;
  toObject(): Record<string, unknown>;
}

function toItemSource(item: BuiltItemData, profileId: string): Record<string, unknown> {
  return { name: item.name, type: item.type, system: item.system, flags: originFlags(MODULE_ID, { profileId, collectionId: item.collectionId, entryKey: item.entryKey } satisfies StatblockOrigin) };
}

async function resolveSchemaContext(profile: StatblockProfile): Promise<SchemaContext | null> {
  const templateActor = (await fromUuid(profile.templateActorUuid)) as MinimalDocument | null;
  if (!templateActor) return null;
  const { descriptors: actorDescriptors } = introspectDocumentInstance('Actor', templateActor);

  const itemDescriptorsByCollectionId = new Map<string, ReturnType<typeof introspectDocumentInstance>['descriptors']>();
  for (const collection of profile.collections) {
    const templateItem = (await fromUuid(collection.templateItemUuid)) as MinimalDocument | null;
    if (!templateItem) continue;
    itemDescriptorsByCollectionId.set(collection.id, introspectDocumentInstance('Item', templateItem).descriptors);
  }

  // The system's own declaration of which Actor attributes have a current and a maximum part (what Foundry shows as token bars), per Actor type.
  const trackable = (CONFIG.Actor as unknown as { trackableAttributes?: Record<string, { bar?: unknown[] } | undefined> }).trackableAttributes;
  const resourcePaths = (trackable?.[profile.actorType]?.bar ?? []).filter((path): path is string => typeof path === 'string');

  return { actorDescriptors, itemDescriptorsByCollectionId, resourcePaths };
}

/** The Actors an import could mean by "the same creature": same name and type, in the target folder when there is one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findExistingActors(name: string, type: string, folder: string | undefined): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((game.actors as any)?.filter?.((a: any) => a.name === name && a.type === type && (folder ? a.folder?.id === folder : true)) ?? []) as any[];
}

/**
 * Replaces, on an existing Actor, the Items an earlier import made, and updates the Actor. Nothing is deleted until the
 * new Items exist and the Actor was updated; when a write fails on the way, the new Items are taken back, so that a failure
 * leaves the Actor as it was rather than half-updated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateExistingActor(actor: any, profile: StatblockProfile, data: ReturnType<typeof prepareStatblock>['data']): Promise<{ keptUnmarked: number }> {
  const heldItems = (actor.items?.contents ?? Array.from(actor.items ?? [])) as { id: string; type: string; flags?: Record<string, unknown>; getFlag?: (s: string, k: string) => unknown }[];
  const toDelete = selectItemsToReplace(heldItems, profile.id, data.replaceableCollectionIds, MODULE_ID).map((i) => i.id);
  const sources = data.items.filter((i) => data.replaceableCollectionIds.includes(i.collectionId)).map((i) => toItemSource(i, profile.id));
  // Items of the profile's types that nobody marked are kept; counted so that the report can say so.
  const keptUnmarked = countUnmarkedItems(heldItems, new Set(profile.collections.map((c) => c.itemType)), MODULE_ID);

  let created: { id: string }[] = [];
  if (sources.length > 0) created = (await actor.createEmbeddedDocuments('Item', sources)) as { id: string }[];
  try {
    await actor.update({
      ...(data.img ? { img: data.img, prototypeToken: { texture: { src: data.img } } } : {}),
      ...(data.folder ? { folder: data.folder } : {}),
      system: data.system,
      flags: originFlags(MODULE_ID, { profileId: profile.id }),
    });
  } catch (err) {
    if (created.length > 0) await actor.deleteEmbeddedDocuments('Item', created.map((i) => i.id)).catch(() => undefined);
    throw err;
  }
  if (toDelete.length > 0) await actor.deleteEmbeddedDocuments('Item', toDelete);
  return { keptUnmarked };
}

/**
 * Imports the detected statblocks as Actors and returns a report, emitting progress as it goes. Never throws for a
 * single instance's own failure (an error creating/updating one Actor is
 * caught and reported per-instance, `status: 'error'`) — only an
 * `AbortSignal` or a completely unresolvable template Actor stop the whole
 * run early, both reported rather than left as an uncaught rejection. A statblock that has an error among its
 * diagnostics is not written at all: it is reported as failed with the diagnostics, instead of leaving an incomplete Actor behind a success.
 */
export async function importStatblocks(profile: StatblockProfile, candidates: readonly DetectionCandidate[], options: ImportStatblocksOptions): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, failed: 0, instances: [] };
  const schemaContext = await resolveSchemaContext(profile);
  if (!schemaContext) {
    for (const c of candidates) {
      report.failed++;
      report.instances.push({
        instanceId: c.id,
        status: 'error',
        actorName: '',
        pageNumber: c.regions[0]?.pageNumber,
        diagnostics: [{ severity: 'error', code: 'STATBLOCK_IMPORT_TEMPLATE_ACTOR_NOT_FOUND', params: { uuid: profile.templateActorUuid } }],
      });
    }
    return report;
  }

  const total = candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    checkAborted(options.signal);
    const c = candidates[i]!;
    let imagePath: string | undefined;
    try {
      imagePath = await options.resolveImagePath?.(c.id);
    } catch (err) {
      console.warn('Bindery | resolving the statblock image failed:', err);
    }
    const { instance, data, diagnostics, canImport } = prepareStatblock(c, profile, schemaContext, { folder: options.folder, img: imagePath });
    const pageNumber = instance.regions[0]?.pageNumber;

    if (!canImport) {
      report.failed++;
      report.instances.push({ instanceId: instance.id, status: 'error', actorName: data.name, pageNumber, diagnostics });
      options.onProgress?.({ instancesProcessed: i + 1, totalInstances: total });
      continue;
    }

    const matches = findExistingActors(data.name, data.type, options.folder);
    const existing = chooseExistingActor(matches, profile.id, MODULE_ID);
    const action = resolveDuplicateAction(existing !== undefined, options.duplicatePolicy);

    try {
      if (action === 'skip') {
        report.skipped++;
        report.instances.push({ instanceId: instance.id, status: 'skipped', actorName: data.name, pageNumber, diagnostics });
      } else if (action === 'update' && existing === null) {
        report.skipped++;
        report.instances.push({ instanceId: instance.id, status: 'skipped', actorName: data.name, pageNumber, diagnostics: [...diagnostics, { severity: 'warning', code: 'STATBLOCK_IMPORT_AMBIGUOUS_TARGET', pageNumber, params: { count: matches.length } }] });
      } else if (action === 'update' && existing) {
        const { keptUnmarked } = await updateExistingActor(existing, profile, data);
        const note: typeof diagnostics = keptUnmarked > 0 ? [{ severity: 'info', code: 'STATBLOCK_IMPORT_UNMARKED_ITEMS_KEPT', pageNumber, params: { count: keptUnmarked } }] : [];
        report.updated++;
        report.instances.push({ instanceId: instance.id, status: 'updated', actorName: data.name, actorUuid: existing.uuid, pageNumber, diagnostics: [...diagnostics, ...note] });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ActorCls = (foundry.documents as any).Actor ?? (globalThis as any).Actor;
        const created = await ActorCls.create({
          name: data.name,
          type: data.type,
          ...(data.img ? { img: data.img, prototypeToken: { texture: { src: data.img } } } : {}),
          folder: data.folder,
          system: data.system,
          items: data.items.map((item) => toItemSource(item, profile.id)),
          flags: originFlags(MODULE_ID, { profileId: profile.id }),
        });
        report.created++;
        report.instances.push({ instanceId: instance.id, status: 'created', actorName: data.name, actorUuid: created?.uuid, pageNumber, diagnostics });
      }
    } catch (err) {
      report.failed++;
      report.instances.push({
        instanceId: instance.id,
        status: 'error',
        actorName: data.name,
        pageNumber,
        diagnostics: [...diagnostics, { severity: 'error', code: 'STATBLOCK_IMPORT_WRITE_FAILED', params: { message: String(err) } }],
      });
    }

    options.onProgress?.({ instancesProcessed: i + 1, totalInstances: total });
    await Promise.resolve();
  }

  return report;
}
