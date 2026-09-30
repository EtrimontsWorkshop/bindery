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
      anchor: { kind: 'textPattern', pattern: '^[A-Z][a-z]+$', patternIsRegex: true },
      boundary: { kind: 'nextAnchor' },
      requiredLabels: [{ pattern: 'HP:', isRegex: false }],
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

describe('validateProfile — Task 3 detection/source refinements', () => {
  it("rejects anchor kind:'textPattern' with no pattern", () => {
    const profile = validProfile();
    profile.detection.anchor = { kind: 'textPattern' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it("rejects anchor kind:'headingStyle' with no styleFilter", () => {
    const profile = validProfile();
    profile.detection.anchor = { kind: 'headingStyle' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it("accepts anchor kind:'headingStyle' with a styleFilter", () => {
    const profile = validProfile();
    profile.detection.anchor = { kind: 'headingStyle', styleFilter: { largestFontInBlock: true } };
    expect(validateProfile(profile).ok).toBe(true);
  });

  it("rejects boundary kind:'verticalGap' with no gapThreshold", () => {
    const profile = validProfile();
    profile.detection.boundary = { kind: 'verticalGap' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it("accepts boundary kind:'verticalGap' with a gapThreshold", () => {
    const profile = validProfile();
    profile.detection.boundary = { kind: 'verticalGap', gapThreshold: 20 };
    expect(validateProfile(profile).ok).toBe(true);
  });

  it("rejects boundary kind:'endLabel' with no endLabelPattern", () => {
    const profile = validProfile();
    profile.detection.boundary = { kind: 'endLabel' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it('accepts an empty requiredLabels list (a profile author who has not filled it in yet)', () => {
    const profile = validProfile();
    profile.detection.requiredLabels = [];
    expect(validateProfile(profile).ok).toBe(true);
  });

  it("rejects a field's label source with stopAt:'nextLabel' and no nextLabelPattern", () => {
    const profile = validProfile();
    profile.fields[0]!.source = { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'nextLabel' };
    expect(validateProfile(profile).ok).toBe(false);
  });

  it("accepts a field's label source with stopAt:'nextLabel' and a nextLabelPattern", () => {
    const profile = validProfile();
    profile.fields[0]!.source = { kind: 'label', labelPattern: 'HP:', labelIsRegex: false, stopAt: 'nextLabel', nextLabelPattern: '^[A-Z][a-z]+:$', nextLabelIsRegex: true };
    expect(validateProfile(profile).ok).toBe(true);
  });

  it('accepts a field with no source at all (Tasks 1/2 predate the profile-builder UI that would generate one)', () => {
    const profile = validProfile();
    delete profile.fields[0]!.source;
    expect(validateProfile(profile).ok).toBe(true);
  });

  it('accepts a region source and a styleFilter source on different fields', () => {
    const profile = validProfile();
    profile.fields[0]!.source = { kind: 'region', normalizedRect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    profile.collections[0]!.itemFields[0]!.source = { kind: 'styleFilter', filter: { bold: true } };
    expect(validateProfile(profile).ok).toBe(true);
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
