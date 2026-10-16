import { describe, expect, it } from 'vitest';
import { chooseExistingActor, countUnmarkedItems, originFlags, readOrigin, selectItemsToReplace } from '../../../src/statblock/import/origin.js';

const SCOPE = 'some-module';
const marked = (id: string, profileId: string, collectionId: string, type = 'weapon') => ({ id, type, flags: originFlags(SCOPE, { profileId, collectionId, entryKey: `${id}#0` }) });
const byHand = (id: string, type = 'weapon') => ({ id, type });

describe('readOrigin', () => {
  it('reads the origin from the flags of a plain object and through getFlag of a document', () => {
    expect(readOrigin(marked('a', 'p1', 'c1'), SCOPE)).toMatchObject({ profileId: 'p1', collectionId: 'c1' });
    const document = { getFlag: (scope: string, key: string) => (scope === SCOPE && key === 'statblock' ? { profileId: 'p2' } : undefined) };
    expect(readOrigin(document, SCOPE)).toEqual({ profileId: 'p2' });
  });

  it('is undefined for a document made by hand, a foreign scope and a malformed flag', () => {
    expect(readOrigin(byHand('a'), SCOPE)).toBeUndefined();
    expect(readOrigin(marked('a', 'p1', 'c1'), 'another-module')).toBeUndefined();
    expect(readOrigin({ flags: { [SCOPE]: { statblock: { profileId: 5 } } } }, SCOPE)).toBeUndefined();
  });
});

describe('selectItemsToReplace', () => {
  const items = [marked('own-attack', 'p1', 'attacks'), marked('own-trait', 'p1', 'traits', 'feat'), marked('other-profile', 'p2', 'attacks'), byHand('personal-sword'), byHand('old-import-without-origin')];

  it('selects only what an earlier import of this profile made, from a collection the statblock has', () => {
    expect(selectItemsToReplace(items, 'p1', ['attacks', 'traits'], SCOPE).map((i) => i.id)).toEqual(['own-attack', 'own-trait']);
  });

  it('keeps the Items of a collection that was not found in the statblock', () => {
    expect(selectItemsToReplace(items, 'p1', ['attacks'], SCOPE).map((i) => i.id)).toEqual(['own-attack']);
    expect(selectItemsToReplace(items, 'p1', [], SCOPE)).toEqual([]);
  });

  it('never selects an Item made by hand, one of another profile, or one that carries no origin', () => {
    const selected = selectItemsToReplace(items, 'p1', ['attacks', 'traits'], SCOPE).map((i) => i.id);
    expect(selected).not.toContain('personal-sword');
    expect(selected).not.toContain('other-profile');
    expect(selected).not.toContain('old-import-without-origin');
  });
});

describe('countUnmarkedItems', () => {
  it('counts the Items of the profile\'s types that carry no origin', () => {
    const items = [marked('a', 'p1', 'attacks'), byHand('b'), byHand('c', 'spell'), byHand('d')];
    expect(countUnmarkedItems(items, new Set(['weapon']), SCOPE)).toBe(2);
  });
});

describe('chooseExistingActor', () => {
  const actor = (id: string, profileId?: string) => ({ id, ...(profileId ? { flags: originFlags(SCOPE, { profileId }) } : {}) });

  it('is undefined when there is no Actor of that name, and the Actor when there is one', () => {
    expect(chooseExistingActor([], 'p1', SCOPE)).toBeUndefined();
    expect(chooseExistingActor([actor('a')], 'p1', SCOPE)?.id).toBe('a');
  });

  it('among several, takes the one that this profile made, and no one when it cannot be told', () => {
    expect(chooseExistingActor([actor('a'), actor('b', 'p1')], 'p1', SCOPE)?.id).toBe('b');
    expect(chooseExistingActor([actor('a'), actor('b')], 'p1', SCOPE)).toBeNull();
    expect(chooseExistingActor([actor('a', 'p1'), actor('b', 'p1')], 'p1', SCOPE)).toBeNull();
  });
});
