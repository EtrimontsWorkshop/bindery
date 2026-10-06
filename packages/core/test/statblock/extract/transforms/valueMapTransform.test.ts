import { describe, expect, it } from 'vitest';
import { applyValueMap } from '../../../../src/statblock/extract/transforms/valueMapTransform.js';
import type { ValueMap } from '../../../../src/statblock/profile/schema.js';

function lookupMap(entries: Record<string, string>, opts: { fuzzy?: boolean; caseInsensitive?: boolean } = {}): ValueMap {
  return { id: 'vm1', kind: 'lookupTable', params: { entries, ...opts } };
}

describe('applyValueMap — lookupTable, exact matching', () => {
  it('maps an exact key to its value', () => {
    const result = applyValueMap('Large', lookupMap({ Large: 'L', Small: 'S' }));
    expect(result.value).toBe('L');
  });

  it('is case-insensitive by default', () => {
    const result = applyValueMap('LARGE', lookupMap({ Large: 'L' }));
    expect(result.value).toBe('L');
  });

  it('respects caseInsensitive: false', () => {
    const result = applyValueMap('LARGE', lookupMap({ Large: 'L' }, { caseInsensitive: false }));
    expect(result.value).toBeUndefined();
  });

  it('trims the input before matching', () => {
    const result = applyValueMap('  Large  ', lookupMap({ Large: 'L' }));
    expect(result.value).toBe('L');
  });

  it('reports a warning diagnostic when nothing matches and fuzzy is off', () => {
    const result = applyValueMap('Medium', lookupMap({ Large: 'L', Small: 'S' }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALUE_MAP_NO_MATCH');
  });
});

describe('applyValueMap — lookupTable, fuzzy matching', () => {
  it('matches after stripping punctuation/whitespace differences (normalized match)', () => {
    const result = applyValueMap('Large*', lookupMap({ Large: 'L' }, { fuzzy: true }));
    expect(result.value).toBe('L');
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALUE_MAP_NORMALIZED_MATCH');
  });

  it('matches a close typo within the distance threshold', () => {
    const result = applyValueMap('Larg', lookupMap({ Large: 'L', Small: 'S' }, { fuzzy: true }));
    expect(result.value).toBe('L');
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALUE_MAP_FUZZY_MATCH');
  });

  it('does NOT match two genuinely unrelated keys even with fuzzy on', () => {
    const result = applyValueMap('Gargantuan', lookupMap({ Large: 'L', Small: 'S' }, { fuzzy: true }));
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALUE_MAP_NO_MATCH');
  });

  it('without fuzzy, a typo that would otherwise fuzzy-match reports no match', () => {
    const result = applyValueMap('Larg', lookupMap({ Large: 'L' }));
    expect(result.value).toBeUndefined();
  });
});

describe('applyValueMap — stripUnits', () => {
  it('removes a trailing unit string, case-insensitively', () => {
    const result = applyValueMap('10 HP', { id: 'vm2', kind: 'stripUnits', params: { unit: 'hp' } });
    expect(result.value).toBe('10');
  });

  it('leaves the input unchanged when no unit param is given', () => {
    const result = applyValueMap('10 hp', { id: 'vm2', kind: 'stripUnits', params: {} });
    expect(result.value).toBe('10 hp');
  });
});

describe('applyValueMap — regexReplace', () => {
  it('replaces every match of the pattern', () => {
    const result = applyValueMap('a1b2c3', { id: 'vm3', kind: 'regexReplace', params: { pattern: '\\d', replacement: '#' } });
    expect(result.value).toBe('a#b#c#');
  });

  it('respects a custom (non-global) flags param', () => {
    const result = applyValueMap('a1b2c3', { id: 'vm3', kind: 'regexReplace', params: { pattern: '\\d', replacement: '#', flags: '' } });
    expect(result.value).toBe('a#b2c3');
  });

  it('invalid params produce an error diagnostic, value unchanged', () => {
    const result = applyValueMap('abc', { id: 'vm3', kind: 'regexReplace', params: {} });
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALUE_MAP_INVALID_PARAMS');
    expect(result.value).toBe('abc');
  });
});

describe('applyValueMap — diceNotation (cosmetic normalization only)', () => {
  it('lowercases the die marker and normalizes spacing around +/-', () => {
    const result = applyValueMap('1D6+2', { id: 'vm4', kind: 'diceNotation', params: {} });
    expect(result.value).toBe('1d6 + 2');
  });

  it('removes stray internal whitespace', () => {
    const result = applyValueMap('1 D 6 + 2', { id: 'vm4', kind: 'diceNotation', params: {} });
    expect(result.value).toBe('1d6 + 2');
  });
});

describe('applyValueMap — non-string input passes through unchanged', () => {
  it('does not attempt to map an already-parsed number', () => {
    const result = applyValueMap(42, lookupMap({ Large: 'L' }));
    expect(result.value).toBe(42);
    expect(result.diagnostics).toEqual([]);
  });
});
