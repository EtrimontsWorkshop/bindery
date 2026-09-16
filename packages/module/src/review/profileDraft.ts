/**
 * [KROK-23 Z1-Z5] Kształt szkicu profilu w edytorze Profile Studio — CZYSTA
 * wygoda UI (listy zamiast rekordów, żeby dało się bezpiecznie edytować
 * wiersz-po-wierszu bez gubienia kolejności/tożsamości), NIE walidacja.
 * Walidacja/decyzja "czy to jest poprawny profil" zostaje WYŁĄCZNIE w
 * `@bindery/core`'s `validateProfile` (Zod) — ten plik tylko przekształca
 * tam i z powrotem. Zero importu `@bindery/core` tutaj (typy trzymane jako
 * plain object shape), żeby ten plik dało się swobodnie importować statycznie
 * bez wpływu na I3/`check:size` (patrz `ProfileStudioLauncher.ts`).
 */

export interface LabelEntryDraft {
  label: string;
  canonicalKey: string;
}

export interface LabelledPairsPatternDraft {
  kind: 'labelledPairs';
  labels: LabelEntryDraft[];
  valuePattern: string;
  minPairs: number;
  maxPairs?: number;
  onRepeatedLabel: boolean;
  maxGapPt?: number;
  allowTrailingWords: boolean;
  unit?: string;
  trailingWordsStopBefore?: string;
}

export interface SectionListPatternDraft {
  kind: 'sectionList';
  sectionHeader: string;
  itemPattern: string;
  rejoinHyphenated: boolean;
  skipAfterHeader?: string;
  terminateSectionBefore?: string;
  /** [KROK-40] Slowa/frazy oznaczajace bron dystansowa — patrz `SectionListPattern.rangedKeywords` w `@bindery/core`. */
  rangedKeywords: string[];
}

export interface FontRoleCandidatePatternDraft {
  kind: 'fontRoleCandidate';
  excludeRoles: string[];
  maxLength: number;
  excludeRepeatedAcrossPages: boolean;
  excludeHyphenContinuations: boolean;
  /** [KROK-29 Z3] Klucze fontu wyuczone klikniecim w zakladce "Nazwa" — puste = zachowanie bez zmian. */
  requireFontKeys: string[];
}

/**
 * [KROK-34 Z2] "Notatki wskazywane w PDF-ie" — `offsetDxPt`/`offsetDyPt` sa
 * ZAWSZE liczbowe (schemat `@bindery/core` tego wymaga, zero pola opcjonalne),
 * domyslnie `{0,0}` (jeszcze nie zmierzone -> punkt startowy = koniec wlasnej
 * tresci encji, patrz `lastClaimedTokenBbox`) — UI odroznia "jeszcze nie
 * zmierzone" polem `measured` OBOK, nie samą wartością `{0,0}` (ktora tez
 * moglaby byc prawdziwym wynikiem pomiaru).
 */
export interface ProseBlockPatternDraft {
  kind: 'proseBlock';
  label: string;
  offsetDxPt: number;
  offsetDyPt: number;
  measured: boolean;
  maxLengthChars: number;
  searchRadiusPt: number;
  /**
   * [ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze] Patrz komentarz przy
   * `chainFromPrevious` w `schema.ts` — `false` (domyslnie) liczy offset
   * wzgledem stalego punktu (koniec siatki/pochodnych/atakow/umiejetnosci),
   * `true` wzgledem konca POPRZEDNIEJ notatki na liscie `notesPatterns`
   * (stabilne, gdy pola notatek ukladaja sie jedno pod drugim ze zmienna
   * dlugoscia miedzy nimi, np. rozne dlugosci biografii u roznych postaci).
   */
  chainFromPrevious: boolean;
  /** [ZGŁOSZENIE na zywo, "zaznaczam tylko te dwa, a do nich wpisywane sa wszystkie informacje z tych akapitow"] Patrz komentarz przy `stopAtSameFontRole` w `schema.ts` — zbieranie zatrzymuje sie na kolejnym naglowku TEGO SAMEGO stylu co klikniety przyklad, zamiast zawsze na `accent`. */
  stopAtSameFontRole: boolean;
  /** [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, "Twoi przyjaciele" w osobnej kolumnie] Patrz komentarz przy `anchorGridOnly` w `schema.ts` — offset liczony wylacznie wzgledem konca siatki-kotwicy, bez atakow/umiejetnosci. */
  anchorGridOnly: boolean;
}

export type PatternDraft = LabelledPairsPatternDraft | SectionListPatternDraft | FontRoleCandidatePatternDraft | ProseBlockPatternDraft;

export interface PatternEntryDraft {
  id: string;
  pattern: PatternDraft;
}

export interface AttachRuleDraft {
  pattern: string;
  strategy: 'nearestBelow' | 'nearestAbove' | 'nearest';
  maxDistancePt: number;
  preferEarlierSiblingMaxDeltaYPt?: number;
}

export interface ProfileDraft {
  schemaVersion: 2;
  id: string;
  gameLine: string;
  language: string;
  title: string;
  publication: string;
  author?: string;
  license?: string;
  provides: string[];
  fingerprintMinScore: number;
  pageRanges: [number, number][];
  patterns: PatternEntryDraft[];
  anchor: string;
  attach: AttachRuleDraft[];
  nameConfidenceThreshold: number;
  namePlaceholder: string;
  skillsPattern: string;
  /** [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] Id wzorca `fontRoleCandidate` wskazanego jako zawod/typ ("kapitan jachtu"), ODDZIELNY od `anchor`'s parujacej sie nazwy. Pusty string = nie wskazano (wsteczna zgodnosc). */
  typeLabelPattern: string;
  /** [KROK-34 Z2] Id-ki wzorcow `proseBlock` — patrz `entityAssembly.notesPatterns` w `schema.ts`. Kolejnosc = kolejnosc blokow w finalnej notatce. */
  notesPatterns: string[];
  /**
   * [ZGŁOSZENIE po kroku 30, "Wrak" — obrazy pod pelnym spadem z tekstem na
   * wierzchu na kazdej stronie] Wlasne, typowane pole (NIE przez extraJson),
   * bo wymaganie surowego trybu JSON dla pojedynczego checkboxa okazalo sie
   * zla UX — patrz `images.treatFullBleedAsContent` w `schema.ts` (`@bindery/core`).
   */
  treatFullBleedAsContent: boolean;
  /**
   * [na zyczenie uzytkownika, EKSPERYMENTALNE, po naprawie "Wrak"] Patrz
   * `images.autoCropUniformMargins` w `schema.ts`. Bez znaczenia, gdy
   * `treatFullBleedAsContent` jest wylaczone.
   */
  autoCropUniformMargins: boolean;
  /**
   * [na zyczenie uzytkownika, po naprawie przyciecia "Wrak"] Patrz
   * `images.brightenAutoCroppedImages` w `schema.ts`. Bez znaczenia, gdy
   * `autoCropUniformMargins` jest wylaczone.
   */
  brightenAutoCroppedImages: boolean;
  /**
   * [KROK-42 Z1] Patrz `images.removeTokenBackgroundDefault` w `schema.ts` —
   * wylacznie wartosc startowa przelacznika w panelu przygotowania tokenu.
   */
  removeTokenBackgroundDefault: boolean;
  /**
   * [Z5, ucieczka do surowego JSON] Pola spoza formularza (Z2-Z4) — dowolne
   * dodatkowe JSON, scalane WPROST do wyniku `draftToProfileInput` bez
   * interpretacji (np. `fingerprint.keywords`, `pages.excludeZones`, `images`).
   * `undefined`, dopóki uzytkownik nie skorzysta z trybu surowego JSON.
   */
  extraJson?: Record<string, unknown>;
}

/**
 * [KROK-34 Z2, zmierzony na zywo blad] Ten licznik jest MODULOWY (przetrwa
 * caly czas zycia karty przegladarki), ale wczytanie ISTNIEJACEGO profilu
 * (`profileToDraft`) zachowuje ORYGINALNE id-ki z pliku ("draft-1".."draft-6")
 * WPROST jako klucze — NIGDY nie woła `nextDraftId()` — wiec ten licznik
 * zostaje na `0` nawet po wczytaniu profilu z szescioma wzorcami. Pierwsze
 * `createPatternDraft()` wywolane PO wczytaniu takiego profilu (np. "+ Dodaj
 * blok notatki" w zakladce Notatki — jedyne miejsce, ktore woła ja
 * WIELOKROTNIE na TYM SAMYM, JUZ zaludnionym szkicu) generuje wiec
 * "draft-1" — id JUZ zajete przez wczytany wzorzec! Dwa wpisy `draft.patterns`
 * z tym samym `id` psuje kazde `.find(e => e.id === id)` w calym pliku
 * (zawsze trafia w PIERWSZY, starszy wpis) — zmierzone wprost: nowy blok
 * notatki znikal calkowicie, bo `#buildNotesTabContent` znajdowal zamiast
 * niego oryginalna siatke cech i pomijal go (`kind !== 'proseBlock'`).
 * Naprawa: `existingIds` (aktualne `draft.patterns` w momencie wywolania)
 * pomijane przy szukaniu kolejnej wolnej liczby — gwarantowanie unikalne id
 * niezaleznie od tego, ile razy i w jakiej kolejnosci profil byl
 * wczytywany/edytowany w tej samej karcie.
 */
let draftIdCounter = 0;
function nextDraftId(existingIds: ReadonlySet<string>): string {
  let id: string;
  do {
    draftIdCounter += 1;
    id = `draft-${draftIdCounter}`;
  } while (existingIds.has(id));
  return id;
}

export function createEmptyProfileDraft(): ProfileDraft {
  return {
    schemaVersion: 2,
    id: '',
    gameLine: '',
    language: '',
    title: '',
    publication: '',
    provides: ['actors'],
    fingerprintMinScore: 0.5,
    pageRanges: [[1, -1]],
    patterns: [],
    anchor: '',
    attach: [],
    nameConfidenceThreshold: 0.7,
    namePlaceholder: 'NPC #{ordinal} (str. {page})',
    skillsPattern: '',
    typeLabelPattern: '',
    notesPatterns: [],
    treatFullBleedAsContent: false,
    autoCropUniformMargins: false,
    brightenAutoCroppedImages: false,
    removeTokenBackgroundDefault: false,
  };
}

function labelsRecordToDraft(labels: Record<string, string>): LabelEntryDraft[] {
  return Object.entries(labels).map(([label, canonicalKey]) => ({ label, canonicalKey }));
}

function labelsDraftToRecord(labels: readonly LabelEntryDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of labels) {
    if (entry.label.trim().length === 0) continue;
    out[entry.label] = entry.canonicalKey;
  }
  return out;
}

/** [Z1] Konwertuje JUŻ zwalidowany `ProfileV2` (z `@bindery/core`) na szkic do edycji — wywołujące (`ProfileStudio.ts`) przekazuje strukturalnie zgodny obiekt, ten plik nie importuje typu wprost (patrz nagłówek). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function profileToDraft(profile: any): ProfileDraft {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patterns: PatternEntryDraft[] = Object.entries(profile.patterns ?? {}).map(([id, p]: [string, any]) => {
    if (p.kind === 'labelledPairs') {
      const draft: LabelledPairsPatternDraft = {
        kind: 'labelledPairs',
        labels: labelsRecordToDraft(p.labels ?? {}),
        valuePattern: p.valuePattern ?? '',
        minPairs: p.minPairs ?? 1,
        maxPairs: p.maxPairs,
        onRepeatedLabel: p.terminate?.onRepeatedLabel ?? false,
        maxGapPt: p.terminate?.maxGapPt,
        allowTrailingWords: p.allowTrailingWords ?? false,
        unit: p.unit,
        trailingWordsStopBefore: p.trailingWordsStopBefore,
      };
      return { id, pattern: draft };
    }
    if (p.kind === 'sectionList') {
      const draft: SectionListPatternDraft = {
        kind: 'sectionList',
        sectionHeader: p.sectionHeader ?? '',
        itemPattern: p.itemPattern ?? '',
        rejoinHyphenated: p.rejoinHyphenated ?? false,
        skipAfterHeader: p.skipAfterHeader,
        terminateSectionBefore: p.terminateSectionBefore,
        rangedKeywords: p.rangedKeywords ?? [],
      };
      return { id, pattern: draft };
    }
    if (p.kind === 'proseBlock') {
      const draft: ProseBlockPatternDraft = {
        kind: 'proseBlock',
        label: p.label ?? '',
        offsetDxPt: p.offset?.dxPt ?? 0,
        offsetDyPt: p.offset?.dyPt ?? 0,
        // Wczytany z pliku profil ma juz "prawdziwy" pomiar (ktokolwiek go
        // zapisal) -- odroznienie "jeszcze nie kliknieto" dotyczy WYLACZNIE
        // nowo utworzonych w tej sesji wzorcow (`createPatternDraft`).
        measured: true,
        maxLengthChars: p.maxLengthChars ?? 2000,
        searchRadiusPt: p.searchRadiusPt ?? 60,
        chainFromPrevious: p.chainFromPrevious ?? false,
        stopAtSameFontRole: p.stopAtSameFontRole ?? false,
        anchorGridOnly: p.anchorGridOnly ?? false,
      };
      return { id, pattern: draft };
    }
    const draft: FontRoleCandidatePatternDraft = {
      kind: 'fontRoleCandidate',
      excludeRoles: p.excludeRoles ?? ['body'],
      maxLength: p.maxLength ?? 60,
      excludeRepeatedAcrossPages: p.excludeRepeatedAcrossPages ?? true,
      excludeHyphenContinuations: p.excludeHyphenContinuations ?? true,
      requireFontKeys: p.requireFontKeys ?? [],
    };
    return { id, pattern: draft };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attach: AttachRuleDraft[] = (profile.entityAssembly?.attach ?? []).map((r: any) => ({
    pattern: r.pattern,
    strategy: r.strategy,
    maxDistancePt: r.maxDistancePt,
    preferEarlierSiblingMaxDeltaYPt: r.preferEarlierSibling?.maxDeltaYPt,
  }));

  // Pola nieobjete formularzem (Z2-Z4) -- zachowane WPROST w extraJson, zeby
  // "Edytuj wczytany profil" nigdy nie gubilo tresci milczaco (A3-podobna zasada).
  const { schemaVersion, id, gameLine, language, title, publication, author, license, provides, fingerprint, pages, patterns: _p, entityAssembly, images, ...restTop } = profile;
  void schemaVersion;
  void _p;
  const extraJson: Record<string, unknown> = { ...restTop };
  const {
    treatFullBleedAsContent: treatFullBleedAsContentRaw,
    autoCropUniformMargins: autoCropUniformMarginsRaw,
    brightenAutoCroppedImages: brightenAutoCroppedImagesRaw,
    removeTokenBackgroundDefault: removeTokenBackgroundDefaultRaw,
    ...restImages
  } = images ?? {};
  if (Object.keys(restImages).length > 0) extraJson['images'] = restImages;
  const { minScore: _minScore, ...restFingerprint } = fingerprint ?? {};
  void _minScore;
  if (Object.keys(restFingerprint).length > 0) extraJson['fingerprintExtra'] = restFingerprint;
  if (pages?.excludeZones && pages.excludeZones.length > 0) extraJson['pagesExcludeZones'] = pages.excludeZones;
  const { allowCrossPage } = entityAssembly ?? {};
  if (allowCrossPage) extraJson['allowCrossPage'] = allowCrossPage;

  return {
    schemaVersion: 2,
    id: id ?? '',
    gameLine: gameLine ?? '',
    language: language ?? '',
    title: title ?? '',
    publication: publication ?? '',
    author,
    license,
    provides: provides ?? ['actors'],
    fingerprintMinScore: fingerprint?.minScore ?? 0.5,
    pageRanges: pages?.include ?? [[1, -1]],
    patterns,
    anchor: entityAssembly?.anchor ?? '',
    attach,
    nameConfidenceThreshold: entityAssembly?.nameConfidenceThreshold ?? 0.7,
    namePlaceholder: entityAssembly?.namePlaceholder ?? 'NPC #{ordinal} (str. {page})',
    skillsPattern: entityAssembly?.skillsPattern ?? '',
    typeLabelPattern: entityAssembly?.typeLabelPattern ?? '',
    notesPatterns: entityAssembly?.notesPatterns ?? [],
    treatFullBleedAsContent: treatFullBleedAsContentRaw ?? false,
    autoCropUniformMargins: autoCropUniformMarginsRaw ?? false,
    brightenAutoCroppedImages: brightenAutoCroppedImagesRaw ?? false,
    removeTokenBackgroundDefault: removeTokenBackgroundDefaultRaw ?? false,
    extraJson: Object.keys(extraJson).length > 0 ? extraJson : undefined,
  };
}

/** [Z5] Szkic -> surowy JSON gotowy do `validateProfile`. Nie waliduje niczego samo — pusty string zostaje pustym stringiem, Zod go odrzuci z czytelnym błędem. */
export function draftToProfileInput(draft: ProfileDraft): unknown {
  const patterns: Record<string, unknown> = {};
  for (const entry of draft.patterns) {
    if (entry.pattern.kind === 'labelledPairs') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'labelledPairs',
        labels: labelsDraftToRecord(p.labels),
        valuePattern: p.valuePattern,
        minPairs: p.minPairs,
        ...(p.maxPairs !== undefined ? { maxPairs: p.maxPairs } : {}),
        terminate: { onRepeatedLabel: p.onRepeatedLabel, ...(p.maxGapPt !== undefined ? { maxGapPt: p.maxGapPt } : {}) },
        allowTrailingWords: p.allowTrailingWords,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.trailingWordsStopBefore ? { trailingWordsStopBefore: p.trailingWordsStopBefore } : {}),
      };
    } else if (entry.pattern.kind === 'sectionList') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'sectionList',
        sectionHeader: p.sectionHeader,
        itemPattern: p.itemPattern,
        rejoinHyphenated: p.rejoinHyphenated,
        ...(p.skipAfterHeader ? { skipAfterHeader: p.skipAfterHeader } : {}),
        ...(p.terminateSectionBefore ? { terminateSectionBefore: p.terminateSectionBefore } : {}),
        rangedKeywords: p.rangedKeywords,
      };
    } else if (entry.pattern.kind === 'proseBlock') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'proseBlock',
        label: p.label,
        offset: { dxPt: p.offsetDxPt, dyPt: p.offsetDyPt },
        maxLengthChars: p.maxLengthChars,
        searchRadiusPt: p.searchRadiusPt,
        chainFromPrevious: p.chainFromPrevious,
        stopAtSameFontRole: p.stopAtSameFontRole,
        anchorGridOnly: p.anchorGridOnly,
      };
    } else {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'fontRoleCandidate',
        excludeRoles: p.excludeRoles,
        maxLength: p.maxLength,
        excludeRepeatedAcrossPages: p.excludeRepeatedAcrossPages,
        excludeHyphenContinuations: p.excludeHyphenContinuations,
        ...(p.requireFontKeys.length > 0 ? { requireFontKeys: p.requireFontKeys } : {}),
      };
    }
  }

  const attach = draft.attach.map((r) => ({
    pattern: r.pattern,
    strategy: r.strategy,
    maxDistancePt: r.maxDistancePt,
    ...(r.preferEarlierSiblingMaxDeltaYPt !== undefined ? { preferEarlierSibling: { maxDeltaYPt: r.preferEarlierSiblingMaxDeltaYPt } } : {}),
  }));

  const extra = draft.extraJson ?? {};
  const { fingerprintExtra, pagesExcludeZones, allowCrossPage, images: extraImages, ...restExtra } = extra as Record<string, unknown>;
  const images: Record<string, unknown> = {
    ...(typeof extraImages === 'object' && extraImages ? (extraImages as Record<string, unknown>) : {}),
    ...(draft.treatFullBleedAsContent ? { treatFullBleedAsContent: true } : {}),
    ...(draft.autoCropUniformMargins ? { autoCropUniformMargins: true } : {}),
    ...(draft.brightenAutoCroppedImages ? { brightenAutoCroppedImages: true } : {}),
    ...(draft.removeTokenBackgroundDefault ? { removeTokenBackgroundDefault: true } : {}),
  };

  return {
    schemaVersion: 2,
    id: draft.id,
    gameLine: draft.gameLine,
    language: draft.language,
    title: draft.title,
    publication: draft.publication,
    ...(draft.author ? { author: draft.author } : {}),
    ...(draft.license ? { license: draft.license } : {}),
    provides: draft.provides,
    fingerprint: { minScore: draft.fingerprintMinScore, ...(typeof fingerprintExtra === 'object' && fingerprintExtra ? fingerprintExtra : {}) },
    pages: { include: draft.pageRanges, ...(Array.isArray(pagesExcludeZones) ? { excludeZones: pagesExcludeZones } : {}) },
    patterns,
    entityAssembly: {
      anchor: draft.anchor,
      attach,
      nameConfidenceThreshold: draft.nameConfidenceThreshold,
      namePlaceholder: draft.namePlaceholder,
      ...(draft.skillsPattern ? { skillsPattern: draft.skillsPattern } : {}),
      ...(draft.typeLabelPattern ? { typeLabelPattern: draft.typeLabelPattern } : {}),
      ...(draft.notesPatterns.length > 0 ? { notesPatterns: draft.notesPatterns } : {}),
      ...(allowCrossPage ? { allowCrossPage } : {}),
    },
    ...(Object.keys(images).length > 0 ? { images } : {}),
    ...restExtra,
  };
}

/** [Z6] Nowy pusty wpis wzorca danego rodzaju, z rozsądnymi domyślnymi wartościami — do przycisku "Dodaj wzorzec". */
/** [KROK-34 Z2] `existingIds` — zwykle `draft.patterns.map(e => e.id)` wolajacego — patrz komentarz przy `nextDraftId`, dlaczego jest to konieczne dla poprawnosci, nie tylko kosmetyczne. */
export function createPatternDraft(kind: PatternDraft['kind'], existingIds: readonly string[] = []): PatternEntryDraft {
  const id = nextDraftId(new Set(existingIds));
  if (kind === 'labelledPairs') {
    return { id, pattern: { kind, labels: [], valuePattern: '^.+$', minPairs: 1, onRepeatedLabel: true, allowTrailingWords: false } };
  }
  if (kind === 'sectionList') {
    return { id, pattern: { kind, sectionHeader: '', itemPattern: '', rejoinHyphenated: false, rangedKeywords: [] } };
  }
  if (kind === 'proseBlock') {
    return {
      id,
      pattern: { kind, label: '', offsetDxPt: 0, offsetDyPt: 0, measured: false, maxLengthChars: 2000, searchRadiusPt: 60, chainFromPrevious: false, stopAtSameFontRole: false, anchorGridOnly: false },
    };
  }
  return { id, pattern: { kind, excludeRoles: ['body'], maxLength: 60, excludeRepeatedAcrossPages: true, excludeHyphenContinuations: true, requireFontKeys: [] } };
}

/** [Z3] Czy usuniecie wzorca `patternId` zerwie odwolanie z `anchor`/`attach`/`skillsPattern` — do ostrzezenia przed skasowaniem. */
export function findPatternReferences(draft: ProfileDraft, patternId: string): string[] {
  const refs: string[] = [];
  if (draft.anchor === patternId) refs.push('entityAssembly.anchor');
  if (draft.skillsPattern === patternId) refs.push('entityAssembly.skillsPattern');
  if (draft.typeLabelPattern === patternId) refs.push('entityAssembly.typeLabelPattern');
  if (draft.notesPatterns.includes(patternId)) refs.push('entityAssembly.notesPatterns');
  draft.attach.forEach((rule, i) => {
    if (rule.pattern === patternId) refs.push(`entityAssembly.attach[${i}]`);
  });
  return refs;
}

/**
 * [Z6, KROK-29 przemianowane i naprawione] Regex-escapuje literalny tekst
 * tokenu klikniętego na stronie, do wklejenia w pole `sectionHeader`/
 * `terminateSectionBefore` — jedyne dwa pola w tym pliku, ktore kiedykolwiek
 * uzywaly regex-escapowania klikniecia (etykiety `labelledPairs` dopasowuja
 * sie po DOKLADNEJ rownosci stringow, nie regexie; `valuePattern` jest
 * wpisywany recznie) — nazwa `escapeRegexLiteral` byla wiec myląco ogolna.
 *
 * [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] Naglowek
 * sekcji/granica z KLIKNIECIA na JEDNYM wystapieniu ("Umiejętności", bez
 * dwukropka u Calhouna) nie pasowal do TEGO SAMEGO naglowka na DRUGIM
 * wystapieniu tej samej ksiazki ("Umiejętności:", dwukropek doklejony przez
 * pdf.js u Hansena) — poprzednia wersja wymagala DOKLADNIE tekstu spod
 * klikniecia, wiec regex z pierwszego wystapienia nigdy nie zamykal sekcji
 * drugiego. Skutek zmierzony wprost: sekcja "Walka" Hansena (bez wlasnej
 * dzialajacej granicy i bez trzeciej encji na stronie, ktora dalaby hardStop)
 * czytala AZ DO KONCA STRUMIENIA TEJ STRONY, wliczajac cala prawa kolumne —
 * ktorej tokeny, w kolejnosci strumienia kolumnowej, MAJA Y RESETUJACE SIE DO
 * GORY STRONY, wiec wynikowy (nadmiernie szeroki) bbox sekcji rozciagal sie
 * przez PRAWIE CALA WYSOKOSC strony i geometrycznie zachodzil na regiony
 * Calhouna (zgloszenie #2). Ten sam efekt uboczny falszywie "kradl" (globalne
 * najblizsze dopasowanie, `entityAssembly.ts`) prawidlowy kandydat
 * Umiejetnosci Calhouna, dajac mylacy komunikat "87pt > 400pt" (zgloszenie
 * #1) mimo ze 87 < 400 — bo ten kandydat wcale nie byl "poza zasiegiem",
 * zostal PRZEJETY przez inna kotwice (patrz `AttachDiagnosticResult`, `entityAssembly.ts`).
 *
 * Naprawa: dwukropek na koncu klikniętego tekstu staje sie OPCJONALNY w
 * wygenerowanym regexie (`:?` zamiast wymagac dokladnie tego, co bylo pod
 * tokenem) — dziala niezaleznie od tego, KTORE wystapienie autor kliknal.
 */
export function escapeSectionBoundaryLiteral(text: string): string {
  const withoutTrailingColon = text.replace(/:+$/, '');
  const escaped = withoutTrailingColon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}:?$`;
}
