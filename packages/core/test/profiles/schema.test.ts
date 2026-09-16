import { describe, expect, it } from 'vitest';
import { validateProfile } from '../../src/profiles/schema.js';

/** Minimalny, poprawny profil v2 zgodny z Bindery-MDD-v2.1.md §5.5 — do modyfikacji per test. */
function validProfileJson(): unknown {
  return {
    schemaVersion: 2,
    id: 'coc7-niczas-pl',
    gameLine: 'coc7',
    language: 'pl',
    title: 'Zew Cthulhu — Nie czas na krzyk',
    publication: 'niczasnakrzyk-pl-v1.0',
    provides: ['actors'],
    fingerprint: { keywords: ['Poczytalność', 'Krzepa'], minScore: 0.65 },
    pages: { include: [[1, -1]] },
    patterns: {
      characteristicGrid: {
        kind: 'labelledPairs',
        labels: { S: 'strength', KON: 'constitution' },
        valuePattern: '^(\\d{1,3}|[–—-])$',
        minPairs: 3,
        terminate: { onRepeatedLabel: true, maxGapPt: 40 },
      },
      attackSection: {
        kind: 'sectionList',
        sectionHeader: '^ATAKI$',
        itemPattern: '(?<name>.+?) (?<toHit>\\d{1,3})%',
      },
      entityName: {
        kind: 'fontRoleCandidate',
      },
    },
    entityAssembly: {
      anchor: 'characteristicGrid',
      attach: [{ pattern: 'attackSection', strategy: 'nearestBelow', maxDistancePt: 200 }],
      nameConfidenceThreshold: 0.7,
      namePlaceholder: 'NPC ze str. {page} (#{ordinal})',
    },
  };
}

describe('validateProfile — [KROK-18 Z2]', () => {
  it('akceptuje minimalny poprawny profil v2 i wypelnia wartosci domyslne', () => {
    const result = validateProfile(validProfileJson());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.id).toBe('coc7-niczas-pl');
    expect(result.profile.entityAssembly.allowCrossPage).toBe(false);
    const grid = result.profile.patterns['characteristicGrid'];
    expect(grid?.kind).toBe('labelledPairs');
  });

  it('nigdy nie rzuca na zly wejsciowy JSON — zwraca ok:false z czytelnymi bledami', () => {
    expect(() => validateProfile(null)).not.toThrow();
    expect(() => validateProfile('nie jestem profilem')).not.toThrow();
    expect(() => validateProfile(42)).not.toThrow();
    const result = validateProfile({ not: 'a profile' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('odrzuca profil z niepoprawna wersja schematu, czytelny blad wskazuje pole', () => {
    const bad = { ...validProfileJson() as Record<string, unknown>, schemaVersion: 1 };
    const result = validateProfile(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.some((i) => i.startsWith('schemaVersion'))).toBe(true);
  });

  it('odrzuca profil z pustym patterns (R2 — profil musi definiowac chocby jeden wzorzec)', () => {
    const bad = { ...validProfileJson() as Record<string, unknown>, patterns: {} };
    const result = validateProfile(bad);
    expect(result.ok).toBe(false);
  });

  it('[KROK-34, zmierzony na zywo blad, "name: may not be undefined" w Foundry] odrzuca sectionList z pustym itemPattern — bez tego profil ladowal sie poprawnie, ale kazda pozycja sekcji dostawala pusta nazwe, ktora Foundry odrzucalo dopiero przy tworzeniu Item-u', () => {
    const json = validProfileJson() as { patterns: { attackSection: { itemPattern: string } } };
    json.patterns.attackSection.itemPattern = '';
    const result = validateProfile(json);
    expect(result.ok).toBe(false);
  });

  it('odrzuca labelledPairs bez zadnej etykiety', () => {
    const json = validProfileJson() as { patterns: { characteristicGrid: { labels: unknown } } };
    json.patterns.characteristicGrid.labels = {};
    const result = validateProfile(json);
    expect(result.ok).toBe(false);
  });

  it('odrzuca entityAssembly.nameConfidenceThreshold spoza [0,1]', () => {
    const json = validProfileJson() as { entityAssembly: { nameConfidenceThreshold: number } };
    json.entityAssembly.nameConfidenceThreshold = 1.5;
    const result = validateProfile(json);
    expect(result.ok).toBe(false);
  });

  it('odrzuca nieznany "kind" wzorca (dyskryminowana unia)', () => {
    const json = validProfileJson() as { patterns: Record<string, unknown> };
    json.patterns['characteristicGrid'] = { kind: 'somethingElse' };
    const result = validateProfile(json);
    expect(result.ok).toBe(false);
  });

  it('akceptuje pelny profil z §5.5 MDD (fingerprint/pages/images w calosci)', () => {
    const full = {
      ...validProfileJson() as Record<string, unknown>,
      author: 'ktos',
      license: 'CC-BY-4.0',
      pages: { include: [[1, -1]], excludeZones: [{ kind: 'header', yFrom: 0, yTo: 0.05 }] },
      images: {
        associateWithEntity: { strategy: 'nearest', searchDirection: ['above', 'left'], sameColumnOnly: true, maxDistancePt: 220 },
      },
    };
    const result = validateProfile(full);
    expect(result.ok).toBe(true);
  });

  it('[na zyczenie uzytkownika] akceptuje images.treatFullBleedAsContent SAMO, bez associateWithEntity (pole stalo sie opcjonalne)', () => {
    const json = {
      ...validProfileJson() as Record<string, unknown>,
      images: { treatFullBleedAsContent: true },
    };
    const result = validateProfile(json);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.images?.treatFullBleedAsContent).toBe(true);
    expect(result.profile.images?.associateWithEntity).toBeUndefined();
  });

  it('[na zyczenie uzytkownika] brak images -> treatFullBleedAsContent nieobecne (nie domyslnie wymuszone), zachowanie bez zmian', () => {
    const result = validateProfile(validProfileJson());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.images).toBeUndefined();
  });
});
