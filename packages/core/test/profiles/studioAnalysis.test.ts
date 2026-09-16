import { describe, expect, it } from 'vitest';
import { analyzeProfilePage, aggregateDocumentAnalysis, buildDiagnosticsExport, type PageAnalysis } from '../../src/profiles/studioAnalysis.js';
import { validateProfile, type ProfileV2 } from '../../src/profiles/schema.js';
import type { ProfileToken } from '../../src/profiles/types.js';

/** Ten sam ksztalt profilu co `assembleStatblocks.test.ts` — Profile Studio uzywa DOKLADNIE tych samych prymitywow, wiec ten sam profil testowy jest reprezentatywny. */
function coc7Profile(): ProfileV2 {
  const result = validateProfile({
    schemaVersion: 2,
    id: 'coc7-niczas-pl',
    gameLine: 'coc7',
    language: 'pl',
    title: 'Test',
    publication: 'test-v1',
    provides: ['actors'],
    fingerprint: { minScore: 0.5 },
    pages: { include: [[1, -1]] },
    patterns: {
      characteristicGrid: {
        kind: 'labelledPairs',
        labels: { S: 'strength', WYG: 'charisma', KON: 'constitution' },
        valuePattern: '^(\\d{1,3}|[–—-])$',
        minPairs: 3,
        terminate: { onRepeatedLabel: true },
      },
      derivedBlock: {
        kind: 'labelledPairs',
        labels: { PW: 'hitPoints', Ruch: 'movement' },
        valuePattern: '^.+$',
        minPairs: 2,
        terminate: { onRepeatedLabel: true },
      },
      attackSection: {
        kind: 'sectionList',
        sectionHeader: '^ATAKI$',
        itemPattern: '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)',
      },
      entityName: { kind: 'fontRoleCandidate', excludeRoles: ['body'] },
    },
    entityAssembly: {
      anchor: 'characteristicGrid',
      attach: [
        { pattern: 'derivedBlock', strategy: 'nearestBelow', maxDistancePt: 60 },
        { pattern: 'attackSection', strategy: 'nearestBelow', maxDistancePt: 200 },
        { pattern: 'entityName', strategy: 'nearestAbove', maxDistancePt: 120, preferEarlierSibling: { maxDeltaYPt: 20 } },
      ],
      nameConfidenceThreshold: 0.7,
      namePlaceholder: 'NPC ze str. {page} (#{ordinal})',
    },
  });
  if (!result.ok) throw new Error(`profil testowy niepoprawny: ${result.issues.join('; ')}`);
  return result.profile;
}

function row(entries: readonly [string, number] | readonly (readonly [string, number])[], y: number, opts: Partial<ProfileToken> = {}): ProfileToken[] {
  const list = Array.isArray(entries[0]) ? (entries as readonly (readonly [string, number])[]) : [entries as [string, number]];
  return list.map(([text, x]) => ({ text, bbox: { minX: x, maxX: x + 8, minY: y, maxY: y + 10 }, ...opts }));
}

describe('analyzeProfilePage — [KROK-22 Z2/Z3, trasy od KROK-39 Z1]', () => {
  it('trasa playerCharacter bez sekcji wzorcow w profilu -> analiza pusta, routeSupported false, zero pracy silnika', () => {
    const profile = coc7Profile();
    const analysis = analyzeProfilePage([{ text: 'cokolwiek', bbox: { minX: 0, maxX: 8, minY: 0, maxY: 10 } }], profile, 33, 'playerCharacter');
    expect(analysis).toEqual({ page: 33, route: 'playerCharacter', routeSupported: false, entities: [], nameCandidates: [], overlaps: [], patternMatchCounts: [] });
  });

  it('[odkrycie #6 kroku 21] kandydat ISTNIEJE, ale za daleko -> outOfRange z dystansem i limitem, nie cichy null', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200),
      // Blok pochodnych ISTNIEJE na stronie, ale 150pt ponizej -- limit derivedBlock to 60pt.
      ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 50),
    ];
    const [entity] = analyzeProfilePage(tokens, profile, 31, 'npc').entities;
    expect(entity!.derived.match).toBeNull();
    expect(entity!.derived.outOfRange).not.toBeNull();
    expect(entity!.derived.outOfRange!.maxDistancePt).toBe(60);
    expect(entity!.derived.outOfRange!.distance).toBeGreaterThan(60);
    expect(entity!.derived.outOfRange!.distance).toBeLessThan(200); // realny dystans (~140pt), nie jakas duza liczba domyslna
  });

  it('brak JAKIEGOKOLWIEK kandydata na stronie -> outOfRange null (odrozniane od "kandydat za daleko")', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200)];
    const [entity] = analyzeProfilePage(tokens, profile, 84, 'npc').entities;
    expect(entity!.derived.match).toBeNull();
    expect(entity!.derived.outOfRange).toBeNull();
  });

  it('[KROK-24 Z4b, naprawiony blad kroku 20/21] sekcja ATAKI pierwszej encji NIE polyka juz kandydata na nazwe DRUGIEJ (miedzy nimi brak naglowka)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Głowa', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 170),
      ...row([['ATAKI', 0], ['Unik', 10], ['50%', 20]], 150),
      // Brak zadnego naglowka miedzy koncem ATAKI Glowy a kandydatem na nazwe Nog --
      // dokladnie uklad zmierzony wprost na str. 56 realnej ksiazki
      // (RAPORT-KROK-22.md). Dawniej `hardStopTokenIndices` stopowalo WYLACZNIE
      // na GRIDACH (siatkach cech), nie na kandydatach na nazwe, wiec ATAKI
      // Glowy polykalo "Nogi" jako opis obrazen. Naprawa (KROK-24 Z4b): nazwa
      // jest rozwiazywana PRZED sekcjami ATAKI/Umiejetnosci, a KAZDA
      // rozwiazana z ufnoscia ("confident") nazwa dolacza do granic bufora
      // sekcji obok samych siatek.
      ...row(['Nogi', 0], 120, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 100),
    ];
    const analysis = analyzeProfilePage(tokens, profile, 56, 'npc');
    expect(analysis.entities).toHaveLength(2);
    const glowa = analysis.entities.find((e) => e.name.kind === 'confident' && e.name.text === 'Głowa')!;
    expect(glowa.attacks.match).not.toBeNull();
    expect(glowa.attacks.match!.items.at(-1)!.groups['damage']).not.toContain('Nogi');
    // Bez polkniecia nie ma tez juz powodu do zachodzenia miedzy tymi dwiema encjami.
    expect(analysis.overlaps).toEqual([]);
  });

  it('dwie oddzielne, nieprzeciete encje -> brak zachodzenia', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Warwick', 0], 500, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 470),
      ...row(['Pielęgniarka', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 170),
    ];
    const analysis = analyzeProfilePage(tokens, profile, 55, 'npc');
    expect(analysis.entities).toHaveLength(2);
    expect(analysis.overlaps).toEqual([]);
  });

  it('kandydaci na nazwe klasyfikowani: wybrany / sugerowany (w placeholderze) / inny (szum)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Prawdziwa Nazwa', 0], 220, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200),
      // Druga encja BEZ jednoznacznego kandydata w zasiegu (dwuznacznosc: dwa
      // teksty prawie rownie blisko) -> placeholder z lista sugestii.
      ...row(['Kandydat A', 0], 120, { fontRole: 'accent', page: 1 }),
      ...row(['Kandydat B', 1], 121, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 100),
      // Zupelnie niepowiazany tekst gdzies indziej na stronie (szum, poza zasiegiem obu kotwic).
      ...row(['Zupelnie Bez Zwiazku', 0], 900, { fontRole: 'accent', page: 1 }),
    ];
    const analysis = analyzeProfilePage(tokens, profile, 1, 'npc');
    const byText = new Map(analysis.nameCandidates.map((c) => [c.text, c]));
    expect(byText.get('Prawdziwa Nazwa')!.status).toBe('selected');
    expect(byText.get('Kandydat A')!.status).toBe('suggested');
    expect(byText.get('Zupelnie Bez Zwiazku')!.status).toBe('other');
    expect(byText.get('Zupelnie Bez Zwiazku')!.entityOrdinal).toBeNull();
  });

  it('[ZGŁOSZENIE po kroku 30] entityAssembly.typeLabelPattern skladany rownolegle do nazwy, jako WLASNA diagnostyka (nie myli sie z nazwa mimo obu bedacych fontRoleCandidate)', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        entityName: { ...base.patterns.entityName, requireFontKeys: ['Bold@11'] },
        occupationLabel: { kind: 'fontRoleCandidate' as const, excludeRoles: ['body'], requireFontKeys: ['Italic@11'] },
      },
      entityAssembly: {
        ...base.entityAssembly,
        attach: [{ pattern: 'occupationLabel', strategy: 'nearestAbove' as const, maxDistancePt: 120 }, ...base.entityAssembly.attach],
        typeLabelPattern: 'occupationLabel',
      },
    };
    const tokens: ProfileToken[] = [
      ...row(['John Calhoun,', 0], 100, { fontRole: 'accent', fontKey: 'Bold@11', page: 1 }),
      ...row(['kapitan jachtu', 20], 100, { fontRole: 'accent', fontKey: 'Italic@11', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];
    const [entity] = analyzeProfilePage(tokens, profile, 1, 'npc').entities;
    expect(entity!.name.kind).toBe('confident');
    if (entity!.name.kind === 'confident') expect(entity!.name.text).toBe('John Calhoun');
    expect(entity!.typeLabel.match?.text).toBe('kapitan jachtu');
    expect(entity!.regions.map((r) => r.kind)).toContain('typeLabel');
  });

  it('rozklad trafien per wzorzec: wzorzec ktory nigdy nic nie zlapal na stronie dostaje matchCount 0 (literowka w regexie)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200)];
    const analysis = analyzeProfilePage(tokens, profile, 1, 'npc');
    const byId = new Map(analysis.patternMatchCounts.map((c) => [c.patternId, c.matchCount]));
    expect(byId.get('characteristicGrid')).toBe(1);
    expect(byId.get('attackSection')).toBe(0); // brak ATAKI na tej stronie -- widoczne wprost, nie zgadywane
  });
});

describe('aggregateDocumentAnalysis — [KROK-22 Z4]', () => {
  it('sumuje trafienia per wzorzec i liczniki po WSZYSTKICH stronach, w tym pominietych (pregen)', () => {
    const profile = coc7Profile();
    const pageA = analyzeProfilePage([...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200)], profile, 1, 'npc');
    const pageB = analyzeProfilePage([...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 200)], profile, 2, 'npc');
    const pregenPage: PageAnalysis = { page: 3, route: 'playerCharacter', routeSupported: false, entities: [], nameCandidates: [], overlaps: [], patternMatchCounts: [] };

    const doc = aggregateDocumentAnalysis([pageA, pageB, pregenPage]);
    expect(doc.pageCount).toBe(3);
    expect(doc.totalEntities).toBe(2);
    expect(doc.pageSummaries.find((p) => p.page === 3)!.routeSupported).toBe(false);
    const byId = new Map(doc.patternMatchTotals.map((c) => [c.patternId, c.matchCount]));
    expect(byId.get('characteristicGrid')).toBe(2); // po jednym na strone A i B, pregen nie liczony
  });
});

describe('buildDiagnosticsExport — [KROK-22 Z5]', () => {
  it('deterministyczny (bez daty/losowosci) i pomija strony bez zadnej tresci, ale zachowuje pregen jako informacje', () => {
    const profile = coc7Profile();
    const withEntity = analyzeProfilePage([...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200)], profile, 1, 'npc');
    const emptyPage = analyzeProfilePage([], profile, 2, 'npc');
    const pregenPage: PageAnalysis = { page: 3, route: 'playerCharacter', routeSupported: false, entities: [], nameCandidates: [], overlaps: [], patternMatchCounts: [] };
    const doc = aggregateDocumentAnalysis([withEntity, emptyPage, pregenPage]);

    const first = buildDiagnosticsExport(doc);
    const second = buildDiagnosticsExport(doc);
    expect(first).toEqual(second); // determinizm — ta sama analiza -> identyczny JSON za kazdym razem

    expect(first.strony.map((s) => s.strona)).toEqual([1, 3]); // strona 2 (pusta, nie-pregen) pominieta, pregen zostaje widoczny
    expect(first.strony.find((s) => s.strona === 3)!.trasaObslugiwana).toBe(false);
  });

  it('kandydat poza zasiegiem eksportowany z dystansem i limitem, nie jako goly "brak"', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 200),
      ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 50), // 150pt ponizej, limit derivedBlock to 60pt
    ];
    const analysis = analyzeProfilePage(tokens, profile, 31, 'npc');
    const doc = aggregateDocumentAnalysis([analysis]);
    const exported = buildDiagnosticsExport(doc);
    const entity = exported.strony[0]!.encje[0]!;
    expect(entity.derived).toEqual({ status: 'poza-zasiegiem', dystans: expect.any(Number), limit: 60 });
  });
});
