import { describe, expect, it } from 'vitest';
import { STATBLOCK_PROFILE_SCHEMA_VERSION, statblockProfileSchema, validateProfile, type StatblockProfile } from '../../../src/statblock/profile/schema.js';
import type { SchemaFieldKind } from '../../../src/statblock/schema/types.js';

function validProfile(): StatblockProfile {
  return {
    schemaVersion: STATBLOCK_PROFILE_SCHEMA_VERSION,
    id: 'profile-1',
    name: 'My Book NPCs',
    actorType: 'npc',
    templateActorUuid: 'Actor.abc123',
    templateSchemaFingerprint: 'deadbeef',
    detection: {
      anchor: { kind: 'labelPattern', pattern: '^[A-Z][a-z]+$' },
      boundary: { kind: 'nextAnchor' },
    },
    fields: [
      {
        id: 'field-hp',
        actorSchemaPath: 'attributes.hp.value',
        dataType: 'number',
        capture: {
          exampleBbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
          examplePageNumber: 1,
          relativePosition: 'sameLineAfterLabel',
        },
      },
    ],
    collections: [
      {
        id: 'collection-attacks',
        itemType: 'weapon',
        templateItemUuid: 'Actor.abc123.Item.xyz789',
        splitRule: { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: '^ATTACKS$' },
        itemFields: [
          {
            id: 'attack-name',
            actorSchemaPath: 'name',
            dataType: 'string',
            capture: {
              exampleBbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
              examplePageNumber: 2,
              relativePosition: 'belowAnchor',
            },
          },
        ],
      },
    ],
    valueMaps: [{ id: 'strip-hp-unit', kind: 'stripUnits', params: { unit: 'hp' } }],
    inheritUnmappedFromTemplate: true,
  };
}

describe('validateProfile — happy path', () => {
  it('accepts a well-formed profile and returns it unchanged', () => {
    const result = validateProfile(validProfile());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe('profile-1');
  });

  it('accepts a profile with empty fields/collections/valueMaps (nothing mapped yet — a fresh, in-progress profile)', () => {
    const profile = validProfile();
    profile.fields = [];
    profile.collections = [];
    profile.valueMaps = [];
    expect(validateProfile(profile).ok).toBe(true);
  });

  it('accepts every documented dataType value', () => {
    const kinds: StatblockProfile['fields'][number]['dataType'][] = ['string', 'number', 'boolean', 'html', 'choices', 'array', 'object'];
    for (const dataType of kinds) {
      const profile = validProfile();
      profile.fields[0]!.dataType = dataType;
      expect(validateProfile(profile).ok, `dataType ${dataType} should be accepted`).toBe(true);
    }
  });
});

describe('validateProfile — rejects malformed input with readable issues', () => {
  it('rejects a completely wrong shape (not an object)', () => {
    const result = validateProfile('not a profile');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects a missing required field (name)', () => {
    const profile = validProfile() as unknown as Record<string, unknown>;
    delete profile['name'];
    const result = validateProfile(profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.startsWith('name:'))).toBe(true);
  });

  it('rejects an unrecognized schemaVersion, never silently coercing it', () => {
    const profile = { ...validProfile(), schemaVersion: 999 };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('rejects an unrecognized dataType value on a field', () => {
    const profile = validProfile();
    // @ts-expect-error deliberately invalid for the test
    profile.fields[0]!.dataType = 'not-a-real-type';
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('rejects an empty id (blank string is not a valid identifier)', () => {
    const profile = { ...validProfile(), id: '' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('rejects a collection whose itemFields entry is malformed', () => {
    const profile = validProfile();
    // @ts-expect-error deliberately invalid for the test
    profile.collections[0]!.itemFields[0]!.capture = undefined;
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('rejects an unrecognized detection.anchor.kind', () => {
    const profile = validProfile();
    // @ts-expect-error deliberately invalid for the test
    profile.detection.anchor.kind = 'somethingElse';
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('never throws on garbage input (null, array, number)', () => {
    for (const garbage of [null, [], 42, undefined]) {
      expect(() => validateProfile(garbage)).not.toThrow();
    }
  });
});

describe('ProfileFieldDataType stays in sync with SchemaFieldKind', () => {
  it('every profile dataType is also a valid SchemaFieldKind (minus "unsupported")', () => {
    const profileDataTypes = statblockProfileSchema.shape.fields.element.shape.dataType.options as string[];
    const validSchemaFieldKinds: SchemaFieldKind[] = ['string', 'number', 'boolean', 'html', 'choices', 'array', 'object', 'unsupported'];
    for (const dataType of profileDataTypes) {
      expect(validSchemaFieldKinds).toContain(dataType);
    }
    expect(profileDataTypes).not.toContain('unsupported');
  });
});
