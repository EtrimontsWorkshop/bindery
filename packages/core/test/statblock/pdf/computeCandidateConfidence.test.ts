import { describe, expect, it } from 'vitest';
import { computeCandidateConfidence } from '../../../src/statblock/pdf/computeCandidateConfidence.js';
import type { ProfileField } from '../../../src/statblock/profile/schema.js';
import { el } from './testHelpers.js';

const bbox = { minX: 0, minY: 0, maxX: 500, maxY: 500 };

function field(id: string, source: ProfileField['source']): ProfileField {
  return {
    id,
    actorSchemaPath: `attributes.${id}`,
    dataType: 'string',
    capture: { exampleBbox: bbox, examplePageNumber: 1, relativePosition: 'sameLineAfterLabel' },
    source,
  };
}

describe('computeCandidateConfidence — required labels only', () => {
  it('confidence 1 when every required label is present', () => {
    const elements = [el('HP:', 0, 0), el('7', 22, 0), el('AC:', 0, 20), el('15', 22, 20)];
    const result = computeCandidateConfidence(elements, bbox, [{ pattern: 'HP:', isRegex: false }, { pattern: 'AC:', isRegex: false }], []);
    expect(result.confidence).toBe(1);
    expect(result.foundRequiredLabels).toEqual(['HP:', 'AC:']);
    expect(result.missingRequiredLabels).toEqual([]);
  });

  it('confidence 0 when no required label is present (a false-positive anchor match)', () => {
    const elements = [el('just some text', 0, 0)];
    const result = computeCandidateConfidence(elements, bbox, [{ pattern: 'HP:', isRegex: false }], []);
    expect(result.confidence).toBe(0);
    expect(result.missingRequiredLabels).toEqual(['HP:']);
  });

  it('partial confidence when some required labels are missing', () => {
    const elements = [el('HP:', 0, 0), el('7', 22, 0)];
    const result = computeCandidateConfidence(elements, bbox, [{ pattern: 'HP:', isRegex: false }, { pattern: 'AC:', isRegex: false }], []);
    expect(result.confidence).toBe(0.5);
    expect(result.foundRequiredLabels).toEqual(['HP:']);
    expect(result.missingRequiredLabels).toEqual(['AC:']);
  });
});

describe('computeCandidateConfidence — fields with a source', () => {
  it('counts a field whose source locates something', () => {
    const elements = [el('Name:', 0, 0), el('Goblin', 22, 0)];
    const fields = [field('name', { kind: 'label', labelPattern: 'Name:', labelIsRegex: false, stopAt: 'endOfLine' })];
    const result = computeCandidateConfidence(elements, bbox, [], fields);
    expect(result.confidence).toBe(1);
  });

  it('a field with no source at all does not count toward the total (nothing to check)', () => {
    const fields = [field('name', undefined)];
    const result = computeCandidateConfidence([], bbox, [], fields);
    expect(result.confidence).toBe(1); // zero signals configured -> defaults to trusting the anchor
  });

  it('combines required labels and fields into one score', () => {
    const elements = [el('HP:', 0, 0), el('7', 22, 0), el('Name:', 0, 20), el('Goblin', 22, 20)];
    const fields = [field('name', { kind: 'label', labelPattern: 'Name:', labelIsRegex: false, stopAt: 'endOfLine' })];
    const result = computeCandidateConfidence(elements, bbox, [{ pattern: 'HP:', isRegex: false }], fields);
    expect(result.confidence).toBe(1); // 2/2 signals found
  });
});

describe('computeCandidateConfidence — no signals configured at all', () => {
  it('defaults to confidence 1 (trust the anchor) rather than 0', () => {
    const result = computeCandidateConfidence([el('anything', 0, 0)], bbox, [], []);
    expect(result.confidence).toBe(1);
  });
});
