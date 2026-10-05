import { describe, expect, it } from 'vitest';
import { buildActorData, type SchemaContext } from '../../../src/statblock/import/buildActorData.js';
import type { ExtractedActorInstance, ExtractedValue } from '../../../src/statblock/import/types.js';
import { descriptor, field, minimalProfile } from './testHelpers.js';

function value(value: unknown, overrides: Partial<ExtractedValue> = {}): ExtractedValue {
  return { found: value !== undefined, raw: typeof value === 'string' ? value : String(value ?? ''), value, sourceBbox: null, diagnostics: [], ...overrides };
}

function notFound(): ExtractedValue {
  return { found: false, raw: null, value: undefined, sourceBbox: null, diagnostics: [] };
}

function instance(overrides: Partial<ExtractedActorInstance> = {}): ExtractedActorInstance {
  return {
    id: 'i1',
    regions: [{ pageNumber: 2, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }],
    confidence: 1,
    name: value('Goblin'),
    fieldValues: {},
    collections: {},
    ...overrides,
  };
}

describe('buildActorData — name', () => {
  it('uses the extracted name when found', () => {
    const result = buildActorData(instance(), minimalProfile(), { actorDescriptors: [] });
    expect(result.data.name).toBe('Goblin');
  });

  it('falls back to a generic name and warns when the name was not found', () => {
    const result = buildActorData(instance({ name: notFound() }), minimalProfile(), { actorDescriptors: [] });
    expect(result.data.name).toBe('Unnamed');
    expect(result.diagnostics).toContainEqual({ severity: 'warning', code: 'STATBLOCK_IMPORT_NAME_NOT_FOUND', pageNumber: 2, params: { fallback: 'Unnamed' } });
  });
});

describe('buildActorData — top-level fields', () => {
  it('sets a mapped, found, correctly-typed field onto system at its schema path', () => {
    const profile = minimalProfile({ fields: [field('hp', 'attributes.hp.value', 'number')] });
    const schema: SchemaContext = { actorDescriptors: [descriptor('attributes.hp.value', 'number')] };
    const result = buildActorData(instance({ fieldValues: { hp: value(7) } }), profile, schema);
    expect(result.data.system).toEqual({ attributes: { hp: { value: 7 } } });
    expect(result.diagnostics).toEqual([]);
  });

  it('errors and leaves the path unset when the schema has no descriptor for it (drifted/renamed system field)', () => {
    const profile = minimalProfile({ fields: [field('hp', 'attributes.hp.value', 'number')] });
    const result = buildActorData(instance({ fieldValues: { hp: value(7) } }), profile, { actorDescriptors: [] });
    expect(result.data.system).toEqual({});
    expect(result.diagnostics).toContainEqual({ severity: 'error', code: 'STATBLOCK_IMPORT_PATH_NOT_FOUND', pageNumber: 2, params: { field: 'attributes.hp.value' } });
  });

  it('warns and leaves the path unset when extraction never found a value for a mapped field', () => {
    const profile = minimalProfile({ fields: [field('hp', 'attributes.hp.value', 'number')] });
    const schema: SchemaContext = { actorDescriptors: [descriptor('attributes.hp.value', 'number')] };
    const result = buildActorData(instance({ fieldValues: { hp: notFound() } }), profile, schema);
    expect(result.data.system).toEqual({});
    expect(result.diagnostics).toContainEqual({ severity: 'warning', code: 'STATBLOCK_IMPORT_FIELD_NOT_FOUND', pageNumber: 2, params: { field: 'attributes.hp.value' } });
  });

  it('drops a value that fails the REAL schema\'s type check even though it passed extraction-time casting', () => {
    const profile = minimalProfile({ fields: [field('hp', 'attributes.hp.value', 'string')] });
    const schema: SchemaContext = { actorDescriptors: [descriptor('attributes.hp.value', 'number')] };
    const result = buildActorData(instance({ fieldValues: { hp: value('seven') } }), profile, schema);
    expect(result.data.system).toEqual({});
    expect(result.diagnostics.some((d) => d.code === 'STATBLOCK_CAST_NOT_NUMBER')).toBe(true);
  });

  it('keeps a value that only violates a soft constraint (choices), tagging the diagnostic with field + raw context', () => {
    const profile = minimalProfile({ fields: [field('size', 'traits.size', 'choices')] });
    const schema: SchemaContext = { actorDescriptors: [descriptor('traits.size', 'choices', { choices: [{ value: 'sm', label: 'Small' }] })] };
    const result = buildActorData(instance({ fieldValues: { size: value('xl') } }), profile, schema);
    expect(result.data.system).toEqual({ traits: { size: 'xl' } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'STATBLOCK_VALIDATE_NOT_IN_CHOICES', params: expect.objectContaining({ field: 'traits.size', raw: 'xl' }) }));
  });

  it('reports a PATH_NOT_FOUND per field (not a single schema-unavailable error) when actorDescriptors is genuinely empty', () => {
    const profile = minimalProfile({ fields: [field('a', 'a', 'string'), field('b', 'b', 'string')] });
    const result = buildActorData(instance({ fieldValues: { a: value('x'), b: value('y') } }), profile, { actorDescriptors: [] });
    expect(result.diagnostics.filter((d) => d.code === 'STATBLOCK_IMPORT_PATH_NOT_FOUND')).toHaveLength(2);
    expect(result.diagnostics.some((d) => d.code === 'STATBLOCK_IMPORT_SCHEMA_UNAVAILABLE')).toBe(false);
  });
});

describe('buildActorData — inheritUnmappedFromTemplate', () => {
  const schema: SchemaContext = {
    actorDescriptors: [descriptor('attributes.hp.value', 'number', { currentValue: 4 }), descriptor('attributes.ac', 'number', { currentValue: 12 })],
  };

  it('copies the template\'s current value for every unmapped leaf when enabled', () => {
    const profile = minimalProfile({ inheritUnmappedFromTemplate: true, fields: [field('hp', 'attributes.hp.value', 'number')] });
    const result = buildActorData(instance({ fieldValues: { hp: value(9) } }), profile, schema);
    expect(result.data.system).toEqual({ attributes: { hp: { value: 9 }, ac: 12 } });
  });

  it('never overwrites a MAPPED path with the template value, even though the descriptor also has a currentValue', () => {
    const profile = minimalProfile({ inheritUnmappedFromTemplate: true, fields: [field('hp', 'attributes.hp.value', 'number')] });
    const result = buildActorData(instance({ fieldValues: { hp: value(9) } }), profile, schema);
    expect((result.data.system as { attributes: { hp: { value: number } } }).attributes.hp.value).toBe(9);
  });

  it('leaves unmapped fields untouched when disabled (the default)', () => {
    const profile = minimalProfile({ inheritUnmappedFromTemplate: false, fields: [field('hp', 'attributes.hp.value', 'number')] });
    const result = buildActorData(instance({ fieldValues: { hp: value(9) } }), profile, schema);
    expect(result.data.system).toEqual({ attributes: { hp: { value: 9 } } });
  });
});

describe('buildActorData — collections', () => {
  it('builds one BuiltItemData per extracted collection entry, with its own name/type/system', () => {
    const profile = minimalProfile({
      collections: [
        {
          id: 'attacks',
          itemType: 'weapon',
          templateItemUuid: 'x',
          splitRule: { kind: 'fixedDelimiter' },
          nameSource: { kind: 'label', labelPattern: 'x', labelIsRegex: false, stopAt: 'endOfLine' },
          itemFields: [field('dmg', 'damage', 'string')],
        },
      ],
    });
    const schema: SchemaContext = {
      actorDescriptors: [],
      itemDescriptorsByCollectionId: new Map([['attacks', [descriptor('damage', 'string')]]]),
    };
    const result = buildActorData(
      instance({
        collections: {
          attacks: [
            { sourceBbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, name: value('Bite'), fieldValues: { dmg: value('1d6') } },
            { sourceBbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, name: value('Claw'), fieldValues: { dmg: value('1d4') } },
          ],
        },
      }),
      profile,
      schema,
    );
    expect(result.data.items).toEqual([
      { name: 'Bite', type: 'weapon', system: { damage: '1d6' } },
      { name: 'Claw', type: 'weapon', system: { damage: '1d4' } },
    ]);
  });

  it('falls back to a generic item name when an entry\'s own name was not found', () => {
    const profile = minimalProfile({
      collections: [
        {
          id: 'attacks',
          itemType: 'weapon',
          templateItemUuid: 'x',
          splitRule: { kind: 'fixedDelimiter' },
          nameSource: { kind: 'label', labelPattern: 'x', labelIsRegex: false, stopAt: 'endOfLine' },
          itemFields: [],
        },
      ],
    });
    const result = buildActorData(
      instance({ collections: { attacks: [{ sourceBbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, name: notFound(), fieldValues: {} }] } }),
      profile,
      { actorDescriptors: [] },
    );
    expect(result.data.items[0]!.name).toBe('Unnamed Item');
  });

  it('degrades to an item with every field unmapped when the collection\'s own template item schema is unavailable', () => {
    const profile = minimalProfile({
      collections: [
        {
          id: 'attacks',
          itemType: 'weapon',
          templateItemUuid: 'x',
          splitRule: { kind: 'fixedDelimiter' },
          nameSource: { kind: 'label', labelPattern: 'x', labelIsRegex: false, stopAt: 'endOfLine' },
          itemFields: [field('dmg', 'damage', 'string')],
        },
      ],
    });
    const result = buildActorData(
      instance({ collections: { attacks: [{ sourceBbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, name: value('Bite'), fieldValues: { dmg: value('1d6') } }] } }),
      profile,
      { actorDescriptors: [] },
    );
    expect(result.data.items).toEqual([{ name: 'Bite', type: 'weapon', system: {} }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'STATBLOCK_IMPORT_SCHEMA_UNAVAILABLE' }));
  });
});

describe('buildActorData — top-level Actor fields', () => {
  it('carries type from the profile and img/folder from options straight through', () => {
    const result = buildActorData(instance(), minimalProfile({ actorType: 'creature' }), { actorDescriptors: [] }, { img: 'path/to.webp', folder: 'folder-1' });
    expect(result.data.type).toBe('creature');
    expect(result.data.img).toBe('path/to.webp');
    expect(result.data.folder).toBe('folder-1');
  });
});

describe('buildActorData — resources with a current and a maximum part', () => {
  const schema: SchemaContext = {
    actorDescriptors: [descriptor('pool.value', 'number', { currentValue: 0 }), descriptor('pool.max', 'number', { currentValue: 0 }), descriptor('other.value', 'number'), descriptor('other.max', 'string')],
    resourcePaths: ['pool', 'other'],
  };

  it('fills the current part with the same number when only the maximum was mapped', () => {
    const profile = minimalProfile({ fields: [field('m', 'pool.max', 'number')] });
    expect(buildActorData(instance({ fieldValues: { m: value(7) } }), profile, schema).data.system).toEqual({ pool: { max: 7, value: 7 } });
  });

  it('fills the maximum with the same number when only the current part was mapped', () => {
    const profile = minimalProfile({ fields: [field('v', 'pool.value', 'number')] });
    expect(buildActorData(instance({ fieldValues: { v: value(7) } }), profile, schema).data.system).toEqual({ pool: { value: 7, max: 7 } });
  });

  it('keeps both numbers when both were mapped', () => {
    const profile = minimalProfile({ fields: [field('v', 'pool.value', 'number'), field('m', 'pool.max', 'number')] });
    expect(buildActorData(instance({ fieldValues: { v: value(3), m: value(7) } }), profile, schema).data.system).toEqual({ pool: { value: 3, max: 7 } });
  });

  it('is not overwritten by template inheritance', () => {
    const profile = minimalProfile({ inheritUnmappedFromTemplate: true, fields: [field('m', 'pool.max', 'number')] });
    expect(buildActorData(instance({ fieldValues: { m: value(7) } }), profile, schema).data.system).toMatchObject({ pool: { max: 7, value: 7 } });
  });

  it('leaves a pair alone unless both parts are numeric fields of the schema', () => {
    const profile = minimalProfile({ fields: [field('v', 'other.value', 'number')] });
    expect(buildActorData(instance({ fieldValues: { v: value(5) } }), profile, schema).data.system).toEqual({ other: { value: 5 } });
  });

  it('does nothing when the system declares no resources', () => {
    const profile = minimalProfile({ fields: [field('m', 'pool.max', 'number')] });
    expect(buildActorData(instance({ fieldValues: { m: value(7) } }), profile, { actorDescriptors: schema.actorDescriptors }).data.system).toEqual({ pool: { max: 7 } });
  });
});
