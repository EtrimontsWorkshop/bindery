import { describe, expect, it } from 'vitest';
import { resolve, NEUTRAL_CONTENT_KINDS } from '../../src/cif/resolve.js';
import type { Detection } from '../../src/cif/resolve.js';
import type { ProfileV2 } from '../../src/profiles/schema.js';
import type { SystemAdapter } from '../../src/cif/adapter.js';

/** Minimalny, ale schematycznie poprawny profil CoC7 — tylko pola czytane przez `resolve`. */
function makeProfile(overrides: Partial<ProfileV2> = {}): ProfileV2 {
  return {
    schemaVersion: 2,
    id: 'coc7-niczas-pl',
    gameLine: 'coc7',
    language: 'pl',
    title: 'Zew Cthulhu — Nie czas na krzyk',
    publication: 'niczasnakrzyk-pl-v1.0',
    provides: ['actors', 'journals', 'scenes', 'images'],
    fingerprint: { minScore: 0.5 },
    pages: { include: [[1, -1]] },
    patterns: { entityName: { kind: 'fontRoleCandidate', excludeRoles: ['body'], maxLength: 60 } },
    entityAssembly: {
      anchor: 'entityName',
      attach: [],
      nameConfidenceThreshold: 0.7,
      namePlaceholder: 'NPC #{ordinal}',
    },
    ...overrides,
  } as ProfileV2;
}

function makeCoc7Adapter(overrides: Partial<SystemAdapter> = {}): SystemAdapter {
  return {
    id: 'coc7-native',
    systemId: 'CoC7',
    systemVersion: '>=8.0.0',
    accepts: ['coc7'],
    produces: ['actors', 'items'],
    label: 'Call of Cthulhu 7. edycja (natywny)',
    fromActor: () => ({ data: {}, notes: [], issues: [] }),
    ...overrides,
  };
}

describe('resolve — [KROK-19 Z2, MDD §6.5]', () => {
  it('kind=none -> generic, wylacznie tresc neutralna', () => {
    const det: Detection = { kind: 'none', scored: [] };
    const result = resolve(det, [makeCoc7Adapter()], 'CoC7', '8.1.0');
    expect(result).toEqual({ kind: 'generic', allowed: NEUTRAL_CONTENT_KINDS });
  });

  it('kind=ambiguous -> ambiguous, max 3 kandydatow', () => {
    const profiles = [makeProfile({ id: 'a' }), makeProfile({ id: 'b' }), makeProfile({ id: 'c' }), makeProfile({ id: 'd' })];
    const det: Detection = { kind: 'ambiguous', candidates: profiles.map((profile) => ({ profile, score: 0.5 })) };
    const result = resolve(det, [], 'CoC7', '8.1.0');
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(3);
  });

  it('[scenariusz DoD] profil CoC w swiecie WFRP (brak adaptera akceptujacego "coc7") -> partial, reason=line-mismatch, aktorzy/przedmioty zablokowane, tresc neutralna przechodzi', () => {
    const profile = makeProfile();
    const det: Detection = { kind: 'confident', profile, score: 0.87 };
    // Adapter zarejestrowany, ale dla INNEGO systemu (WFRP4e) — symuluje "brak adaptera dla tej linii" w swiecie CoC.
    const wfrpAdapter = makeCoc7Adapter({ id: 'wfrp4e-native', systemId: 'wfrp4e', accepts: ['wfrp4e'] });
    const result = resolve(det, [wfrpAdapter], 'wfrp4e', '6.0.0');
    expect(result).toEqual({
      kind: 'partial',
      profile,
      allowed: NEUTRAL_CONTENT_KINDS,
      blocked: ['actors', 'items'],
      reason: 'line-mismatch',
    });
  });

  it('brak JAKIEGOKOLWIEK adaptera zarejestrowanego dla aktywnego systemu -> partial, reason=no-adapter', () => {
    const profile = makeProfile();
    const det: Detection = { kind: 'confident', profile, score: 0.9 };
    const result = resolve(det, [], 'CoC7', '8.1.0');
    expect(result).toEqual({ kind: 'partial', profile, allowed: NEUTRAL_CONTENT_KINDS, blocked: ['actors', 'items'], reason: 'no-adapter' });
  });

  it('adapter dla systemu istnieje, ale wymaga wyzszej wersji -> partial, reason=version-mismatch, niesie wymagana wersje dla banera §6.8', () => {
    const profile = makeProfile();
    const det: Detection = { kind: 'confident', profile, score: 0.9 };
    const adapter = makeCoc7Adapter({ systemVersion: '>=9.0.0' });
    const result = resolve(det, [adapter], 'CoC7', '8.1.0');
    expect(result).toEqual({
      kind: 'partial',
      profile,
      allowed: NEUTRAL_CONTENT_KINDS,
      blocked: ['actors', 'items'],
      reason: 'version-mismatch',
      requiredVersion: '>=9.0.0',
    });
  });

  it('dopasowanie pelne: system i wersja zgodne -> full, allowed = przeciecie provides profilu i (produces adaptera + neutralne)', () => {
    const profile = makeProfile({ provides: ['actors', 'journals'] });
    const det: Detection = { kind: 'confident', profile, score: 0.95 };
    const adapter = makeCoc7Adapter();
    const result = resolve(det, [adapter], 'CoC7', '8.2.1');
    expect(result.kind).toBe('full');
    expect(result.kind === 'full' && result.adapter).toBe(adapter);
    expect(result.kind === 'full' && [...result.allowed].sort()).toEqual(['actors', 'journals']);
  });

  it('fallback uniwersalny: adapter bez dopasowania gameLine, ale z accepts=["*"], jest uzyty', () => {
    const profile = makeProfile({ gameLine: 'dragonbane' });
    const det: Detection = { kind: 'confident', profile, score: 0.8 };
    const generic = makeCoc7Adapter({ id: 'generic-flat', systemId: 'CoC7', accepts: ['*'], produces: ['actors'] });
    const result = resolve(det, [generic], 'CoC7', '8.1.0');
    expect(result.kind).toBe('full');
    expect(result.kind === 'full' && result.adapter.id).toBe('generic-flat');
  });
});
