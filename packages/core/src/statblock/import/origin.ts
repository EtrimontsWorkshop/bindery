/**
 * Which Items and Actors an import made, as opposed to the ones a person added by hand. An import records where each
 * Item came from (profile, collection, entry) in a flag of its own scope; a later import deletes only what that record
 * says is its own. Pure: the documents are read through two optional members that Foundry documents have, so this is
 * testable on plain objects.
 */

export interface StatblockOrigin {
  profileId: string;
  collectionId?: string;
  entryKey?: string;
}

export interface FlaggedDocument {
  id?: string;
  flags?: Record<string, unknown> | undefined;
  getFlag?: ((scope: string, key: string) => unknown) | undefined;
}

/** Key of the flag, inside the scope the caller owns. */
export const STATBLOCK_ORIGIN_FLAG = 'statblock';

/** The origin recorded on a document by an earlier import, or `undefined` for one that was made by hand (or by a version that recorded nothing). */
export function readOrigin(document: FlaggedDocument, scope: string): StatblockOrigin | undefined {
  const raw = document.getFlag ? document.getFlag(scope, STATBLOCK_ORIGIN_FLAG) : (document.flags?.[scope] as Record<string, unknown> | undefined)?.[STATBLOCK_ORIGIN_FLAG];
  if (raw && typeof raw === 'object' && typeof (raw as StatblockOrigin).profileId === 'string') return raw as StatblockOrigin;
  return undefined;
}

/** The `flags` object to write on a new document. */
export function originFlags(scope: string, origin: StatblockOrigin): Record<string, unknown> {
  return { [scope]: { [STATBLOCK_ORIGIN_FLAG]: origin } };
}

/**
 * The Items of an Actor that an update may delete: the ones an earlier import of THIS profile made, from a collection
 * the new statblock actually has (a collection that was not found in it says nothing about what the Actor should hold).
 * Everything else — Items added by hand, Items of another profile, Items made before origins were recorded — stays.
 */
export function selectItemsToReplace<T extends FlaggedDocument>(items: readonly T[], profileId: string, replaceableCollectionIds: readonly string[], scope: string): T[] {
  const replaceable = new Set(replaceableCollectionIds);
  return items.filter((item) => {
    const origin = readOrigin(item, scope);
    return origin !== undefined && origin.profileId === profileId && origin.collectionId !== undefined && replaceable.has(origin.collectionId);
  });
}

/** How many of the Items of the given types nobody marked — the ones an update keeps, which the report mentions. */
export function countUnmarkedItems(items: readonly (FlaggedDocument & { type: string })[], managedTypes: ReadonlySet<string>, scope: string): number {
  return items.filter((item) => managedTypes.has(item.type) && readOrigin(item, scope) === undefined).length;
}

/**
 * Which existing Actor an update means among the ones with the same name and type: the only one there is, or else the
 * one a previous import of this profile made. `undefined` when there is none, `null` when there are several and it
 * cannot be told which.
 */
export function chooseExistingActor<T extends FlaggedDocument>(matches: readonly T[], profileId: string, scope: string): T | null | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const own = matches.filter((m) => readOrigin(m, scope)?.profileId === profileId);
  return own.length === 1 ? own[0] : null;
}
