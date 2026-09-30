import { describe, expect, it } from 'vitest';
import { extractStatblockInstance } from '../../../src/statblock/import/extractInstance.js';
import { candidate, el, field, labelSource, minimalProfile } from './testHelpers.js';

/**
 * Line layout (descending y = top-to-bottom reading order), each line's
 * elements SEPARATE tokens (a label must be its own whole element — Task
 * 2's own constraint, see `labelSource.ts`):
 *   Name:   Goblin
 *   HP:     7
 *   ATTACKS
 *   1.      Bite
 *   Damage  5
 *   2.      Claw
 *   Damage  3
 */
function statblockElements() {
  return [
    el('Name:', 0, 100), el('Goblin', 40, 100),
    el('HP:', 0, 90), el('7', 30, 90),
    el('ATTACKS', 0, 80),
    el('1.', 0, 70), el('Bite', 15, 70),
    el('Damage', 0, 60), el('5', 60, 60),
    el('2.', 0, 50), el('Claw', 15, 50),
    el('Damage', 0, 40), el('3', 60, 40),
  ];
}

function fullProfile() {
  return minimalProfile({
    nameSource: labelSource('Name:'),
    fields: [field('hp', 'attributes.hp.value', 'number', { source: labelSource('HP:'), transforms: [{ kind: 'parseNumber' }] })],
    collections: [
      {
        id: 'attacks',
        itemType: 'weapon',
        templateItemUuid: 'Actor.x.Item.y',
        splitRule: { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: 'ATTACKS', entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true },
        nameSource: { kind: 'label', labelPattern: '^\\d+\\.$', labelIsRegex: true, stopAt: 'endOfLine' },
        itemFields: [field('dmg', 'damage', 'string', { source: labelSource('Damage') })],
      },
    ],
  });
}

describe('extractStatblockInstance', () => {
  it('extracts the name, top-level fields, and every collection entry from one candidate', () => {
    const instance = extractStatblockInstance(candidate(statblockElements()), fullProfile());

    expect(instance.id).toBe('candidate-0');
    expect(instance.name).toMatchObject({ found: true, value: 'Goblin' });
    expect(instance.fieldValues.hp).toMatchObject({ found: true, value: 7 });

    const attacks = instance.collections.attacks!;
    expect(attacks).toHaveLength(2);
    expect(attacks[0]).toMatchObject({ name: { found: true, value: 'Bite' }, fieldValues: { dmg: { found: true, value: '5' } } });
    expect(attacks[1]).toMatchObject({ name: { found: true, value: 'Claw' }, fieldValues: { dmg: { found: true, value: '3' } } });
  });

  it('passes the candidate\'s own regions/confidence straight through, unchanged', () => {
    const c = candidate(statblockElements(), { confidence: 0.5, regions: [{ pageNumber: 3, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }] });
    const instance = extractStatblockInstance(c, fullProfile());
    expect(instance.confidence).toBe(0.5);
    expect(instance.regions).toEqual([{ pageNumber: 3, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }]);
  });

  it('a field with no source produces found:false with an informational diagnostic, never a thrown error', () => {
    const profile = minimalProfile({ fields: [field('mystery', 'attributes.mystery', 'string')] });
    const instance = extractStatblockInstance(candidate(statblockElements()), profile);
    expect(instance.fieldValues.mystery).toMatchObject({ found: false, value: undefined });
    expect(instance.fieldValues.mystery!.diagnostics).toEqual([{ severity: 'info', code: 'STATBLOCK_FIELD_NO_SOURCE', params: { fieldId: 'mystery' } }]);
  });

  it('a field whose label never appears reports found:false without throwing', () => {
    const profile = minimalProfile({ fields: [field('ac', 'attributes.ac', 'number', { source: labelSource('AC:') })] });
    const instance = extractStatblockInstance(candidate(statblockElements()), profile);
    expect(instance.fieldValues.ac).toMatchObject({ found: false });
  });

  it('a collection with no entries in this instance (heading present, nothing after it) still reports an empty array, not a missing key', () => {
    const profile = minimalProfile({
      collections: [
        {
          id: 'attacks',
          itemType: 'weapon',
          templateItemUuid: 'Actor.x.Item.y',
          splitRule: { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: 'ATTACKS' },
          nameSource: labelSource('Name:'),
          itemFields: [],
        },
      ],
    });
    const instance = extractStatblockInstance(candidate([el('Just a heading', 0, 100)]), profile);
    expect(instance.collections.attacks).toEqual([]);
  });
});
