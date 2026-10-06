import { STATBLOCK_PROFILE_SCHEMA_VERSION, type FieldSource, type ProfileField, type StatblockProfile } from '../../../src/statblock/profile/schema.js';
import type { SchemaFieldDescriptor } from '../../../src/statblock/schema/types.js';
import type { PageTextElement } from '../../../src/statblock/extract/types.js';
import type { DetectionCandidate } from '../../../src/statblock/pdf/types.js';

/** Not itself a `.test.ts` file — vitest ignores it, this is shared fixture-building only. */

export function el(text: string, x: number, y: number, overrides: Partial<PageTextElement> = {}): PageTextElement {
  return { text, x, y, w: text.length * 6, h: 10, fontName: 'Body', fontSize: 10, bold: false, italic: false, ...overrides };
}

export const labelSource = (labelPattern: string): FieldSource => ({ kind: 'label', labelPattern, labelIsRegex: false, stopAt: 'endOfLine' });

export function field(id: string, actorSchemaPath: string, dataType: ProfileField['dataType'], overrides: Partial<ProfileField> = {}): ProfileField {
  return {
    id,
    actorSchemaPath,
    dataType,
    capture: { exampleBbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
    transforms: [],
    ...overrides,
  };
}

/** A minimal, otherwise-empty valid profile — every test overrides just what it needs. */
export function minimalProfile(overrides: Partial<StatblockProfile> = {}): StatblockProfile {
  return {
    schemaVersion: STATBLOCK_PROFILE_SCHEMA_VERSION,
    id: 'p1',
    name: 'Test profile',
    actorType: 'npc',
    templateActorUuid: 'Actor.x',
    templateSchemaFingerprint: 'fp',
    detection: { anchor: { kind: 'textPattern', pattern: '^[A-Z][a-z]+$', patternIsRegex: true }, boundary: { kind: 'nextAnchor' }, requiredLabels: [] },
    nameSource: labelSource('Name:'),
    fields: [],
    collections: [],
    valueMaps: [],
    inheritUnmappedFromTemplate: false,
    ...overrides,
  };
}

export function candidate(elements: PageTextElement[], overrides: Partial<DetectionCandidate> = {}): DetectionCandidate {
  return {
    id: 'candidate-0',
    regions: [{ pageNumber: 1, bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 } }],
    elements,
    confidence: 1,
    foundRequiredLabels: [],
    missingRequiredLabels: [],
    ...overrides,
  };
}

export function descriptor(path: string, type: SchemaFieldDescriptor['type'], overrides: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor {
  return { path, label: path, type, ...overrides };
}
