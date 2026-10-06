import type { DuplicateAction, DuplicatePolicy } from './types.js';

/**
 * [Task 4] "Obsługa duplikatów: pomiń / nadpisz / utwórz kopię." Finding
 * whether a matching Actor already exists is a Foundry query
 * (`game.actors`) and stays in the module layer — this is just the tiny,
 * pure DECISION table given that yes/no answer, kept separate so it's
 * testable without a live world: `'copy'` always creates (Foundry allows
 * duplicate names, nothing to resolve); `'skip'`/`'overwrite'` only change
 * behavior when a duplicate was actually found.
 */
export function resolveDuplicateAction(existingFound: boolean, policy: DuplicatePolicy): DuplicateAction {
  if (!existingFound) return 'create';
  if (policy === 'skip') return 'skip';
  if (policy === 'overwrite') return 'update';
  return 'create';
}
