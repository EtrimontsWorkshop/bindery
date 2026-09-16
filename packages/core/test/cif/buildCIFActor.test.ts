import { describe, expect, it } from 'vitest';
import { buildCIFActor } from '../../src/cif/buildCIFActor.js';
import type { AssembledStatblock } from '../../src/profiles/assembleStatblocks.js';

function rect(minX: number, minY: number, w = 10, h = 10) {
  return { minX, minY, maxX: minX + w, maxY: minY + h };
}

function baseStatblock(overrides: Partial<AssembledStatblock> = {}): AssembledStatblock {
  return {
    ordinal: 0,
    grid: {
      pairs: [
        { label: 'S', canonicalKey: 'strength', value: '40', tokenIndex: 0 },
        { label: 'WYG', canonicalKey: 'charisma', value: '25', tokenIndex: 2 },
      ],
      startIndex: 0,
      endIndex: 4,
      bbox: rect(0, 70),
    },
    derived: null,
    attacks: null,
    skills: null,
    name: { kind: 'confident', text: 'Joshua Thomas', confidence: 0.9, tokenIndex: 99 },
    typeLabel: null,
    bbox: rect(0, 70),
    ...overrides,
  };
}

describe('buildCIFActor — [KROK-18 Z6]', () => {
  it('mapuje siatke cech na statistics po kluczach kanonicznych', () => {
    const actor = buildCIFActor({ statblock: baseStatblock(), page: 30 });
    expect(actor.statistics['strength']).toEqual({ raw: '40', numeric: 40, unit: 'plain', sourceLabel: 'S', confidence: 1 });
    expect(actor.statistics['charisma']).toEqual({ raw: '25', numeric: 25, unit: 'plain', sourceLabel: 'WYG', confidence: 1 });
  });

  it('nazwa pewna -> uzyta wprost; placeholder -> uzyty jako name (nigdy pusta nazwa)', () => {
    const confident = buildCIFActor({ statblock: baseStatblock(), page: 30 });
    expect(confident.name).toBe('Joshua Thomas');
    expect(confident.nameConfident).toBe(true);
    expect(confident.nameCandidates).toBeUndefined();

    const uncertain = buildCIFActor({
      statblock: baseStatblock({ name: { kind: 'placeholder', placeholder: 'NPC ze str. 84 (#1)', candidates: ['A', 'B'] } }),
      page: 84,
    });
    expect(uncertain.name).toBe('NPC ze str. 84 (#1)');
    expect(uncertain.nameConfident).toBe(false);
    expect(uncertain.nameCandidates).toEqual(['A', 'B']);
  });

  it('[KROK-19 Z4, zmierzony na zywo brak] placeholder z pusta lista kandydatow -> nameCandidates undefined, nie pusta tablica (nic do pokazania uzytkownikowi)', () => {
    const actor = buildCIFActor({
      statblock: baseStatblock({ name: { kind: 'placeholder', placeholder: 'NPC ze str. 84 (#1)', candidates: [] } }),
      page: 84,
    });
    expect(actor.nameCandidates).toBeUndefined();
  });

  it('laczy siatke i pochodne w JEDEN obiekt statistics', () => {
    const statblock = baseStatblock({
      derived: {
        pairs: [{ label: 'PW', canonicalKey: 'hitPoints', value: '5', tokenIndex: 10 }],
        startIndex: 10,
        endIndex: 12,
        bbox: rect(0, 50),
      },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(Object.keys(actor.statistics)).toEqual(['strength', 'charisma', 'hitPoints']);
  });

  it('wartosc niebedaca liczba (np. "–" brak cechy) -> numeric undefined, raw zachowane', () => {
    const statblock = baseStatblock({
      grid: { pairs: [{ label: 'WYG', canonicalKey: 'charisma', value: '–', tokenIndex: 0 }], startIndex: 0, endIndex: 2, bbox: rect(0, 70) },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(actor.statistics['charisma']).toEqual({ raw: '–', numeric: undefined, unit: 'plain', sourceLabel: 'WYG', confidence: 1 });
  });

  it('ataki mapowane z zachowaniem surowego tekstu (adapter parsuje toHit/damage wg wlasnych regul)', () => {
    const statblock = baseStatblock({
      attacks: {
        headerTokenIndex: 5,
        endIndex: 10,
        items: [{ groups: { name: 'Walka Wręcz', toHit: '40' }, raw: 'Walka Wręcz 40%', startTokenIndex: 6, endTokenIndex: 8, bbox: rect(0, 30) }],
      },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(actor.attacks).toEqual([{ name: 'Walka Wręcz', toHit: '40', damage: undefined, range: undefined, properties: [], rawText: 'Walka Wręcz 40%' }]);
  });

  it('[KROK-40, zgloszenie na zywo] pozycja oznaczona przez matchSectionList jako ranged (rangedKeywords) -> properties zawiera "ranged"', () => {
    const statblock = baseStatblock({
      attacks: {
        headerTokenIndex: 5,
        endIndex: 10,
        items: [{ groups: { name: 'Broń Palna (pistolet)', toHit: '30' }, raw: 'Broń Palna (pistolet) 30%', startTokenIndex: 6, endTokenIndex: 8, bbox: rect(0, 30), ranged: true }],
      },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(actor.attacks[0]!.properties).toEqual(['ranged']);
  });

  it('[A3] rawText ZAWSZE wypelniony — sklada siatke, pochodne i ataki', () => {
    const statblock = baseStatblock({
      derived: { pairs: [{ label: 'PW', canonicalKey: 'hitPoints', value: '5', tokenIndex: 10 }], startIndex: 10, endIndex: 12, bbox: rect(0, 50) },
      attacks: {
        headerTokenIndex: 5,
        endIndex: 10,
        items: [{ groups: { name: 'Walka', toHit: '40' }, raw: 'Walka 40%', startTokenIndex: 6, endTokenIndex: 8, bbox: rect(0, 30) }],
      },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(actor.rawText.length).toBeGreaterThan(0);
    expect(actor.rawText).toContain('S40');
    expect(actor.rawText).toContain('PW5');
    expect(actor.rawText).toContain('Walka 40%');
  });

  it('id domyslny sklada sie ze strony i porzadku na stronie', () => {
    const actor = buildCIFActor({ statblock: baseStatblock({ ordinal: 2 }), page: 55 });
    expect(actor.id).toBe('actor-p55-2');
  });

  it('brak pochodnych/atakow -> bbox to sama unia siatki, statistics tylko z siatki', () => {
    const actor = buildCIFActor({ statblock: baseStatblock(), page: 30 });
    expect(actor.provenance).toEqual({ pageNumber: 30, bbox: rect(0, 70), blockIds: [] });
  });

  it('[zawezenie zakresu KROK-18] brak skillsSection na wejsciu (statblock.skills=null) -> skills puste, tak samo traits/equipment/spells/unmapped', () => {
    const actor = buildCIFActor({ statblock: baseStatblock(), page: 30 });
    expect(actor.skills).toEqual([]);
    expect(actor.traits).toEqual([]);
    expect(actor.equipment).toEqual([]);
    expect(actor.spells).toEqual([]);
    expect(actor.unmapped).toEqual([]);
  });

  it('[ZGŁOSZENIE po kroku 30] typeLabel przenoszony wprost z AssembledStatblock i dolaczony do rawText (A3)', () => {
    const actor = buildCIFActor({ statblock: baseStatblock({ typeLabel: 'kapitan jachtu' }), page: 23 });
    expect(actor.typeLabel).toBe('kapitan jachtu');
    expect(actor.rawText).toContain('kapitan jachtu');
  });

  it('[ZGŁOSZENIE po kroku 30, wsteczna zgodnosc] brak typeLabel (null) -> CIFActor.typeLabel undefined, nie null', () => {
    const actor = buildCIFActor({ statblock: baseStatblock({ typeLabel: null }), page: 23 });
    expect(actor.typeLabel).toBeUndefined();
  });

  it('[KROK-20 Z2b] umiejetnosci mapowane z zachowaniem surowego tekstu, tak samo jak ataki', () => {
    const statblock = baseStatblock({
      skills: {
        headerTokenIndex: 20,
        endIndex: 26,
        items: [
          { groups: { name: 'Historia', value: '75' }, raw: 'Historia 75%', startTokenIndex: 21, endTokenIndex: 22, bbox: rect(0, 10) },
          { groups: { name: 'Okultyzm', value: '60' }, raw: 'Okultyzm 60%', startTokenIndex: 23, endTokenIndex: 24, bbox: rect(20, 10) },
        ],
      },
    });
    const actor = buildCIFActor({ statblock, page: 30 });
    expect(actor.skills).toEqual([
      { name: 'Historia', value: '75' },
      { name: 'Okultyzm', value: '60' },
    ]);
    expect(actor.rawText).toContain('Historia 75%');
    expect(actor.rawText).toContain('Okultyzm 60%');
  });
});
