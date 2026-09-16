import type { Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { PatternSet, ProfileV2 } from './schema.js';
import type { PageRoute } from './pageRoute.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { findAttackDescriptionClaimedRanges, findAttackDescriptionsBelow } from './attackDescriptionCrossReference.js';
import { matchFontRoleCandidate } from './entityName.js';
import { lastClaimedTokenIndex, matchProseBlock, type ProseBlockMatch } from './proseBlock.js';
import { attachAndMergeLabelledPairs, attachNearest, resolveEntityNames, type AttachCandidate, type GeometricAnchor, type NameCandidate, type NameResolution } from './entityAssembly.js';

/**
 * [KROK-39 Z1] Wybiera zestaw wzorcow odpowiadajacy trasie strony. `'npc'`
 * to pola root profilu (`patterns`/`entityAssembly`, bez zmian od kroku 18 —
 * KAZDY istniejacy profil ma je zawsze). `'playerCharacter'` to opcjonalna
 * druga sekcja (`profile.playerCharacter`, `schema.ts`) — `null`, gdy profil
 * jej nie ma (autor nie skonfigurowal jeszcze wzorcow dla postaci graczy).
 * Wolajacy (`assembleStatblocksOnPage` nizej, `studioAnalysis.ts`) traktuje
 * `null` jako "trasa nieobslugiwana" — strona pomijana, NIGDY nie miesza
 * wzorcow miedzy trasami.
 */
export function resolvePatternSetForRoute(profile: ProfileV2, route: PageRoute): PatternSet | null {
  if (route === 'npc') return { patterns: profile.patterns, entityAssembly: profile.entityAssembly };
  return profile.playerCharacter ?? null;
}

/**
 * [KROK-18 Z4] Spina Z2 (silnik wzorcow) i Z3 (skladanie geometryczne) w
 * JEDNA funkcje sterowana wprost skonfigurowanym profilem (`entityAssembly`
 * z §5.5) — jedna encja (NPC/potwor LUB, od kroku 39, gotowy Badacz) na
 * strone, gotowa do zasilenia CIFActor (Z6). Anchor to zawsze wzorzec
 * `labelledPairs` (siatka cech) wskazany przez `entityAssembly.anchor`
 * WYBRANEGO zestawu wzorcow (`resolvePatternSetForRoute` powyzej) — inny typ
 * wzorca jako kotwica nie jest obslugiwany w tym zakresie (siatka cech ZAWSZE
 * istnieje dla obu kategorii, patrz Z0 i krok 38).
 */

export interface AssembledStatblock {
  /** Ktora siatka na stronie (0-indeksowana, kolejnosc w strumieniu) — do `namePlaceholder`'s `{ordinal}` i identyfikacji. */
  ordinal: number;
  /**
   * [KROK-39 Z1] Trasa, ktorej zestawem wzorcow ta encja zostala zbudowana —
   * adapter (`coc7.ts`) uzywa jej, zeby zdecydowac, jaki typ aktora tworzyc
   * (`npc` vs `character`). Opcjonalne — pole addytywne jak `skills`/
   * `attackBelowTexts`/`notes` powyzej (kod konstruujacy `AssembledStatblock`
   * bezposrednio, np. fixtury testowe sprzed tego pola, nie musi sie
   * zmieniac); ZAWSZE wypelnione przez `assembleStatblocksOnPage`.
   */
  route?: PageRoute;
  grid: LabelledPairsMatch;
  derived: LabelledPairsMatch | null;
  attacks: SectionListMatch | null;
  /**
   * [KROK-33 Z4] Rownolegle do `attacks.items` (ten sam indeks) — opis
   * znaleziony w prozie PONIZEJ listy atakow, wprowadzony WLASNYM
   * podnaglowkiem zaczynajacym sie od pelnej nazwy tego ataku, patrz
   * `attackDescriptionCrossReference.ts`. `[]`, gdy `attacks` jest `null`;
   * `null` na pozycji, dla ktorej nic nie znaleziono (A7 — brak trafienia to
   * poprawny wynik, nie blad). Opcjonalne — pole addytywne (jak `skills`
   * powyzej), zeby kod konstruujacy `AssembledStatblock` bezposrednio (np.
   * fixtury testowe sprzed tego pola) nie musial sie zmieniac.
   */
  attackBelowTexts?: (string | null)[];
  /** [KROK-20 Z2b] Lista umiejetnosci ogolnych ("Umiejętności: Historia 75%, ..."), patrz `entityAssembly.skillsPattern`. `null`, gdy profil nie wskazal `skillsPattern` LUB gdy strona jej nie ma. */
  skills: SectionListMatch | null;
  name: NameResolution;
  /** [ZGŁOSZENIE po kroku 30] Swobodna etykieta zawodu/typu ("kapitan jachtu"), patrz `entityAssembly.typeLabelPattern`. `null`, gdy profil nie wskazal tego wzorca LUB gdy nic nie dopasowano w zasiegu. */
  typeLabel: string | null;
  /**
   * [KROK-34 Z2] Bloki prozy dolaczone geometrycznie (`entityAssembly.notesPatterns`,
   * `proseBlock.ts`) — jeden wpis na wzorzec, ktory znalazl COKOLWIEK dla tej
   * encji (bez wpisu, nie `null`, gdy nic nie znaleziono — A10). `[]`, gdy
   * profil nie ma zadnego `notesPatterns` LUB zaden nie trafil. Opcjonalne —
   * pole addytywne jak `attackBelowTexts`/`skills` powyzej.
   */
  notes?: { label: string; text: string }[];
  bbox: Rect;
}

function toGeometricAnchors(matches: readonly LabelledPairsMatch[]): GeometricAnchor[] {
  return matches.map((m) => ({ bbox: m.bbox, anchorTokenIndex: m.startIndex }));
}

/** [KROK-22] Eksportowane do ponownego uzycia w Profile Studio (`studioAnalysis.ts`) — TA SAMA konwersja co uzywana tutaj, zeby diagnostyka widziala dokladnie te same kandydaty co prawdziwy potok. */
export function toAttachCandidates(matches: readonly LabelledPairsMatch[]): AttachCandidate[] {
  return matches.map((m) => ({ bbox: m.bbox, tokenIndex: m.startIndex }));
}

/** [KROK-22] Jak wyzej — eksportowane dla Profile Studio. */
export function sectionListToAttachCandidates(matches: readonly SectionListMatch[], tokens: readonly ProfileToken[]): AttachCandidate[] {
  return matches.map((m) => ({ bbox: tokens[m.headerTokenIndex]!.bbox, tokenIndex: m.headerTokenIndex }));
}

/**
 * Buduje statbloki dla JEDNEJ strony. Wywolujacy dostarcza tokeny TEJ strony
 * (patrz `ProfileToken` — token.page opcjonalny, ale wymagany jesli profil
 * ustawia `excludeRepeatedAcrossPages`, co oznacza przekazanie tokenow z
 * calego dokumentu do samego `matchFontRoleCandidate`, patrz `entityName.ts`).
 * Klasyfikacja trasy (`classifyPageRoute`, `pageRoute.ts`) to osobny,
 * WCZESNIEJSZY krok — wywolujacy (`buildActorsForDocument.ts`) juz zdecydowal
 * `route`; ta funkcja WYLACZNIE wybiera odpowiadajacy jej zestaw wzorcow
 * (`resolvePatternSetForRoute` powyzej) i nigdy nie miesza wzorcow miedzy
 * trasami [KROK-39 Z1]. `null` (brak sekcji `playerCharacter` w profilu) =
 * trasa nieobslugiwana = `[]`, BEZ rzucania — wolajacy odpowiada za
 * `Diagnostic` wyjasniajacy pominiecie strony (A10).
 */
export function assembleStatblocksOnPage(tokens: readonly ProfileToken[], profile: ProfileV2, page: number, route: PageRoute): AssembledStatblock[] {
  const patternSet = resolvePatternSetForRoute(profile, route);
  if (!patternSet) return [];

  const anchorPatternId = patternSet.entityAssembly.anchor;
  const anchorPattern = patternSet.patterns[anchorPatternId];
  if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
    throw new Error(`assembleStatblocksOnPage: kotwica "${anchorPatternId}" musi byc wzorcem labelledPairs (siatka cech), a jest "${anchorPattern?.kind ?? 'brak'}"`);
  }
  const grids = matchLabelledPairs(tokens, anchorPattern);
  const anchors = toGeometricAnchors(grids);

  const derivedRule = patternSet.entityAssembly.attach.find((r) => {
    const p = patternSet.patterns[r.pattern];
    return p?.kind === 'labelledPairs' && r.pattern !== anchorPatternId;
  });
  // [KROK-20 Z2b] `skillsPattern` wylaczony z kandydatow na "ten sectionList to
  // ataki" PONIZEJ — bez tego, gdy profil ma DWA wzorce sectionList (ATAKI +
  // Umiejetnosci), `.find()` po samym `kind` moglby trafic na Umiejetnosci
  // zamiast ATAKI, zaleznie od kolejnosci w `attach`.
  const skillsPatternId = patternSet.entityAssembly.skillsPattern;
  const attackRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'sectionList' && r.pattern !== skillsPatternId);
  const skillsRule = skillsPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === skillsPatternId) : undefined;
  // [ZGŁOSZENIE po kroku 30] `typeLabelPattern` wylaczony z kandydatow na "ten
  // fontRoleCandidate to nazwa" PONIZEJ — ten sam powod co `skillsPattern`
  // wyzej: profil moze miec DWA wzorce `fontRoleCandidate` (nazwa + zawod/typ).
  const typeLabelPatternId = patternSet.entityAssembly.typeLabelPattern;
  const nameRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'fontRoleCandidate' && r.pattern !== typeLabelPatternId);
  const typeLabelRule = typeLabelPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === typeLabelPatternId) : undefined;

  // [KROK-34 Z1] `attachAndMergeLabelledPairs`, nie `attachNearest` — patrz
  // komentarz przy jej definicji (`entityAssembly.ts`): pozwala WIECEJ NIZ
  // jednemu rozlacznemu dopasowaniu tego samego wzorca dolaczyc sie do JEDNEJ
  // kotwicy (np. "Pancerz" we WLASNYM akapicie, osobno od reszty pochodnych).
  let derivedAttached: (LabelledPairsMatch | null)[] = anchors.map(() => null);
  let derivedSubMatches: LabelledPairsMatch[][] = anchors.map(() => []);
  if (derivedRule) {
    const pattern = patternSet.patterns[derivedRule.pattern];
    if (pattern?.kind === 'labelledPairs') {
      const derivedMatches = matchLabelledPairs(tokens, pattern);
      const merged = attachAndMergeLabelledPairs(anchors, derivedMatches, derivedRule.strategy, derivedRule.maxDistancePt);
      derivedAttached = merged.attached;
      derivedSubMatches = merged.subMatches;
    }
  }

  // [ZGŁOSZENIE po kroku 30, "Dlaczego muszę wskazywać ręcznie, skoro profil
  // już to zawiera"] Surowe dopasowania wzorca zawodu/typu liczone TERAZ, PRZED
  // rozwiazaniem nazwy, wylacznie po to, zeby ich `tokenIndex` mogly wejsc do
  // `resolveEntityNames` jako `knownSiblingTokenIndices` — sam fakt, ze autor
  // wskazal OSOBNY wzorzec zawodu/typu, jest juz wystarczajaca informacja, zeby
  // silnik NIE pytal czlowieka ponownie o rozstrzygniecie miedzy tymi dwoma
  // polami (patrz komentarz przy `knownSiblingTokenIndices`, `entityAssembly.ts`).
  let typeLabelPattern = typeLabelRule ? patternSet.patterns[typeLabelRule.pattern] : undefined;
  if (typeLabelPattern?.kind !== 'fontRoleCandidate') typeLabelPattern = undefined;
  const typeLabelMatches = typeLabelPattern ? matchFontRoleCandidate(tokens, typeLabelPattern) : [];
  const typeLabelMatchTokenIndices = new Set(typeLabelMatches.map((m) => m.tokenIndex));

  // [KROK-24 Z4b, zmierzony na zywo blad] Nazwa rozwiazywana PRZED sekcjami
  // ATAKI/Umiejetnosci (nie po nich, jak wczesniej) — potrzebna do granic
  // ponizej. `resolveEntityNames` juz i tak filtruje surowych kandydatow
  // fontRoleCandidate geometrycznie (S4), wiec ten sam wynik ktory i tak
  // trafia do `AssembledStatblock.name` teraz SLUZY DODATKOWO jako granica.
  let names: NameResolution[] = anchors.map((_, i) => ({
    kind: 'placeholder',
    placeholder: patternSet.entityAssembly.namePlaceholder.replace('{page}', String(page)).replace('{ordinal}', String(i + 1)),
    candidates: [],
  }));
  // [ZGŁOSZENIE po kroku 30, zmierzony na zywo blad] Token(y), ktore
  // dopasowanie NAZWY uznaloby za "najblizszy kandydat" dla KTOREJKOLWIEK
  // kotwicy — liczone NIEZALEZNIE od progu pewnosci (`attachNearest`, nie
  // `resolveEntityNames`), bo placeholder z powodu niejednoznacznosci (S4)
  // NADAL "zajmuje" ten token w sensie geometrycznym, tylko nie wystarczajaco
  // pewnie, zeby go pokazac jako `name`. Patrz uzycie ponizej przy `typeLabel`.
  let nameClaimedTokenIndices = new Set<number>();
  let allNameCandidateTokenIndices: number[] = [];
  if (nameRule) {
    const pattern = patternSet.patterns[nameRule.pattern];
    if (pattern?.kind === 'fontRoleCandidate') {
      const nameMatches = matchFontRoleCandidate(tokens, pattern);
      // [KROK-34 Z2, zmierzony na zywo blad #2, "Wrak.pdf" str. 23, Hansen]
      // WSZYSCY surowi kandydaci (`nameMatches` bez filtra) to za szeroka siatka —
      // `fontRoleCandidate` z `excludeRoles: ['body']` przepuszcza KAZDY krotki
      // token stylu innego niz `body`, a rola `accent` bywa (rzadko, przez szum
      // klasyfikacji fontu po czestosci, patrz KROK-18 Z7) przypisana WEWNATRZ
      // zwyklej listy Umiejetnosci (zmierzone: "40%, Urok Osobisty 45%, Wiedza o
      // Naturze 35%," na str. 23 ma `accent` mimo ze to zwykla pozycja listy) —
      // taki token jako granica ODCINAL WLASNA, prawdziwa pozycje umiejetnosci tej
      // samej postaci (Wspinaczka), przez co notatka Z2 zaczynala sie od niej
      // zamiast zwracac `null`. `heading` to WEZSZA, bardziej wiarygodna rola —
      // przypisywana wg czestosci/rozmiaru NA POZIOMIE CALEGO DOKUMENTU (patrz
      // `fontRegistry.ts`) wylacznie prawdziwym tytulom sekcji/nazwom encji (np.
      // "SCIAPOD" jako zapowiedz na str. 23, TA SAMA rola co jego wlasciwy
      // naglowek na str. 24) — nigdy zwyklym pogrubieniom w tresci.
      const headingNameMatches = nameMatches.filter((m) => tokens[m.tokenIndex]?.fontRole === 'heading');
      allNameCandidateTokenIndices = headingNameMatches.map((m) => m.tokenIndex);
      const nameCandidates: NameCandidate[] = nameMatches.map((m) => ({ text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex }));
      names = resolveEntityNames(anchors, nameCandidates, {
        strategy: nameRule.strategy,
        maxDistancePt: nameRule.maxDistancePt,
        preferEarlierSibling: nameRule.preferEarlierSibling,
        nameConfidenceThreshold: patternSet.entityAssembly.nameConfidenceThreshold,
        page,
        namePlaceholder: patternSet.entityAssembly.namePlaceholder,
        knownSiblingTokenIndices: typeLabelMatchTokenIndices,
      });
      nameClaimedTokenIndices = new Set(
        attachNearest(anchors, nameCandidates, nameRule.strategy, nameRule.maxDistancePt)
          .filter((c): c is AttachCandidate => c !== null)
          .map((c) => c.tokenIndex),
      );
    }
  }

  // [ZGŁOSZENIE po kroku 30, zmierzony na zywo blad] `typeLabel` — WLASNY,
  // niezalezny wzorzec `fontRoleCandidate` (zwykle inny `requireFontKeys` niz
  // nazwa, np. kursywa zamiast pogrubienia), wiec BEZ progu pewnosci/kary
  // dwuznacznosci `resolveEntityNames` — to samo `attachNearest` co reszta
  // pol pochodnych. ALE: gdy autor NIE zdazyl jeszcze zawezic `requireFontKeys`
  // (albo klikniety token nie mial rozpoznanego `fontKey`), obie pule
  // kandydatow (nazwa/zawod) sa IDENTYCZNE — kazde z dwoch NIEZALEZNYCH
  // wywolan (kazde z WLASNYM, swiezym `used`) wybiera wtedy TEN SAM,
  // geometrycznie najblizszy token, wiec `typeLabel` wychodzi identyczny jak
  // `name` — zgloszone wprost: "w obu miejscach jest name, a nie name i
  // zawód". Naprawa: KAZDY token, ktory dopasowanie nazwy uznaloby za swojego
  // najlepszego kandydata dla KTOREJKOLWIEK kotwicy (`nameClaimedTokenIndices`
  // — NIE tylko `confident`, bo w pierwszej wersji tej naprawy placeholder z
  // powodu niejednoznacznosci omijal wykluczenie, przez co `typeLabel` nadal
  // trafial na literalnie ten sam token co "prawie-wybrana" nazwa), jest
  // wykluczony z puli kandydatow na zawod/typ.
  let typeLabelAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  if (typeLabelPattern) {
    const typeLabelCandidates: AttachCandidate[] = typeLabelMatches
      .filter((m) => !nameClaimedTokenIndices.has(m.tokenIndex))
      .map((m) => ({ bbox: m.bbox, tokenIndex: m.tokenIndex }));
    typeLabelAttached = attachNearest(anchors, typeLabelCandidates, typeLabelRule!.strategy, typeLabelRule!.maxDistancePt);
  }

  // [KROK-20 Z2, rozszerzone w KROK-24 Z4b] Granice INNYCH postaci na tej
  // stronie — patrz komentarz `hardStopTokenIndices` w `matchSectionList`
  // (patterns.ts). Siatka cech KAZDEJ postaci ograniczala to juz od kroku 20,
  // ale str. 56 "Głowa" pokazala zmierzony wprost przypadek, ktorego to NIE
  // lapalo: nazwa kolejnej postaci ("Nogi") czasem poprzedza jej wlasna siatke
  // WLASNYM opisem ("Prawa i lewa noga sa osobnymi istotami..."), wiec ta
  // proza lezala PRZED granica siatki i zostawala wchloniete jako "opis
  // obrazen" ostatniej pozycji ataku POPRZEDNIEJ postaci (zmierzone: atak
  // "Unik" Głowy dostawal w `damage` cale imie i opis Nog). Rozwiazana nazwa
  // (`names`, WYLACZNIE `confident` — placeholder nie ma wiarygodnego
  // `tokenIndex`) kolejnej postaci jest WCZESNIEJSZA granica niz jej siatka,
  // dokladnie tam, gdzie ta proza sie zaczyna.
  const anchorStartIndices = grids.map((g) => g.startIndex);
  const confidentNameTokenIndices = names.filter((n): n is Extract<NameResolution, { kind: 'confident' }> => n.kind === 'confident').map((n) => n.tokenIndex);
  // [KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 23, Hansen] SAME
  // `confident` nazwy nie wystarczaja: encja moze miec swoj WLASNY tytul/naglowek
  // na tej stronie bez pelnej siatki cech obok niego (np. zapowiedz/wstep
  // opisowy potwora na koncu strony, ktorego prawdziwy statblok jest DOPIERO na
  // NASTEPNEJ stronie — "SCIAPOD" jako naglowek wstepu na str. 23, siatka Sciapoda
  // dopiero na str. 24). Taki token NIGDY nie staje sie `confident` (brak kotwicy
  // NA TEJ stronie, do ktorej mogłby sie dolaczyc), wiec `confidentNameTokenIndices`
  // sam w sobie go pomijal — ATAKI/Umiejetnosci/Notatki OSTATNIEJ postaci na
  // stronie (Hansen, bez kolejnej kotwicy PO NIM na tej samej stronie) lecialy
  // bez ograniczenia az do konca strumienia, wchlaniajac ten wstep jako WLASNA
  // tresc (zmierzone: notatka Hansena dostawala caly wstepny opis Sciapoda).
  // Naprawa: DODATKOWO (nie ZAMIAST) kazdy surowy kandydat wzorca nazwy z rola
  // `heading` (`allNameCandidateTokenIndices`) jest tez granica. `heading`, nie
  // caly `nameMatches` bez filtra — patrz komentarz przy jej liczeniu wyzej:
  // `accent` bywa (rzadko, szum klasyfikacji fontu) przypisany WEWNATRZ zwyklej
  // listy Umiejetnosci, wiec uzycie go tutaj bez filtra ODCINALO WLASNA,
  // prawdziwa pozycje tej samej postaci (zmierzony na zywo DRUGI blad tego
  // samego dnia, ten sam plik/strona). `confidentNameTokenIndices` zostaje
  // OSOBNO (nie tylko `heading`) — to jest wsteczna zgodnosc z KROK-24 Z4b
  // ("Głowa"/"Nogi", synthetic fixture), gdzie `confident` nazwa NIE ma roli
  // `heading` i musi nadal dzialac jako granica.
  const hardStopTokenIndices = [...anchorStartIndices, ...confidentNameTokenIndices, ...allNameCandidateTokenIndices];

  let attackAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  let attackMatches: SectionListMatch[] = [];
  if (attackRule) {
    const pattern = patternSet.patterns[attackRule.pattern];
    if (pattern?.kind === 'sectionList') {
      attackMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      attackAttached = attachNearest(anchors, sectionListToAttachCandidates(attackMatches, tokens), attackRule.strategy, attackRule.maxDistancePt);
    }
  }

  let skillsAttached: (AttachCandidate | null)[] = anchors.map(() => null);
  let skillsMatches: SectionListMatch[] = [];
  if (skillsRule) {
    const pattern = patternSet.patterns[skillsRule.pattern];
    if (pattern?.kind === 'sectionList') {
      skillsMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      skillsAttached = attachNearest(anchors, sectionListToAttachCandidates(skillsMatches, tokens), skillsRule.strategy, skillsRule.maxDistancePt);
    }
  }

  // [KROK-34 Z2] Wszystko juz dopasowane przez INNE wzorce na tej stronie —
  // wykluczone z kandydatow na blok prozy, zeby notatka NIE dublowala tresci
  // juz pokazanej gdzie indziej na karcie (siatka/pochodne/ataki/umiejetnosci/
  // nazwa/typLabel PAGE-WIDE, nie tylko dla jednej encji — bezpieczniejsze niz
  // "tylko to, co faktycznie dolaczono", bo zapobiega rowniez zerwaniu
  // granicy miedzy sasiednimi encjami przez proza "przypadkiem" pasujaca
  // geometrycznie do niewlasciwej kotwicy) — PLUS zakresy juz skonsumowane
  // przez Krok-33 Z4 (`findAttackDescriptionClaimedRanges`), zeby dwa
  // niezalezne mechanizmy nigdy nie pokazaly TEJ SAMEJ tresci dwa razy (brief
  // kroku 34, "Relacja do Z4 z kroku 33").
  const claimedTokenIndices = new Set<number>();
  for (const g of grids) for (let t = g.startIndex; t < g.endIndex; t++) claimedTokenIndices.add(t);
  // [KROK-34 Z2, zmierzony na zywo blad] `derivedAttached[i]` moze byc
  // SCALENIEM rozlacznych dopasowan (Z1, `attachAndMergeLabelledPairs`) —
  // jego `startIndex..endIndex` to bounding UNIA, NIE ciagly zakres. Iterowac
  // trzeba po `derivedSubMatches` (KAZDY wpis WLASNY, naprawde ciagly zakres),
  // inaczej wykluczenie "polyka" TEZ niezaklaimowana proze miedzy scalonymi
  // fragmentami (zmierzone wprost: "Niewidzialność"..."Utrata Poczytalności"
  // miedzy glownym blokiem pochodnych a osierocionym "Pancerz" znikaly z puli
  // kandydatow na notatke, mimo ze nie byly CZESCIA zadnej pary).
  for (const subs of derivedSubMatches) for (const d of subs) for (let t = d.startIndex; t < d.endIndex; t++) claimedTokenIndices.add(t);
  // [KROK-34 Z2, zmierzony na zywo blad] `SectionListMatch.endIndex` to
  // GRANICA WYSZUKIWANIA (jak daleko bufor sekcji SZUKAL kolejnych pozycji,
  // patrz `matchSectionList`/`terminateSectionBefore`), NIE "to wszystko jest
  // juz pokazane jako atak" — na Sciapodzie (str. 24 "Wrak.pdf") rozciaga sie
  // AZ do konca strony (brak kolejnego naglowka/kotwicy PO nim), wiec
  // wykluczenie calego `[headerTokenIndex, endIndex)` polykaloby "Niewidzialność"
  // i cala reszte notatki jako "juz zaklaimowane", mimo ze naprawde wypisane
  // sa TYLKO pozycje w `items` (`startTokenIndex..endTokenIndex`, WLACZNIE).
  for (const a of attackMatches) {
    claimedTokenIndices.add(a.headerTokenIndex);
    for (const item of a.items) for (let t = item.startTokenIndex; t <= item.endTokenIndex; t++) claimedTokenIndices.add(t);
    for (const r of findAttackDescriptionClaimedRanges(tokens, a, hardStopTokenIndices)) for (let t = r.start; t < r.end; t++) claimedTokenIndices.add(t);
  }
  for (const s of skillsMatches) {
    claimedTokenIndices.add(s.headerTokenIndex);
    for (const item of s.items) for (let t = item.startTokenIndex; t <= item.endTokenIndex; t++) claimedTokenIndices.add(t);
  }
  for (const n of names) if (n.kind === 'confident') claimedTokenIndices.add(n.tokenIndex);
  // [KROK-34 Z2, zmierzony na zywo blad] NIE cala pula surowych kandydatow
  // `typeLabelMatches` — `fontRoleCandidate` z `excludeRoles: ['body']` lapie
  // KAZDY krotki token stylu akcentowego na stronie (np. Sciapod, str. 24:
  // "Niewidzialność:", "Zaklęcia:", "Utrata Poczytalności:" sa WSZYSTKIE
  // "kandydatami" typeLabel, mimo ze zaden nie zostal FAKTYCZNIE dolaczony
  // jako niczyj zawod/typ) — wykluczenie CALEJ puli polykaloby dokladnie te
  // podnaglowki notatki, ktorych ten mechanizm istnieje po to, zeby zlapac.
  // Tylko TOKENY FAKTYCZNIE DOLACZONE (`typeLabelAttached`) sa naprawde "juz
  // pokazane gdzie indziej na karcie".
  for (const c of typeLabelAttached) if (c) claimedTokenIndices.add(c.tokenIndex);

  const notesPatternIds = patternSet.entityAssembly.notesPatterns ?? [];
  const notesPatterns = notesPatternIds.map((id) => patternSet.patterns[id]).filter((p): p is Extract<typeof p, { kind: 'proseBlock' }> => p?.kind === 'proseBlock');

  return grids.map((grid, i) => {
    const attackCandidate = attackAttached[i];
    const skillsCandidate = skillsAttached[i];
    const typeLabelCandidate = typeLabelAttached[i];
    const attacks = attackCandidate ? (attackMatches.find((m) => m.headerTokenIndex === attackCandidate.tokenIndex) ?? null) : null;
    const derivedForEntity = derivedAttached[i] ?? null;
    const skillsForEntity = skillsCandidate ? (skillsMatches.find((m) => m.headerTokenIndex === skillsCandidate.tokenIndex) ?? null) : null;
    const referenceTokenIndex = notesPatterns.length > 0 ? lastClaimedTokenIndex(tokens, { grid, derived: derivedForEntity, attacks, skills: skillsForEntity }, hardStopTokenIndices) : null;
    const referenceBbox = referenceTokenIndex !== null ? tokens[referenceTokenIndex]!.bbox : grid.bbox;
    // [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, `anchorGridOnly`] `referenceBbox`
    // powyzej naznacza koniec CALEJ tresci encji (siatka+pochodne+ataki+
    // umiejetnosci) — poprawne dla notatek PONIZEJ tej tresci w TEJ SAMEJ
    // kolumnie, ale dla notatki w OSOBNEJ kolumnie (np. "Twoi przyjaciele:")
    // to niepotrzebnie wiaze jej pozycje z DLUGOSCIA listy Umiejetnosci,
    // ktora jest niezalezna geometrycznie i rozna dla kazdej postaci. Ten
    // wariant liczy sie WYLACZNIE z samej siatki-kotwicy (bez atakow/
    // umiejetnosci) — patrz `lastClaimedTokenIndex`'s wlasny, analogiczny
    // powod pomijania `derived`.
    const referenceBboxGridOnly = referenceTokenIndex !== null ? tokens[lastClaimedTokenIndex(tokens, { grid }, hardStopTokenIndices)]!.bbox : grid.bbox;
    const notes: { label: string; text: string }[] = [];
    // [KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 24, dwa bloki
    // notatek blisko siebie ("Zaklęcia"/"Utrata Poczytalności")] `claimedTokenIndices`
    // samo w sobie NIE wystarcza, gdy autor doda WIECEJ NIZ jeden wzorzec notatki
    // — bez akumulacji, DRUGI wzorzec w liscie nie wie, ze pierwszy juz zabral
    // krotki fragment tekstu, i (gdy oba offsety wskazuja blisko siebie) znajduje
    // TEN SAM token jako "najblizszy nieprzejety", produkujac DWIE notatki z
    // IDENTYCZNA trescia zamiast jednej prawdziwej i jednej `null`. Naprawa:
    // wlasna kopia na KAZDA encje (nie mutuje `claimedTokenIndices` wspoldzielonego
    // z innymi encjami), rozszerzana o zakres KAZDEGO trafienia PRZED probą
    // kolejnego wzorca w tej samej liscie.
    const claimedForNotes = new Set(claimedTokenIndices);
    const entityName = names[i]!;
    const ownNameText = entityName.kind === 'confident' ? entityName.text : undefined;
    // [ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze, `chainFromPrevious`]
    // Punkt odniesienia dla wzorcow z `chainFromPrevious: true` — startuje na
    // TYM SAMYM stalym punkcie co reszta (`referenceBbox`), ale PO KAZDYM
    // udanym dopasowaniu (niezaleznie od jego wlasnego `chainFromPrevious` —
    // kolejny wzorzec ma dostac NAJSWIEZSZY koniec, nie koniec sprzed dwoch
    // wzorcow, gdyby jeden posrodku byl jeszcze stary-styl) przesuwa sie na
    // koniec WLASNIE dopasowanej notatki. Ostatni token bloku (nie union bbox
    // calego bloku — wieloliniowy tekst zawijalby `minX` do lewej krawedzi
    // WCZESNIEJSZEJ linii, nie faktycznego konca), ten sam wzorzec co
    // `lastClaimedTokenBbox` uzywa dla grid/derived/attacks/skills.
    let chainBbox = referenceBbox;
    for (const notePattern of notesPatterns) {
      const fixedReference = notePattern.anchorGridOnly ? referenceBboxGridOnly : referenceBbox;
      const searchFrom = notePattern.chainFromPrevious ? chainBbox : fixedReference;
      const match: ProseBlockMatch | null = matchProseBlock(tokens, notePattern, searchFrom, {
        hardStopTokenIndices,
        excludedTokenIndices: claimedForNotes,
        referenceTokenIndex: referenceTokenIndex ?? undefined,
        ownNameText,
      });
      if (match) {
        notes.push({ label: match.label, text: match.text });
        for (let t = match.startIndex; t < match.endIndex; t++) claimedForNotes.add(t);
        chainBbox = tokens[match.endIndex - 1]!.bbox;
      }
    }
    return {
      ordinal: i,
      route,
      grid,
      derived: derivedForEntity,
      attacks,
      attackBelowTexts: attacks ? findAttackDescriptionsBelow(tokens, attacks, hardStopTokenIndices) : [],
      skills: skillsForEntity,
      name: names[i]!,
      typeLabel: typeLabelCandidate ? (typeLabelMatches.find((m) => m.tokenIndex === typeLabelCandidate.tokenIndex)?.text ?? null) : null,
      notes,
      bbox: grid.bbox,
    };
  });
}
