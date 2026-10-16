import { describe, expect, it } from 'vitest';
import { prepareStatblock } from '../../../src/statblock/import/prepareStatblock.js';
import { computeSchemaFingerprint } from '../../../src/statblock/schema/computeSchemaFingerprint.js';
import { candidate, descriptor, el, field, labelSource, minimalProfile } from './testHelpers.js';

const actorDescriptors = [descriptor('hp', 'number'), descriptor('ac', 'number')];

function profileFor(overrides: Parameters<typeof minimalProfile>[0] = {}) {
  return minimalProfile({
    templateSchemaFingerprint: computeSchemaFingerprint(actorDescriptors),
    nameSource: { kind: 'literal', value: 'Goblin' },
    fields: [field('hp', 'hp', 'number', { source: labelSource('HP:'), transforms: [{ kind: 'parseNumber' }] })],
    ...overrides,
  });
}

describe('prepareStatblock', () => {
  it('prepares a well-formed statblock without a diagnostic that blocks it', () => {
    const result = prepareStatblock(candidate([el('HP:', 0, 90), el('7', 30, 90)]), profileFor(), { actorDescriptors });
    expect(result.canImport).toBe(true);
    expect(result.data.system).toEqual({ hp: 7 });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('blocks a statblock whose field maps onto a path the schema no longer has', () => {
    const profile = profileFor({ fields: [field('x', 'missing.path', 'number', { source: { kind: 'literal', value: 12 } })] });
    const result = prepareStatblock(candidate([]), profile, { actorDescriptors });
    expect(result.canImport).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STATBLOCK_IMPORT_PATH_NOT_FOUND');
  });

  it('blocks a statblock whose field has changed its type in the schema', () => {
    const profile = profileFor({ fields: [field('hp', 'hp', 'string', { source: { kind: 'literal', value: '7' } })] });
    const result = prepareStatblock(candidate([]), profile, { actorDescriptors });
    expect(result.canImport).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STATBLOCK_PROFILE_TYPE_MISMATCH');
  });

  it('brings an error from extraction up to the statblock, so that a refused pattern blocks the import', () => {
    const profile = profileFor({ fields: [field('hp', 'hp', 'number', { source: { kind: 'label', labelPattern: '^(a+)+$', labelIsRegex: true, stopAt: 'endOfLine' } })] });
    const result = prepareStatblock(candidate([el('HP:', 0, 90), el('7', 30, 90)]), profile, { actorDescriptors });
    expect(result.canImport).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STATBLOCK_REGEX_REFUSED');
  });

  it('warns, without blocking, that the schema has changed since the profile was built and that required labels are missing', () => {
    const profile = profileFor({ templateSchemaFingerprint: 'something-else' });
    const result = prepareStatblock(candidate([], { meetsRequirements: false, missingRequiredLabels: ['HP:'] }), profile, { actorDescriptors });
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('STATBLOCK_IMPORT_SCHEMA_CHANGED');
    expect(codes).toContain('STATBLOCK_IMPORT_REQUIRED_LABELS_MISSING');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('tells a collection that was not found from one that is empty', () => {
    const collection = {
      id: 'attacks',
      itemType: 'weapon',
      templateItemUuid: 'Actor.x.Item.y',
      splitRule: { kind: 'sectionHeaderThenEntries' as const, sectionHeaderPattern: 'ATTACKS' },
      nameSource: labelSource('Name:'),
      itemFields: [],
    };
    const missing = prepareStatblock(candidate([el('HP:', 0, 90), el('7', 30, 90)]), profileFor({ collections: [collection] }), { actorDescriptors, itemDescriptorsByCollectionId: new Map([['attacks', []]]) });
    expect(missing.data.replaceableCollectionIds).toEqual([]);
    expect(missing.diagnostics.map((d) => d.code)).toContain('STATBLOCK_IMPORT_COLLECTION_NOT_FOUND');

    const empty = prepareStatblock(candidate([el('ATTACKS', 0, 90)]), profileFor({ collections: [collection] }), { actorDescriptors, itemDescriptorsByCollectionId: new Map([['attacks', []]]) });
    expect(empty.data.replaceableCollectionIds).toEqual(['attacks']);
  });
});
