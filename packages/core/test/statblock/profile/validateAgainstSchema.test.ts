import { describe, expect, it } from 'vitest';
import { validateProfileAgainstSchema } from '../../../src/statblock/profile/validateAgainstSchema.js';
import { STATBLOCK_PROFILE_SCHEMA_VERSION, type StatblockProfile } from '../../../src/statblock/profile/schema.js';
import type { SchemaFieldDescriptor } from '../../../src/statblock/schema/types.js';

function bbox() {
  return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

function baseProfile(): StatblockProfile {
  return {
    schemaVersion: STATBLOCK_PROFILE_SCHEMA_VERSION,
    id: 'p1',
    name: 'Test',
    actorType: 'npc',
    templateActorUuid: 'Actor.abc',
    templateSchemaFingerprint: 'fp',
    detection: { anchor: { kind: 'textPattern', pattern: 'X' }, boundary: { kind: 'nextAnchor' }, requiredLabels: [] },
    fields: [],
    collections: [],
    valueMaps: [],
    inheritUnmappedFromTemplate: false,
  };
}

describe('validateProfileAgainstSchema — top-level fields', () => {
  it('produces no diagnostics when every field path exists with the matching type', () => {
    const profile = baseProfile();
    profile.fields = [
      {
        id: 'f1',
        actorSchemaPath: 'attributes.hp.value',
        dataType: 'number',
        capture: { exampleBbox: bbox(), examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
      },
    ];
    const actorSchema: SchemaFieldDescriptor[] = [{ path: 'attributes.hp.value', label: 'HP', type: 'number' }];
    expect(validateProfileAgainstSchema(profile, actorSchema, new Map())).toEqual([]);
  });

  it('flags a field whose path no longer exists in the current schema (system drift)', () => {
    const profile = baseProfile();
    profile.fields = [
      {
        id: 'f1',
        actorSchemaPath: 'attributes.sanity.value',
        dataType: 'number',
        capture: { exampleBbox: bbox(), examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
      },
    ];
    const diagnostics = validateProfileAgainstSchema(profile, [{ path: 'attributes.hp.value', label: 'HP', type: 'number' }], new Map());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('STATBLOCK_PROFILE_PATH_NOT_FOUND');
    expect(diagnostics[0]!.severity).toBe('error');
  });

  it('flags a field whose path exists but whose type no longer matches', () => {
    const profile = baseProfile();
    profile.fields = [
      {
        id: 'f1',
        actorSchemaPath: 'name',
        dataType: 'number',
        capture: { exampleBbox: bbox(), examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
      },
    ];
    const diagnostics = validateProfileAgainstSchema(profile, [{ path: 'name', label: 'Name', type: 'string' }], new Map());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('STATBLOCK_PROFILE_TYPE_MISMATCH');
    expect(diagnostics[0]!.params).toMatchObject({ expected: 'number', actual: 'string' });
  });

  it('finds a path nested several levels deep, not just top-level siblings', () => {
    const profile = baseProfile();
    profile.fields = [
      {
        id: 'f1',
        actorSchemaPath: 'attributes.hp.value',
        dataType: 'number',
        capture: { exampleBbox: bbox(), examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
      },
    ];
    const actorSchema: SchemaFieldDescriptor[] = [
      { path: 'attributes.hp', label: 'HP', type: 'object', children: [{ path: 'attributes.hp.value', label: 'value', type: 'number' }] },
    ];
    expect(validateProfileAgainstSchema(profile, actorSchema, new Map())).toEqual([]);
  });
});

describe('validateProfileAgainstSchema — collections', () => {
  it('flags a collection referencing an Item type the current system does not have', () => {
    const profile = baseProfile();
    profile.collections = [
      { id: 'c1', itemType: 'gadget', templateItemUuid: 'Actor.abc.Item.x', splitRule: { kind: 'fixedDelimiter' }, itemFields: [] },
    ];
    const diagnostics = validateProfileAgainstSchema(profile, [], new Map());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('STATBLOCK_PROFILE_ITEM_TYPE_NOT_FOUND');
  });

  it('checks itemFields against the matching Item type schema, scoped separately from the actor schema', () => {
    const profile = baseProfile();
    profile.collections = [
      {
        id: 'c1',
        itemType: 'weapon',
        templateItemUuid: 'Actor.abc.Item.x',
        splitRule: { kind: 'fixedDelimiter' },
        itemFields: [
          {
            id: 'f1',
            actorSchemaPath: 'damage',
            dataType: 'string',
            capture: { exampleBbox: bbox(), examplePageNumber: 1, relativePosition: 'belowAnchor' },
          },
        ],
      },
    ];
    const itemSchemas = new Map<string, SchemaFieldDescriptor[]>([['weapon', [{ path: 'damage', label: 'Damage', type: 'string' }]]]);
    expect(validateProfileAgainstSchema(profile, [], itemSchemas)).toEqual([]);
  });
});
