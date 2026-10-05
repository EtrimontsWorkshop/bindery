import {
  buildActorData,
  extractStatblockInstance,
  findNearestImage,
  resolveDuplicateAction,
  type DetectionCandidate,
  type DuplicatePolicy,
  type ImageCandidate,
  type ImportProgress,
  type ImportReport,
  type SchemaContext,
  type StatblockProfile,
} from '@bindery/core';
import { introspectDocumentInstance } from '../schema/introspectActor.js';

/**
 * [Task 4] The Foundry-facing orchestrator — `Actor.create`/
 * `createEmbeddedDocuments`/`fromUuid`/`game.actors` all live ONLY here,
 * never in `packages/core` (A1/`check:boundary`). Everything that decides
 * WHAT to write (`extractStatblockInstance`, `buildActorData`,
 * `findNearestImage`, `resolveDuplicateAction`) is pure core code, already
 * unit-tested on hand-built mocks per the brief ("logika budowania danych i
 * walidacji bez Foundry"); this file just calls them in order and performs
 * the actual document writes. Like `pdf/buildPagesForDetection.ts` before
 * it, this file has no automated test of its own — the same precedent
 * (`buildCIFFromDocument.ts` has none either) — verified manually in a live
 * world instead; see PLAN.md's Task 4 section for the manual test script.
 */

export interface ImportStatblocksOptions {
  folder?: string;
  duplicatePolicy: DuplicatePolicy;
  /** Pre-extracted image candidates (e.g. from `buildInventory().images`, adapted by the caller) for the "nearest image" heuristic — omit to skip image assignment entirely. */
  images?: readonly ImageCandidate[];
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
 * "Funkcja `importStatblocks(profile, candidates, options)` zwracająca
 * raport i emitująca postęp" — the brief's own words. Never throws for a
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
    const imageId = options.images ? findNearestImage(instance.regions, options.images) : undefined;
    const { data, diagnostics } = buildActorData(instance, profile, schemaContext, { folder: options.folder, img: imageId });
    const pageNumber = instance.regions[0]?.pageNumber;

    const existing = findExistingActor(data.name, data.type, options.folder);
    const action = resolveDuplicateAction(!!existing, options.duplicatePolicy);

    try {
      if (action === 'skip') {
        report.skipped++;
        report.instances.push({ instanceId: instance.id, status: 'skipped', actorName: data.name, pageNumber, diagnostics });
      } else if (action === 'update' && existing) {
        await existing.update({ img: data.img, folder: data.folder, system: data.system });
        await replaceManagedItems(existing, profile, data.items);
        report.updated++;
        report.instances.push({ instanceId: instance.id, status: 'updated', actorName: data.name, pageNumber, diagnostics });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ActorCls = (foundry.documents as any).Actor ?? (globalThis as any).Actor;
        await ActorCls.create({ name: data.name, type: data.type, img: data.img, folder: data.folder, system: data.system, items: data.items });
        report.created++;
        report.instances.push({ instanceId: instance.id, status: 'created', actorName: data.name, pageNumber, diagnostics });
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
