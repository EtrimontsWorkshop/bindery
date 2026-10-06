import { STATBLOCK_PROFILE_SCHEMA_VERSION, type DetectionConfig, type StatblockProfile } from '../../../src/statblock/profile/schema.js';
import type { PageTextElement } from '../../../src/statblock/extract/types.js';
import type { PageForDetection } from '../../../src/statblock/pdf/types.js';

/** Not itself a `.test.ts` file — vitest ignores it, this is shared fixture-building only. */

export function el(text: string, x: number, y: number, overrides: Partial<PageTextElement> = {}): PageTextElement {
  return { text, x, y, w: text.length * 6, h: 10, fontName: 'Body', fontSize: 10, bold: false, italic: false, ...overrides };
}

export function page(pageNumber: number, elements: PageTextElement[], overrides: Partial<Omit<PageForDetection, 'pageNumber' | 'elements'>> = {}): PageForDetection {
  return { pageNumber, elements, pageBox: { minX: 0, minY: 0, maxX: 600, maxY: 800 }, ...overrides };
}

/** A profile whose anchor matches any single capitalized word (e.g. a creature name heading), with no required labels/fields by default — override `detection` per test. */
export function minimalProfile(detectionOverrides: Partial<DetectionConfig> = {}): StatblockProfile {
  return {
    schemaVersion: STATBLOCK_PROFILE_SCHEMA_VERSION,
    id: 'p1',
    name: 'Test profile',
    actorType: 'npc',
    templateActorUuid: 'Actor.x',
    templateSchemaFingerprint: 'fp',
    detection: {
      anchor: { kind: 'textPattern', pattern: '^[A-Z][a-z]+$', patternIsRegex: true },
      boundary: { kind: 'nextAnchor' },
      requiredLabels: [],
      ...detectionOverrides,
    },
    fields: [],
    collections: [],
    valueMaps: [],
    inheritUnmappedFromTemplate: false,
  };
}
