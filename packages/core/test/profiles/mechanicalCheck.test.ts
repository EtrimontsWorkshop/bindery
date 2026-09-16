import { describe, expect, it } from 'vitest';
import { checkRelation, checkRelations, evaluateExpression, extractCanonicalValues, parseRelation, type EntityCanonicalValues } from '../../src/profiles/mechanicalCheck.js';
import type { EntityAnalysis } from '../../src/profiles/studioAnalysis.js';

function entity(label: string, values: Record<string, number>): EntityCanonicalValues {
  return { label, values };
}

describe('parseRelation — [KROK-24 Z3]', () => {
  it('rozpoznaje relacje z ≈', () => {
    expect(parseRelation('hitPoints ≈ (constitution + size) / 10')).toEqual({
      lhsKey: 'hitPoints',
      op: '≈',
      rhsExpr: '(constitution + size) / 10',
    });
  });

  it('rozpoznaje relacje z =', () => {
    expect(parseRelation('sanity = willpower')).toEqual({ lhsKey: 'sanity', op: '=', rhsExpr: 'willpower' });
  });

  it('brak operatora -> null (czytelny blad, nie wyjatek)', () => {
    expect(parseRelation('hitPoints constitution')).toBeNull();
  });
});

describe('evaluateExpression — [KROK-24 Z3, "dwa operatory, cztery działania"]', () => {
  it('dodawanie, mnozenie, dzielenie, nawiasy', () => {
    expect(evaluateExpression('(constitution + size) / 10', { constitution: 60, size: 70 })).toBe(13);
    expect(evaluateExpression('willpower * 5', { willpower: 14 })).toBe(70);
  });

  it('sam klucz kanoniczny (bez operatora) jako wyrazenie', () => {
    expect(evaluateExpression('willpower', { willpower: 55 })).toBe(55);
  });

  it('brakujacy klucz -> null (nie 0)', () => {
    expect(evaluateExpression('constitution + size', { constitution: 60 })).toBeNull();
  });

  it('dzielenie przez zero -> null', () => {
    expect(evaluateExpression('constitution / 0', { constitution: 60 })).toBeNull();
  });

  it('nieznany operator/znak spoza alfabetu -> null (nie próbuje zgadywać)', () => {
    expect(evaluateExpression('constitution % 2', { constitution: 60 })).toBeNull();
  });

  it('unarny minus', () => {
    expect(evaluateExpression('-size', { size: 5 })).toBe(-5);
  });
});

describe('checkRelation — [KROK-24 Z3, "jedyna funkcja łapiąca cichą korupcję mapowań"]', () => {
  it('[dokladnie przypadek z RAPORT-KROK-19, ktory zrodzil A11] wykrywa zle zmapowane P (hitPoints zamiast sanity) jako rozbieznosc z konkretnymi wartosciami', () => {
    // Symulacja: autor przez pomylke zmapowal "P" (Poczytalnosc) na "hitPoints"
    // zamiast "sanity" -- relacja hitPoints ≈ (constitution+size)/10 (prawdziwa
    // formula CoC7 dla PW) NIE bedzie sie zgadzac, bo w `values.hitPoints`
    // ladujemy tak naprawde Poczytalnosc (liczby "wygladajace wiarygodnie",
    // ale niepowiazane wzorem).
    const entities = [
      entity('Bestia', { hitPoints: 45, constitution: 60, size: 70 }), // hitPoints w rzeczywistosci to Poczytalnosc (45), oczekiwane PW to (60+70)/10=13
      entity('Warwick', { hitPoints: 55, constitution: 50, size: 60 }),
    ];
    const result = checkRelation('hitPoints ≈ (constitution + size) / 10', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalChecked).toBe(2);
    expect(result.matchCount).toBe(0);
    expect(result.mismatches).toEqual([
      { label: 'Bestia', actual: 45, expected: 13 },
      { label: 'Warwick', actual: 55, expected: 11 },
    ]);
    expect(result.warning).toBe('low-match-rate');
  });

  it('relacja poprawnie zmapowana -> zero rozbieznosci, brak ostrzezenia', () => {
    const entities = [
      entity('A', { hitPoints: 13, constitution: 60, size: 70 }),
      entity('B', { hitPoints: 11, constitution: 50, size: 60 }),
      entity('C', { hitPoints: 12, constitution: 55, size: 65 }),
    ];
    const result = checkRelation('hitPoints ≈ (constitution + size) / 10', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mismatches).toEqual([]);
    expect(result.matchCount).toBe(3);
    expect(result.warning).toBeNull();
  });

  it('tolerancja ≈ pochlania zaokraglenie dzielenia (nie tylko dokladne trafienie)', () => {
    const entities = [entity('A', { hitPoints: 13, constitution: 61, size: 70 })]; // (61+70)/10=13.1, zaokraglone 13 — w tolerancji
    const result = checkRelation('hitPoints ≈ (constitution + size) / 10', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mismatches).toEqual([]);
  });

  it('[brief] "=" idealnie zgodne na wszystkich encjach -> ostrzezenie "prawdopodobnie to samo pole zmapowane dwa razy"', () => {
    const entities = [entity('A', { sanity: 55, willpower: 55 }), entity('B', { sanity: 40, willpower: 40 })];
    const result = checkRelation('sanity = willpower', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBe('suspiciously-perfect-equality');
  });

  it('"=" z JEDNA rozbieznoscia na dosc duzej probce -> brak OBU ostrzezen (ani idealna zgodnosc, ani nisla zgodnosc)', () => {
    const entities = [
      entity('A', { sanity: 55, willpower: 55 }),
      entity('B', { sanity: 40, willpower: 40 }),
      entity('C', { sanity: 60, willpower: 60 }),
      entity('D', { sanity: 40, willpower: 45 }),
    ];
    const result = checkRelation('sanity = willpower', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeNull();
    expect(result.mismatches).toEqual([{ label: 'D', actual: 40, expected: 45 }]);
  });

  it('encje bez potrzebnych kluczy sa pomijane z totalChecked, nie liczone jako rozbieznosc', () => {
    const entities = [entity('A', { hitPoints: 13, constitution: 60, size: 70 }), entity('BezDanych', { hitPoints: 5 })];
    const result = checkRelation('hitPoints ≈ (constitution + size) / 10', entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalChecked).toBe(1);
    expect(result.mismatches).toEqual([]);
  });

  it('zla skladnia relacji -> ok:false z czytelnym bledem, nigdy wyjatek', () => {
    const result = checkRelation('to nie jest relacja', []);
    expect(result.ok).toBe(false);
  });

  it('checkRelations sprawdza wiele relacji naraz, jedna po drugiej', () => {
    const entities = [entity('A', { hitPoints: 13, constitution: 60, size: 70, sanity: 55, willpower: 55 })];
    const results = checkRelations(['hitPoints ≈ (constitution + size) / 10', 'sanity = willpower'], entities);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('extractCanonicalValues — [KROK-24 Z3]', () => {
  function fakeEntity(overrides: Partial<EntityAnalysis> = {}): EntityAnalysis {
    return {
      ordinal: 0,
      grid: { pairs: [{ label: 'KON', canonicalKey: 'constitution', value: '60', tokenIndex: 0 }], startIndex: 0, endIndex: 1, bbox: { minX: 0, maxX: 1, minY: 0, maxY: 1 } },
      name: { kind: 'confident', text: 'Bestia', confidence: 1, tokenIndex: 0 },
      derived: { match: null, distance: null, outOfRange: null },
      attacks: { match: null, distance: null, outOfRange: null },
      skills: { match: null, distance: null, outOfRange: null },
      regions: [],
      ...overrides,
    };
  }

  it('laczy pary z grid i z derived.match w jedna mape wartosci', () => {
    const e = fakeEntity({
      derived: {
        match: { pairs: [{ label: 'PW', canonicalKey: 'hitPoints', value: '13', tokenIndex: 1 }], startIndex: 1, endIndex: 2, bbox: { minX: 0, maxX: 1, minY: 0, maxY: 1 } },
        distance: 5,
        outOfRange: null,
      },
    });
    const result = extractCanonicalValues(e);
    expect(result.label).toBe('Bestia');
    expect(result.values).toEqual({ constitution: 60, hitPoints: 13 });
  });

  it('wartosci nie-liczbowe (myslnik, notacja kostek) sa pomijane, nie zerowane', () => {
    const e = fakeEntity({ grid: { pairs: [{ label: 'X', canonicalKey: 'foo', value: '–', tokenIndex: 0 }], startIndex: 0, endIndex: 1, bbox: { minX: 0, maxX: 1, minY: 0, maxY: 1 } } });
    expect(extractCanonicalValues(e).values).toEqual({});
  });

  it('nazwa placeholder -> label to tekst placeholdera', () => {
    const e = fakeEntity({ name: { kind: 'placeholder', placeholder: 'NPC #1 (str. 5)', candidates: [] } });
    expect(extractCanonicalValues(e).label).toBe('NPC #1 (str. 5)');
  });
});
