import { describe, expect, it } from 'vitest';
import { assembleStatblocksOnPage } from '../../src/profiles/assembleStatblocks.js';
import { validateProfile } from '../../src/profiles/schema.js';
import type { ProfileToken } from '../../src/profiles/types.js';

/** Profil minimalny, ale realistyczny — odzwierciedla ksztalt z §5.5 MDD i danych zmierzonych w kroku 12/13. */
function coc7Profile() {
  const result = validateProfile({
    schemaVersion: 2,
    id: 'coc7-niczas-pl',
    gameLine: 'coc7',
    language: 'pl',
    title: 'Zew Cthulhu — Nie czas na krzyk',
    publication: 'niczasnakrzyk-pl-v1.0',
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
        itemPattern: '(?<name>[\\p{L} ()]+?) (?<toHit>\\d{1,3})%',
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

/** Buduje tokeny jednego statbloku na stronie, ulozone od gory (Y wieksze) w dol (Y mniejsze) jak w prawdziwym PDF (str. 30 Zew Cthulhu). */
function row(entries: readonly [string, number] | readonly (readonly [string, number])[], y: number, opts: Partial<ProfileToken> = {}): ProfileToken[] {
  const list = Array.isArray(entries[0]) ? (entries as readonly (readonly [string, number])[]) : [entries as [string, number]];
  return list.map(([text, x]) => ({ text, bbox: { minX: x, maxX: x + 8, minY: y, maxY: y + 10 }, ...opts }));
}

describe('assembleStatblocksOnPage — [KROK-18 Z4]', () => {
  it('sklada pelny statblok (nazwa + siatka + pochodne + ataki) z jednej strony (odzwierciedla str. 30 Zew Cthulhu)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      // Jedna linia tekstu = JEDEN token pdf.js (getTextContent() laczy sasiadujacy
      // tekst tego samego przebiegu po pozycji, patrz CLAUDE.md) — "Joshua Thomas"
      // nie przychodzi jako dwa oddzielne slowa-tokeny na tej samej linii.
      ...row(['Joshua Thomas', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
      ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 50),
      ...row([['ATAKI', 0], ['Walka', 10], ['40%', 20]], 30),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entity).toBeDefined();
    expect(entity!.name.kind).toBe('confident');
    if (entity!.name.kind === 'confident') expect(entity!.name.text).toBe('Joshua Thomas');
    expect(entity!.grid.pairs.map((p) => p.canonicalKey)).toEqual(['strength', 'charisma', 'constitution']);
    expect(entity!.derived).not.toBeNull();
    expect(entity!.derived!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints', 'movement']);
    expect(entity!.attacks).not.toBeNull();
    expect(entity!.attacks!.items[0]!.groups['toHit']).toBe('40');
  });

  it('brak kandydata na nazwe -> placeholder, ale grid/derived/attacks nadal skladane', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
      ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 50),
    ];
    const [entity] = assembleStatblocksOnPage(tokens, profile, 84, 'npc');
    expect(entity!.name).toEqual({ kind: 'placeholder', placeholder: 'NPC ze str. 84 (#1)', candidates: [] });
    expect(entity!.derived).not.toBeNull();
  });

  it('brak sekcji ATAKI na stronie (cywil bez ataku, Z0 — Missy Beaker) -> attacks: null, reszta bez zmian', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Missy', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['70', 30], ['KON', 40], ['60', 50]], 70),
    ];
    const [entity] = assembleStatblocksOnPage(tokens, profile, 84, 'npc');
    expect(entity!.attacks).toBeNull();
    expect(entity!.name.kind).toBe('confident');
  });

  it('wiele statblokow na jednej stronie -> kazdy dostaje wlasna nazwe i wlasne dane (str. 55)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Warwick', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row(['Funkcjonariusz', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 170),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 70),
    ];
    const entities = assembleStatblocksOnPage(tokens, profile, 55, 'npc');
    expect(entities).toHaveLength(2);
    expect(entities.map((e) => (e.name.kind === 'confident' ? e.name.text : 'BRAK'))).toEqual(['Warwick', 'Funkcjonariusz']);
  });

  it('[KROK-20 Z2, zmierzony na zywo blad] ATAKI pierwszej postaci nie polyka siatki DRUGIEJ, gdy miedzy nimi nie stoi zaden naglowek (str. 55 "nie czas na krzyk")', () => {
    const base = coc7Profile();
    // itemPattern z grupa `damage` (lazy .*? do nastepnej pozycji LUB konca
    // bufora) — dokladnie ksztalt z prawdziwego profilu, ktory ujawnil ten
    // blad; prosty wzorzec z `coc7Profile()` (bez grupy `damage`) go nie
    // odtwarza.
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        attackSection: {
          ...base.patterns.attackSection,
          itemPattern: '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)',
        },
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      ...row(['Warwick', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 170),
      ...row([['ATAKI', 0], ['Unik', 10], ['22%', 20]], 150),
      // Brak jakiegokolwiek naglowka miedzy koncem tej sekcji ATAKI a siatka
      // DRUGIEJ postaci — dokladnie uklad ze str. 55.
      ...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 100),
    ];

    const entities = assembleStatblocksOnPage(tokens, profile, 55, 'npc');
    expect(entities).toHaveLength(2);
    const warwick = entities.find((e) => e.name.kind === 'confident' && e.name.text === 'Warwick')!;
    expect(warwick.attacks).not.toBeNull();
    const damage = warwick.attacks!.items.at(-1)!.groups['damage'] ?? '';
    expect(damage).not.toContain('WYG');
    expect(damage.trim()).toBe('');
  });

  it('[KROK-24 Z4b, zmierzony na zywo blad str. 56 "Głowa"] ATAKI pierwszej postaci nie polyka NAZWY drugiej, gdy ta poprzedza jej siatke wlasnym opisem', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        attackSection: {
          ...base.patterns.attackSection,
          itemPattern: '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)',
        },
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      ...row(['Głowa', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 170),
      ...row([['ATAKI', 0], ['Unik', 10], ['20%', 20]], 150),
      // "Nogi" (kandydat na nazwe DRUGIEJ postaci) poprzedza JEJ WLASNA siatke
      // wlasnym opisem -- dokladnie uklad ze str. 56 realnej ksiazki
      // (RAPORT-KROK-22.md): `hardStopTokenIndices` stopowalo dawniej WYLACZNIE
      // na siatkach (naprawione w KROK-20 Z2, test wyzej), nie na kandydatach
      // na nazwe, ktore czasem stoja PRZED siatka z wlasnym opisem miedzy nimi.
      ...row(['Nogi', 0], 120, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['50', 10], ['WYG', 20], ['40', 30], ['KON', 40], ['60', 50]], 100),
    ];

    const entities = assembleStatblocksOnPage(tokens, profile, 56, 'npc');
    expect(entities).toHaveLength(2);
    const glowa = entities.find((e) => e.name.kind === 'confident' && e.name.text === 'Głowa')!;
    expect(glowa.attacks).not.toBeNull();
    expect(glowa.attacks!.items.at(-1)!.groups['damage'] ?? '').not.toContain('Nogi');
    const nogi = entities.find((e) => e.name.kind === 'confident' && e.name.text === 'Nogi')!;
    expect(nogi).toBeDefined();
  });

  it('[KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 23, Hansen] ATAKI nie polyka zapowiedzi KOLEJNEGO potwora (rola `heading`), nawet gdy ta zapowiedz NIE MA wlasnej siatki NA TEJ stronie (prawdziwy statblok dopiero na nastepnej) — sam fakt, ze token wyglada jak tytul/nazwa (`fontRoleCandidate` uzywany do nazw), jest wystarczajaca granica', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        attackSection: {
          ...base.patterns.attackSection,
          itemPattern: '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)',
        },
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      ...row(['Hansen', 0], 200, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 170),
      ...row([['ATAKI', 0], ['Unik', 10], ['20%', 20]], 150),
      // Zapowiedz kolejnego potwora na KONCU strony (jego wlasciwy statblok
      // jest dopiero na NASTEPNEJ stronie, wiec nie ma tu ZADNEJ siatki, do
      // ktorej mogłby sie dolaczyc) — rola `heading`, TA SAMA co uzywana do
      // rozpoznawania prawdziwych nazw encji (`entityName`), a NIE `accent`
      // (zwykle pogrubienie, ktore CELOWO NIE jest granica — patrz test
      // `proseBlock.test.ts` o szumie klasyfikacji fontu WEWNATRZ zwyklej tresci).
      ...row(['SCIAPOD', 0], 120, { fontRole: 'heading', page: 1 }),
      ...row(['Opis nastepnego potwora, niezwiazany z Hansenem.', 0], 100, { page: 1 }),
    ];

    const entities = assembleStatblocksOnPage(tokens, profile, 23, 'npc');
    expect(entities).toHaveLength(1);
    expect(entities[0]!.attacks!.items.at(-1)!.groups['damage'] ?? '').not.toContain('SCIAPOD');
    expect(entities[0]!.attacks!.items.at(-1)!.groups['damage'] ?? '').not.toContain('nastepnego potwora');
  });

  it('[KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 24, "Zaklęcia"/"Utrata Poczytalności" blisko siebie] DWA wzorce notatek z bliskimi offsetami NIE zwracaja tej samej tresci dwa razy — drugi wyklucza to, co pierwszy juz zabral, i poprawnie zwraca brak dopasowania zamiast duplikatu', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        noteZaklecia: { kind: 'proseBlock' as const, label: 'Zaklęcia', offset: { dxPt: 0, dyPt: -10 }, maxLengthChars: 2000, searchRadiusPt: 60 },
        noteUtrata: { kind: 'proseBlock' as const, label: 'Utrata Poczytalności', offset: { dxPt: 0, dyPt: -22 }, maxLengthChars: 2000, searchRadiusPt: 60 },
      },
      entityAssembly: {
        ...base.entityAssembly,
        notesPatterns: ['noteZaklecia', 'noteUtrata'],
      },
    } as typeof base;

    const tokens: ProfileToken[] = [...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 100), ...row(['Zaklęcia: brak.', 0], 90)];

    const entities = assembleStatblocksOnPage(tokens, profile, 24, 'npc');
    expect(entities).toHaveLength(1);
    expect(entities[0]!.notes).toEqual([{ label: 'Zaklęcia', text: 'Zaklęcia: brak.' }]);
  });

  it('[ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze] Bez `chainFromPrevious` druga notatka ma STALY offset wzgledem siatki cech — gdy pierwsza notatka (biografia) rozne dlugosci u roznych postaci, druga notatka przesuwa sie razem z nia i STALY offset trafia u DLUGIEJ biografii w pusto (poza `searchRadiusPt`)', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        noteBio: { kind: 'proseBlock' as const, label: 'Historia', offset: { dxPt: -50, dyPt: -20 }, maxLengthChars: 2000, searchRadiusPt: 60 },
        noteCechy: { kind: 'proseBlock' as const, label: 'Cechy', offset: { dxPt: -50, dyPt: -40 }, maxLengthChars: 2000, searchRadiusPt: 15 },
      },
      entityAssembly: {
        ...base.entityAssembly,
        notesPatterns: ['noteBio', 'noteCechy'],
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      // Postac A: krotka biografia (jeden wiersz) — "Cechy:" laduje DOKLADNIE
      // tam, gdzie wskazuje staly offset (-40 od y=200 -> y=160). Rola `accent`
      // + dwukropek na "Cechy:" to sygnal, na ktorym "Historia" (note1) sama
      // przerywa zbieranie (patrz `proseBlock.ts`) — inaczej polknelaby
      // "Cechy:" jako CZESC wlasnej tresci, zanim note2 w ogole zaczeloby szukac.
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 200),
      ...row(['Historia', 0], 180),
      ...row(['Krótka.', 0], 170),
      ...row(['Cechy:', 0], 160, { fontRole: 'accent' }),
      // Postac B: DLUGA biografia (cztery dodatkowe wiersze) — "Cechy:" jest
      // przez to NIZEJ niz u Postaci A, poza zasiegiem TEGO SAMEGO stalego
      // offsetu (-40 od y=100 -> cel y=60, prawdziwe "Cechy:" jest na y=30,
      // 30pt dalej niz `searchRadiusPt: 15`) — wiersze biografii miedzy nimi
      // sa juz ZAKLAIMOWANE przez note1, wiec nie moga byc przypadkowo
      // zlapane jako falszywy kandydat na "Cechy" w tym samym miejscu.
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 100),
      ...row(['Historia', 0], 80),
      ...row(['Zdanie', 0], 70),
      ...row(['jeden.', 0], 60),
      ...row(['Zdanie', 0], 50),
      ...row(['dwa.', 0], 40),
      ...row(['Cechy:', 0], 30, { fontRole: 'accent' }),
    ];

    const entities = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entities).toHaveLength(2);
    const [postacA, postacB] = entities;
    expect(postacA!.notes.map((n) => n.label)).toEqual(['Historia', 'Cechy']);
    // Postac B: "Cechy" NIE zostalo znalezione (poza zasiegiem) — tylko "Historia".
    expect(postacB!.notes.map((n) => n.label)).toEqual(['Historia']);
  });

  it('[ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze] `chainFromPrevious: true` liczy offset drugiej notatki wzgledem KONCA pierwszej (nie stalego punktu) — dziala poprawnie dla OBU postaci niezaleznie od dlugosci biografii miedzy nimi', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        noteBio: { kind: 'proseBlock' as const, label: 'Historia', offset: { dxPt: -50, dyPt: -20 }, maxLengthChars: 2000, searchRadiusPt: 60 },
        // Ten sam wzorzec co w tescie powyzej, ALE offset liczony wzgledem
        // konca "Historia" (nie wzgledem siatki) — u obu postaci "Cechy"
        // jest zawsze DOKLADNIE jeden wiersz (10pt) pod OSTATNIM tokenem
        // wlasnej biografii, wiec TA SAMA wartosc dziala dla obu.
        noteCechy: { kind: 'proseBlock' as const, label: 'Cechy', offset: { dxPt: 0, dyPt: -10 }, maxLengthChars: 2000, searchRadiusPt: 15, chainFromPrevious: true },
      },
      entityAssembly: {
        ...base.entityAssembly,
        notesPatterns: ['noteBio', 'noteCechy'],
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 200),
      ...row(['Historia', 0], 180),
      ...row(['Krótka.', 0], 170),
      ...row(['Cechy:', 0], 160, { fontRole: 'accent' }),
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 100),
      ...row(['Historia', 0], 80),
      ...row(['Zdanie', 0], 70),
      ...row(['jeden.', 0], 60),
      ...row(['Zdanie', 0], 50),
      ...row(['dwa.', 0], 40),
      ...row(['Cechy:', 0], 30, { fontRole: 'accent' }),
    ];

    const entities = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entities).toHaveLength(2);
    const [postacA, postacB] = entities;
    expect(postacA!.notes.map((n) => n.label)).toEqual(['Historia', 'Cechy']);
    expect(postacB!.notes.map((n) => n.label)).toEqual(['Historia', 'Cechy']);
  });

  it('[ZGŁOSZENIE na zywo, "zaznaczam tylko te dwa, a do nich wpisywane sa wszystkie informacje z tych akapitow"] `stopAtSameFontRole: true` pomija PO DRODZE podnaglowek INNEJ roli (accent) i zatrzymuje sie dopiero na kolejnym naglowku TEJ SAMEJ roli co wlasny start (heading) — domyslnie (bez flagi) zatrzymalby sie na pierwszym podnaglowku niezaleznie od roli', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        // [zmierzone na prawdziwym "Wrak.pdf"] `entityName` MUSI miec wlasny
        // `requireFontKeys` (jak realny profil, draft-12) — inaczej "Historia"/
        // "Przyjaciele:" (rola `heading`, ta sama rola co PRAWDZIWE nazwy
        // encji) same staja sie kandydatami na "granice kolejnej encji"
        // (`allNameCandidateTokenIndices` w `assembleStatblocks.ts`) i przez
        // to `hardStopTokenIndices` — co w tym syntetycznym tescie (bez
        // zadnego prawdziwego tokenu nazwy) fałszywie wyklucza WLASNY start
        // notatki z puli kandydatow. Prawdziwy profil unika tego, bo
        // `requireFontKeys: ['Voltaire@14']` (font PRAWDZIWYCH imion) nigdy
        // nie pasuje do `ACaslonPro-Bold@11` (font tych podnaglowkow) — patrz
        // weryfikacja na 6 stronach `sample/ZewCthulhu-WRAK.pdf`.
        entityName: { ...base.patterns.entityName, requireFontKeys: ['NameFont@14'] },
        noteHistoria: {
          kind: 'proseBlock' as const,
          label: 'Historia',
          offset: { dxPt: -50, dyPt: -20 },
          maxLengthChars: 2000,
          searchRadiusPt: 60,
          stopAtSameFontRole: true,
        },
      },
      entityAssembly: {
        ...base.entityAssembly,
        notesPatterns: ['noteHistoria'],
      },
    } as typeof base;

    const tokens: ProfileToken[] = [
      ...row([['S', 0], ['60', 10], ['WYG', 20], ['45', 30], ['KON', 40], ['65', 50]], 200),
      ...row(['Historia', 0], 180, { fontRole: 'heading' }),
      ...row(['Krótka.', 0], 170),
      // Podnaglowek INNEJ roli (accent) -- z `stopAtSameFontRole: true` NIE
      // przerywa zbierania, bo nie pasuje do roli WLASNEGO startu (heading).
      ...row(['Wygląd:', 0], 160, { fontRole: 'accent' }),
      ...row(['opis.', 0], 150),
      // Naglowek TEJ SAMEJ roli co start (heading) -- TU zbieranie sie zatrzymuje.
      ...row(['Przyjaciele:', 0], 140, { fontRole: 'heading' }),
      ...row(['Nie powinno trafic do notatki.', 0], 130),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    // [ZGŁOSZENIE na zywo, "jedno pod drugim zaczynajace sie od nowej linii"]
    // Podnaglowek PRZELECIANY (nie stopujacy) zaczyna NOWY akapit ("\n\n"),
    // dokladnie tak jak wyglada wizualnie w PDF-ie -- nie jest sklejony w
    // jedna linie z reszta.
    expect(entity!.notes).toEqual([{ label: 'Historia', text: 'Historia Krótka.\n\nWygląd: opis.' }]);
  });

  it('[KROK-20 Z2b] entityAssembly.skillsPattern odrebny od attackSection — obie sekcje sectionList skladane niezaleznie, bez mylenia jednej z druga', () => {
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        // terminateSectionBefore na attackSection tak, jak w prawdziwym profilu
        // (tools/measure-statblocks.ts) — bez niego ATAKI polyka "Umiejętności:
        // ..." jako wlasna, dodatkowa pozycje (osobno juz pokryte przez test
        // patterns.test.ts "terminateSectionBefore przerywa bufor..."; tu chodzi
        // wylacznie o to, czy skillsPattern jest wlasciwie ROZROZNIANY od
        // attackSection, nie o powtorne testowanie terminateSectionBefore).
        attackSection: { ...base.patterns.attackSection, terminateSectionBefore: '^\\p{Lu}[\\p{L} ]*:$' },
        skillsSection: {
          kind: 'sectionList' as const,
          sectionHeader: '^Umiejętności:$',
          itemPattern: '(?<name>[\\p{L} ]+?) (?<value>\\d{1,3})%',
        },
      },
      entityAssembly: {
        ...base.entityAssembly,
        attach: [...base.entityAssembly.attach, { pattern: 'skillsSection', strategy: 'nearestBelow' as const, maxDistancePt: 200 }],
        skillsPattern: 'skillsSection',
      },
    };

    const tokens: ProfileToken[] = [
      ...row(['Joshua Thomas', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
      ...row([['ATAKI', 0], ['Walka', 10], ['40%', 20]], 50),
      ...row([['Umiejętności:', 0], ['Historia', 10], ['75%', 20]], 30),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entity!.attacks).not.toBeNull();
    expect(entity!.attacks!.items.map((i) => i.groups['name']?.trim())).toEqual(['Walka']);
    expect(entity!.skills).not.toBeNull();
    expect(entity!.skills!.items.map((i) => i.groups['name']?.trim())).toEqual(['Historia']);
  });

  it('bez entityAssembly.skillsPattern -> skills zawsze null (zachowanie sprzed KROK-20 Z2b, wsteczna zgodnosc)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Joshua Thomas', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];
    const [entity] = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entity!.skills).toBeNull();
  });

  it('[ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] entityAssembly.typeLabelPattern wypelnia typeLabel NIEZALEZNIE od nazwy, oba wzorce rozroznione przez wlasny requireFontKeys', () => {
    // Zmierzone wprost na str. 23 "Zew Cthulhu 7ed. Wrak.pdf": "John Calhoun,"
    // pogrubiony, "kapitan jachtu" kursywa -- DWA rozne fontKey odrozniaja
    // nazwe od zawodu/typu, ktore wczesniej dzielily jeden wzorzec
    // `fontRoleCandidate` i konkurowaly o to samo pole.
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
        // `occupationLabel` postawiony PRZED `entityName` w `attach` — bez
        // wykluczenia `typeLabelPattern` z `.find()` po `kind`, silnik trafilby
        // na `occupationLabel` jako "nazwe", zaleznie od kolejnosci w tablicy.
        attach: [{ pattern: 'occupationLabel', strategy: 'nearestAbove' as const, maxDistancePt: 120 }, ...base.entityAssembly.attach],
        typeLabelPattern: 'occupationLabel',
      },
    };

    const tokens: ProfileToken[] = [
      ...row(['John Calhoun,', 0], 100, { fontRole: 'accent', fontKey: 'Bold@11', page: 1 }),
      ...row(['kapitan jachtu', 20], 100, { fontRole: 'accent', fontKey: 'Italic@11', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 23, 'npc');
    expect(entity!.name.kind).toBe('confident');
    // [KROK-20 Z2] Koncowy przecinek obcinany z kandydata na nazwe -- nie
    // dotyczy tego zgloszenia, dziedziczone zachowanie `matchFontRoleCandidate`.
    if (entity!.name.kind === 'confident') expect(entity!.name.text).toBe('John Calhoun');
    expect(entity!.typeLabel).toBe('kapitan jachtu');
  });

  it('[ZGŁOSZENIE po kroku 30, zmierzony na zywo blad] BEZ requireFontKeys (jeszcze nie zawezone) typeLabel NIE powiela nazwy — token juz zajety przez name jest wykluczony z puli zawodu/typu', () => {
    // Zmierzone wprost: "w obu miejscach jest name, a nie name i zawód" —
    // gdy oba wzorce (nazwa/zawod) maja PUSTE `requireFontKeys` (autor
    // jeszcze nie klikal, albo klikniety token nie mial rozpoznanego
    // fontKey), obie pule kandydatow sa identyczne i kazde z dwoch
    // NIEZALEZNYCH wywolan (`resolveEntityNames`/`attachNearest`, kazde z
    // WLASNYM `used`) wybiera ten sam, geometrycznie najblizszy token.
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        // Celowo BEZ requireFontKeys na obu -- dokladnie stan z realnego
        // zgloszenia (`profiles/wrakv1.json`: oba wzorce identyczne).
        occupationLabel: {
          kind: 'fontRoleCandidate' as const,
          excludeRoles: ['body'],
          maxLength: 60,
          excludeRepeatedAcrossPages: true,
          excludeHyphenContinuations: true,
          requireFontKeys: [],
        },
      },
      entityAssembly: {
        ...base.entityAssembly,
        attach: [{ pattern: 'occupationLabel', strategy: 'nearestAbove' as const, maxDistancePt: 120 }, ...base.entityAssembly.attach],
        typeLabelPattern: 'occupationLabel',
      },
    };

    const tokens: ProfileToken[] = [
      ...row(['John Calhoun,', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row(['kapitan jachtu', 20], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 23, 'npc');
    expect(entity!.name.kind).toBe('confident');
    if (entity!.name.kind === 'confident') expect(entity!.name.text).toBe('John Calhoun');
    expect(entity!.typeLabel).toBe('kapitan jachtu');
    expect(entity!.typeLabel).not.toBe(entity!.name.kind === 'confident' ? entity!.name.text : null);
  });

  it('[ZGŁOSZENIE po kroku 30, "Dlaczego muszę wskazywać ręcznie, skoro profil już to zawiera"] wskazanie WLASNEGO wzorca zawodu/typu wystarcza, zeby SILNIK sam rozstrzygnal dwuznacznosc nazwy — bez preferEarlierSibling i bez requireFontKeys', () => {
    // Dokladnie uklad realnego profilu uzytkownika (`profiles/wrakv1.json`):
    // ANI `entityName`, ANI `occupationLabel` nie maja `requireFontKeys` (autor
    // jeszcze nie zdazyl ich zawezic), a `entityName`'s regula dolaczenia NIE
    // ma `preferEarlierSibling`. Mimo to sam fakt, ze autor wskazal OSOBNY
    // wzorzec zawodu/typu (`typeLabelPattern`), jest juz wystarczajaca
    // informacja: "kapitan jachtu" pasuje do `occupationLabel`, wiec
    // `resolveEntityNames` przestaje traktowac go jako prawdziwego konkurenta
    // "John Calhoun," w liczeniu dwuznacznosci (`knownSiblingTokenIndices`)
    // — nazwa wychodzi PEWNA bez pytania czlowieka o wybor podczas przegladu.
    const base = coc7Profile();
    const profile = {
      ...base,
      patterns: {
        ...base.patterns,
        occupationLabel: {
          kind: 'fontRoleCandidate' as const,
          excludeRoles: ['body'],
          maxLength: 60,
          excludeRepeatedAcrossPages: true,
          excludeHyphenContinuations: true,
          requireFontKeys: [],
        },
      },
      entityAssembly: {
        ...base.entityAssembly,
        // Regula dla `entityName` PRZEBUDOWANA bez `preferEarlierSibling` —
        // dokladnie stan realnego `profiles/wrakv1.json` (autor jeszcze nie
        // skonfigurowal tego pola dla nazwy).
        attach: [
          { pattern: 'occupationLabel', strategy: 'nearestAbove' as const, maxDistancePt: 120 },
          { pattern: 'derivedBlock', strategy: 'nearestBelow' as const, maxDistancePt: 60 },
          { pattern: 'attackSection', strategy: 'nearestBelow' as const, maxDistancePt: 200 },
          { pattern: 'entityName', strategy: 'nearestAbove' as const, maxDistancePt: 120 },
        ],
        typeLabelPattern: 'occupationLabel',
      },
    };

    const tokens: ProfileToken[] = [
      ...row(['John Calhoun,', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row(['kapitan jachtu', 20], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];

    const [entity] = assembleStatblocksOnPage(tokens, profile, 23, 'npc');
    expect(entity!.name.kind).toBe('confident');
    if (entity!.name.kind === 'confident') expect(entity!.name.text).toBe('John Calhoun');
    expect(entity!.typeLabel).toBe('kapitan jachtu');
  });

  it('bez entityAssembly.typeLabelPattern -> typeLabel zawsze null (wsteczna zgodnosc)', () => {
    const profile = coc7Profile();
    const tokens: ProfileToken[] = [
      ...row(['Joshua Thomas', 0], 100, { fontRole: 'accent', page: 1 }),
      ...row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], 70),
    ];
    const [entity] = assembleStatblocksOnPage(tokens, profile, 30, 'npc');
    expect(entity!.typeLabel).toBeNull();
  });

  it('rzuca czytelny blad, gdy kotwica w profilu nie jest labelledPairs', () => {
    const profile = coc7Profile();
    const bad = { ...profile, entityAssembly: { ...profile.entityAssembly, anchor: 'attackSection' } };
    expect(() => assembleStatblocksOnPage([], bad, 1, 'npc')).toThrow(/labelledPairs/);
  });
});
