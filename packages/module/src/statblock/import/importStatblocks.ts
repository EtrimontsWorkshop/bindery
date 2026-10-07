import {
  buildActorData,
  extractStatblockInstance,
  resolveDuplicateAction,
  type DetectionCandidate,
  type DuplicatePolicy,
  type ImportProgress,
  type ImportReport,
  type SchemaContext,
  type StatblockProfile,
} from '@bindery/core';
import { introspectDocumentInstance } from '../schema/introspectActor.js';

/**
 * The Foundry-facing orchestrator — `Actor.create`/
 * `createEmbeddedDocuments`/`fromUuid`/`game.actors` all live ONLY here,
 * never in `packages/core` (`check:boundary`). Everything that decides
 * WHAT to write (`extractStatblockInstance`, `buildActorData`,
 * `findNearestImage`, `resolveDuplicateAction`) is pure core code, already
 * unit-tested on hand-built mocks without Foundry; this file just calls them in order and performs
 * the actual document writes. Like `pdf/buildPagesForDetection.ts` before
 * it, this file has no automated test of its own — the same precedent
 * (`buildCIFFromDocument.ts` has none either) — verified manually in a live
 * world instead.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findExistingActor(name: string, type: string, folder: string | undefined): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (game.actors as any)?.find((a: any) => a.name === name && a.type === type && (folder ? a.folder?.id === folder : true));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replaceManagedItems(actor: any, profile: StatblockProfile, items: readonly { name: string; type: string; system: Record<string, unknown> }[]): Promise<void> {
  const managedTypes = new Set(profile.collections.map((c) => c.itemType));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toDelete = (actor.items?.filter((it: any) => managedTypes.has(it.type)).map((it: any) => it.id) ?? []) as string[];
  if (toDelete.length > 0) await actor.deleteEmbeddedDocuments('Item', toDelete);
  if (items.length > 0) await actor.createEmbeddedDocuments('Item', items);
}

/**
 * Imports the detected statblocks as Actors and returns a report, emitting progress as it goes. Never throws for a
 * single instance's own failure (an error creating/updating one Actor is
 * caught and reported per-instance, `status: 'error'`) — only an
 * `AbortSignal` or a completely unresolvable template Actor stop the whole
 * run early, both reported rather than left as an uncaught rejection.
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
    const instance = extractStatblockInstance(c, profile);
    let imagePath: string | undefined;
    try {
      imagePath = await options.resolveImagePath?.(c.id);
    } catch (err) {
      console.warn('Bindery | resolving the statblock image failed:', err);
    }
    const { data, diagnostics } = buildActorData(instance, profile, schemaContext, { folder: options.folder, img: imagePath });
    const pageNumber = instance.regions[0]?.pageNumber;

    const existing = findExistingActor(data.name, data.type, options.folder);
    const action = resolveDuplicateAction(!!existing, options.duplicatePolicy);

    try {
      if (action === 'skip') {
        report.skipped++;
        report.instances.push({ instanceId: instance.id, status: 'skipped', actorName: data.name, pageNumber, diagnostics });
      } else if (action === 'update' && existing) {
        await existing.update({ ...(data.img ? { img: data.img, prototypeToken: { texture: { src: data.img } } } : {}), folder: data.folder, system: data.system });
        await replaceManagedItems(existing, profile, data.items);
        report.updated++;
        report.instances.push({ instanceId: instance.id, status: 'updated', actorName: data.name, actorUuid: existing.uuid, pageNumber, diagnostics });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ActorCls = (foundry.documents as any).Actor ?? (globalThis as any).Actor;
        const created = await ActorCls.create({
          name: data.name,
          type: data.type,
          ...(data.img ? { img: data.img, prototypeToken: { texture: { src: data.img } } } : {}),
          folder: data.folder,
          system: data.system,
          items: data.items,
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
