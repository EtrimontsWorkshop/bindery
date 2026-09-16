import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { ProfileV2 } from './schema.js';
import type { PageRoute } from './pageRoute.js';
import { matchLabelledPairs, matchSectionList, type LabelledPairsMatch, type SectionListMatch } from './patterns.js';
import { matchFontRoleCandidate, type FontRoleCandidateMatch } from './entityName.js';
import { findAttackDescriptionClaimedRanges } from './attackDescriptionCrossReference.js';
import { lastClaimedTokenIndex, matchProseBlock } from './proseBlock.js';
import {
  attachAndMergeLabelledPairs,
  attachNearest,
  attachNearestWithDiagnostics,
  resolveEntityNames,
  type AttachCandidate,
  type GeometricAnchor,
  type NameCandidate,
  type NameResolution,
  type OutOfRangeCandidate,
} from './entityAssembly.js';
import { resolvePatternSetForRoute, sectionListToAttachCandidates } from './assembleStatblocks.js';

/**
 * [KROK-22 Z1-Z3] Analiza diagnostyczna profilu na stronie — silnik Profile
 * Studio ("tester profili"). CELOWO OSOBNA od `assembleStatblocksOnPage`
 * (produkt), NIE jej zastapienie: ta funkcja uzywa DOKLADNIE tych samych
 * prymitywow dopasowania (`matchLabelledPairs`/`matchSectionList`/
 * `matchFontRoleCandidate`/`attachNearestWithDiagnostics`/`resolveEntityNames`)
 * wiec sama SEMANTYKA dopasowania jest JEDNYM zrodlem prawdy (zero ryzyka
 * rozjazdu) — ale dodatkowo zbiera diagnostyke (co zostalo ODRZUCONE, gdzie
 * dwie encje zachodza na siebie, ile razy kazdy wzorzec cokolwiek zlapal),
 * ktorej prawdziwy potok (uzywany do faktycznego importu) nigdy nie liczy,
 * bo jej nie potrzebuje. Wybor regul (ktory `attach` to derived/attacks/
 * skills/name) POWIELA logike `assembleStatblocksOnPage` — jedyna czesc,
 * ktora NIE jest wspoldzielona (patrz komentarz przy kazdej regule nizej).
 */

export interface AttachDiagnosticResult<TMatch> {
  match: TMatch | null;
  /** Zmierzony dystans do dopasowanego kandydata (`match !== null`). */
  distance: number | null;
  /**
   * [odkrycie #6 kroku 21] Obecne WYLACZNIE gdy `match === null`, ale jakis
   * kandydat istnial na stronie — pokazuje autorowi profilu DOKLADNIE o ile
   * trzeba by poluzowac limit (`reason: 'tooFar'`), ALBO ze kandydat byl w
   * zasiegu, tylko przejety przez inna kotwice (`reason: 'claimedByOther'`,
   * KROK-29 — patrz `OutOfRangeCandidate` w `entityAssembly.ts`).
   */
  outOfRange: { distance: number; maxDistancePt: number; reason: OutOfRangeCandidate['reason'] } | null;
}

export type StudioRegionKind = 'grid' | 'derived' | 'attacks' | 'skills' | 'name' | 'typeLabel' | 'notes';

export interface StudioRegion {
  kind: StudioRegionKind;
  bbox: Rect;
}

export interface EntityAnalysis {
  ordinal: number;
  grid: LabelledPairsMatch;
  name: NameResolution;
  derived: AttachDiagnosticResult<LabelledPairsMatch>;
  attacks: AttachDiagnosticResult<SectionListMatch>;
  skills: AttachDiagnosticResult<SectionListMatch>;
  /** [ZGŁOSZENIE po kroku 30] Swobodna etykieta zawodu/typu, wlasny, niezalezny wzorzec `fontRoleCandidate` — patrz `entityAssembly.typeLabelPattern`. */
  typeLabel: AttachDiagnosticResult<FontRoleCandidateMatch>;
  /** [KROK-34 Z2] Bloki prozy dolaczone geometrycznie — patrz `AssembledStatblock.notes` (`assembleStatblocks.ts`), TA SAMA logika. */
  notes: { label: string; text: string }[];
  /** Wszystkie bboxy "zaklaimowane" przez te encje — wejscie do wykrywania zachodzenia (`overlaps`) i do rysowania nakladek. */
  regions: StudioRegion[];
}

export interface OverlapWarning {
  entityOrdinalA: number;
  entityOrdinalB: number;
  regionKindA: StudioRegionKind;
  regionKindB: StudioRegionKind;
  intersection: Rect;
}

export type NameCandidateStatus = 'selected' | 'suggested' | 'other';

export interface NameCandidateDiagnostic {
  text: string;
  bbox: Rect;
  tokenIndex: number;
  status: NameCandidateStatus;
  /** Ordynal encji, do ktorej ten kandydat nalezy (wybrany LUB sugerowany) — `null` dla `status: 'other'`. */
  entityOrdinal: number | null;
}

export interface PatternMatchCount {
  patternId: string;
  /** Liczba WYSTAPIEN wzorca na stronie (naglowkow sekcji / siatek / kandydatow na nazwe) — NIEZALEZNA od tego, czy cokolwiek zostalo faktycznie dolaczone do jakiejs encji. Zero na CALYM dokumencie zwykle oznacza literowke w regexie (brief kroku 22). */
  matchCount: number;
}

export interface PageAnalysis {
  page: number;
  /** [KROK-39 Z1] Trasa KLASYFIKOWANA dla tej strony (`classifyPageRoute`, `pageRoute.ts`) — zastepuje dawne `isPregen: boolean` (ktore ZAWSZE znaczylo "trasa playerCharacter, wiec pomin"; od kroku 39 ta trasa MOZE byc obslugiwana, patrz `routeSupported`). */
  route: PageRoute;
  /** [KROK-39 Z1] Czy profil ma zestaw wzorcow dla `route` (`resolvePatternSetForRoute`) — `false` = strona pominieta (`entities: []`), tak jak dawne `isPregen: true`, ale teraz z jawnym powodem zamiast domyslnego zalozenia "kazda strona playerCharacter jest pomijana". Dla trasy `npc` ZAWSZE `true` (root profilu zawsze ma wzorce). */
  routeSupported: boolean;
  entities: EntityAnalysis[];
  nameCandidates: NameCandidateDiagnostic[];
  overlaps: OverlapWarning[];
  patternMatchCounts: PatternMatchCount[];
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  if (minX >= maxX || minY >= maxY) return null;
  return { minX, maxX, minY, maxY };
}

function sectionListMatchBbox(match: SectionListMatch, tokens: readonly ProfileToken[]): Rect {
  if (match.items.length > 0) {
    return match.items.map((it) => it.bbox).reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
  }
  return tokens[match.headerTokenIndex]!.bbox;
}

function classifyNameCandidates(nameMatches: readonly FontRoleCandidateMatch[], names: readonly NameResolution[]): NameCandidateDiagnostic[] {
  const selectedByTokenIndex = new Map<number, number>();
  const suggestedByText = new Map<string, number>();
  names.forEach((n, ordinal) => {
    if (n.kind === 'confident') selectedByTokenIndex.set(n.tokenIndex, ordinal);
    else for (const t of n.candidates) if (!suggestedByText.has(t)) suggestedByText.set(t, ordinal);
  });
  return nameMatches.map((m) => {
    const selectedOrdinal = selectedByTokenIndex.get(m.tokenIndex);
    if (selectedOrdinal !== undefined) return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'selected' as const, entityOrdinal: selectedOrdinal };
    const suggestedOrdinal = suggestedByText.get(m.text);
    if (suggestedOrdinal !== undefined) return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'suggested' as const, entityOrdinal: suggestedOrdinal };
    return { text: m.text, bbox: m.bbox, tokenIndex: m.tokenIndex, status: 'other' as const, entityOrdinal: null };
  });
}

function detectOverlaps(entities: readonly EntityAnalysis[]): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      for (const regionA of entities[i]!.regions) {
        for (const regionB of entities[j]!.regions) {
          const intersection = intersectRect(regionA.bbox, regionB.bbox);
          if (!intersection) continue;
          warnings.push({
            entityOrdinalA: entities[i]!.ordinal,
            entityOrdinalB: entities[j]!.ordinal,
            regionKindA: regionA.kind,
            regionKindB: regionB.kind,
            intersection,
          });
        }
      }
    }
  }
  return warnings;
}

/**
 * Analiza JEDNEJ strony. Wywolujacy dostarcza tokeny TEJ strony (jak
 * `assembleStatblocksOnPage`) — klasyfikacja trasy (`classifyPageRoute`,
 * `pageRoute.ts`) to OSOBNY, WCZESNIEJSZY krok, ten plik go NIE wywoluje sam
 * (wolajacy — `analyzeProfileDocument` — decyduje i przekazuje `route`).
 *
 * [KROK-39 Z1] `route` zastepuje dawne `isPregen: boolean` — gdy profil nie
 * ma zestawu wzorcow dla tej trasy (`resolvePatternSetForRoute` zwraca
 * `null`, np. trasa `playerCharacter` bez sekcji `profile.playerCharacter`),
 * strona jest pomijana TAK SAMO jak dawne `isPregen: true` (`entities: []`),
 * ale wynik teraz NIESIE jawny powod (`routeSupported: false`) zamiast
 * cichego zalozenia "kazda strona tej trasy jest pomijana".
 */
export function analyzeProfilePage(tokens: readonly ProfileToken[], profile: ProfileV2, page: number, route: PageRoute): PageAnalysis {
  const patternSet = resolvePatternSetForRoute(profile, route);
  if (!patternSet) {
    return { page, route, routeSupported: false, entities: [], nameCandidates: [], overlaps: [], patternMatchCounts: [] };
  }

  const anchorPatternId = patternSet.entityAssembly.anchor;
  const anchorPattern = patternSet.patterns[anchorPatternId];
  if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
    throw new Error(`analyzeProfilePage: kotwica "${anchorPatternId}" musi byc wzorcem labelledPairs, a jest "${anchorPattern?.kind ?? 'brak'}"`);
  }
  const grids = matchLabelledPairs(tokens, anchorPattern);
  const anchors: GeometricAnchor[] = grids.map((g) => ({ bbox: g.bbox, anchorTokenIndex: g.startIndex }));

  // [Wybor regul — POWIELA `assembleStatblocksOnPage`, patrz naglowek pliku]
  const derivedRule = patternSet.entityAssembly.attach.find((r) => {
    const p = patternSet.patterns[r.pattern];
    return p?.kind === 'labelledPairs' && r.pattern !== anchorPatternId;
  });
  const skillsPatternId = patternSet.entityAssembly.skillsPattern;
  const attackRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'sectionList' && r.pattern !== skillsPatternId);
  const skillsRule = skillsPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === skillsPatternId) : undefined;
  // [ZGŁOSZENIE po kroku 30] `typeLabelPattern` wylaczony z kandydatow na "ten
  // fontRoleCandidate to nazwa" — patrz identyczny komentarz w `assembleStatblocks.ts`.
  const typeLabelPatternId = patternSet.entityAssembly.typeLabelPattern;
  const nameRule = patternSet.entityAssembly.attach.find((r) => patternSet.patterns[r.pattern]?.kind === 'fontRoleCandidate' && r.pattern !== typeLabelPatternId);
  const typeLabelRule = typeLabelPatternId ? patternSet.entityAssembly.attach.find((r) => r.pattern === typeLabelPatternId) : undefined;

  // [KROK-34 Z1] `attachAndMergeLabelledPairs`, nie `attachNearestWithDiagnostics`
  // — patrz identyczny komentarz w `assembleStatblocks.ts` i definicja w
  // `entityAssembly.ts`: pozwala Studiu pokazac TO SAMO polaczone dopasowanie
  // ("Pancerz" we wlasnym akapicie + reszta pochodnych), ktore realny potok
  // teraz tez liczy — jedno zrodlo prawdy, zgodnie z naglowkiem tego pliku.
  let derivedDiag: { attached: (LabelledPairsMatch | null)[]; subMatches: LabelledPairsMatch[][]; nearestOutOfRange: (OutOfRangeCandidate | null)[] } = {
    attached: anchors.map(() => null),
    subMatches: anchors.map(() => []),
    nearestOutOfRange: anchors.map(() => null),
  };
  let derivedMaxDist = 0;
  if (derivedRule) {
    const pattern = patternSet.patterns[derivedRule.pattern];
    if (pattern?.kind === 'labelledPairs') {
      const derivedMatches = matchLabelledPairs(tokens, pattern);
      derivedDiag = attachAndMergeLabelledPairs(anchors, derivedMatches, derivedRule.strategy, derivedRule.maxDistancePt);
      derivedMaxDist = derivedRule.maxDistancePt;
    }
  }

  // [ZGŁOSZENIE po kroku 30, "Dlaczego muszę wskazywać ręcznie, skoro profil
  // już to zawiera" — patrz identyczny komentarz w `assembleStatblocks.ts`]
  // Surowe dopasowania wzorca zawodu/typu liczone PRZED rozwiazaniem nazwy,
  // zeby ich `tokenIndex` mogly wejsc do `resolveEntityNames` jako
  // `knownSiblingTokenIndices`.
  let typeLabelPattern = typeLabelRule ? patternSet.patterns[typeLabelRule.pattern] : undefined;
  if (typeLabelPattern?.kind !== 'fontRoleCandidate') typeLabelPattern = undefined;
  const typeLabelMatches: FontRoleCandidateMatch[] = typeLabelPattern ? matchFontRoleCandidate(tokens, typeLabelPattern) : [];
  const typeLabelMatchTokenIndices = new Set(typeLabelMatches.map((m) => m.tokenIndex));

  // [KROK-24 Z4b] Nazwa rozwiazywana PRZED sekcjami ATAKI/Umiejetnosci — patrz
  // identyczny komentarz w `assembleStatblocksOnPage` (`assembleStatblocks.ts`),
  // TA SAMA przyczyna (str. 56 "Głowa"/"Nogi").
  let names: NameResolution[] = anchors.map((_, i) => ({
    kind: 'placeholder',
    placeholder: patternSet.entityAssembly.namePlaceholder.replace('{page}', String(page)).replace('{ordinal}', String(i + 1)),
    candidates: [],
  }));
  let nameMatches: FontRoleCandidateMatch[] = [];
  // [ZGŁOSZENIE po kroku 30, zmierzony na zywo blad — patrz identyczny
  // komentarz w `assembleStatblocks.ts`] Token(y), ktore dopasowanie nazwy
  // uznaloby za "najblizszy kandydat" dla KTOREJKOLWIEK kotwicy, liczone
  // NIEZALEZNIE od progu pewnosci — placeholder z powodu niejednoznacznosci
  // (S4) NADAL "zajmuje" ten token geometrycznie, tylko nie pewnie dosc, zeby
  // pokazac go jako `name`. Uzyte ponizej przy `typeLabel`.
  let nameClaimedTokenIndices = new Set<number>();
  if (nameRule) {
    const pattern = patternSet.patterns[nameRule.pattern];
    if (pattern?.kind === 'fontRoleCandidate') {
      nameMatches = matchFontRoleCandidate(tokens, pattern);
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

  // [KROK-20 Z2, rozszerzone w KROK-24 Z4b, KROK-34 Z2 — patrz identyczny
  // komentarz w `assembleStatblocks.ts`] `confidentNameTokenIndices` (KROK-24
  // Z4b, dowolna rola) DODATKOWO (nie zamiast) surowi kandydaci z rola `heading`
  // (KROK-34 Z2 — NIE caly `nameMatches` bez filtra, `accent` bywa szumem
  // WEWNATRZ zwyklej listy umiejetnosci, patrz `assembleStatblocks.ts`) — token,
  // ktory wyglada jak PRAWDZIWY tytul/naglowek, jest granica nawet gdy nie ma
  // wlasnej siatki NA TEJ stronie (np. zapowiedz kolejnego potwora na koncu
  // strony).
  const anchorStartIndices = grids.map((g) => g.startIndex);
  const confidentNameTokenIndices = names.filter((n): n is Extract<NameResolution, { kind: 'confident' }> => n.kind === 'confident').map((n) => n.tokenIndex);
  const headingNameTokenIndices = nameMatches.filter((m) => tokens[m.tokenIndex]?.fontRole === 'heading').map((m) => m.tokenIndex);
  const hardStopTokenIndices = [...anchorStartIndices, ...confidentNameTokenIndices, ...headingNameTokenIndices];

  let attackMatches: SectionListMatch[] = [];
  let attackDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let attackMaxDist = 0;
  if (attackRule) {
    const pattern = patternSet.patterns[attackRule.pattern];
    if (pattern?.kind === 'sectionList') {
      attackMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      attackDiag = attachNearestWithDiagnostics(anchors, sectionListToAttachCandidates(attackMatches, tokens), attackRule.strategy, attackRule.maxDistancePt);
      attackMaxDist = attackRule.maxDistancePt;
    }
  }

  let skillsMatches: SectionListMatch[] = [];
  let skillsDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let skillsMaxDist = 0;
  if (skillsRule) {
    const pattern = patternSet.patterns[skillsRule.pattern];
    if (pattern?.kind === 'sectionList') {
      skillsMatches = matchSectionList(tokens, pattern, hardStopTokenIndices);
      skillsDiag = attachNearestWithDiagnostics(anchors, sectionListToAttachCandidates(skillsMatches, tokens), skillsRule.strategy, skillsRule.maxDistancePt);
      skillsMaxDist = skillsRule.maxDistancePt;
    }
  }

  // [ZGŁOSZENIE po kroku 30, zmierzony na zywo blad — patrz identyczny
  // komentarz w `assembleStatblocks.ts`] KAZDY token, ktory dopasowanie nazwy
  // uznaloby za swojego najlepszego kandydata dla KTOREJKOLWIEK kotwicy
  // (`nameClaimedTokenIndices` — NIE tylko `confident`, bo placeholder z
  // powodu niejednoznacznosci omijalby wykluczenie), jest wykluczony z puli
  // kandydatow na zawod/typ — bez tego, gdy `requireFontKeys` obu wzorcow
  // (nazwa/zawod) jeszcze nie zawezono, `typeLabel` wychodzil identyczny jak
  // `name` (ten sam, geometrycznie najblizszy token wybrany NIEZALEZNIE przez
  // oba wywolania).
  let typeLabelDiag = { attached: anchors.map(() => null) as (AttachCandidate | null)[], nearestOutOfRange: anchors.map(() => null) as (OutOfRangeCandidate | null)[] };
  let typeLabelMaxDist = 0;
  if (typeLabelPattern && typeLabelRule) {
    const typeLabelCandidates: AttachCandidate[] = typeLabelMatches
      .filter((m) => !nameClaimedTokenIndices.has(m.tokenIndex))
      .map((m) => ({ bbox: m.bbox, tokenIndex: m.tokenIndex }));
    typeLabelDiag = attachNearestWithDiagnostics(anchors, typeLabelCandidates, typeLabelRule.strategy, typeLabelRule.maxDistancePt);
    typeLabelMaxDist = typeLabelRule.maxDistancePt;
  }

  // [KROK-34 Z2] Patrz identyczny komentarz w `assembleStatblocks.ts`.
  const claimedTokenIndices = new Set<number>();
  for (const g of grids) for (let t = g.startIndex; t < g.endIndex; t++) claimedTokenIndices.add(t);
  // [KROK-34 Z2] Patrz identyczny komentarz w `assembleStatblocks.ts` —
  // `subMatches` (ciagle zakresy WLASNE), NIE bounding `attached[i]`.
  for (const subs of derivedDiag.subMatches) for (const d of subs) for (let t = d.startIndex; t < d.endIndex; t++) claimedTokenIndices.add(t);
  // [KROK-34 Z2] Patrz identyczny komentarz w `assembleStatblocks.ts` — tylko
  // `items` (WLACZNIE), NIE cala `[headerTokenIndex, endIndex)`.
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
  // [KROK-34 Z2] Patrz identyczny komentarz w `assembleStatblocks.ts` — tylko
  // FAKTYCZNIE dolaczone (`typeLabelDiag.attached`), nie cala surowa pula.
  for (const c of typeLabelDiag.attached) if (c) claimedTokenIndices.add(c.tokenIndex);
  const notesPatternIds = patternSet.entityAssembly.notesPatterns ?? [];
  const notesPatterns = notesPatternIds.map((id) => patternSet.patterns[id]).filter((p): p is Extract<typeof p, { kind: 'proseBlock' }> => p?.kind === 'proseBlock');

  const entities: EntityAnalysis[] = grids.map((grid, i) => {
    const derivedMatch = derivedDiag.attached[i] ?? null;
    const derived: AttachDiagnosticResult<LabelledPairsMatch> = derivedMatch
      ? { match: derivedMatch, distance: rectGapDistance(grid.bbox, derivedMatch.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(derivedDiag.nearestOutOfRange[i] ?? null, derivedMaxDist) };

    const attackAttached = attackDiag.attached[i] ?? null;
    const attackMatch = attackAttached ? (attackMatches.find((m) => m.headerTokenIndex === attackAttached.tokenIndex) ?? null) : null;
    const attacks: AttachDiagnosticResult<SectionListMatch> = attackMatch
      ? { match: attackMatch, distance: rectGapDistance(grid.bbox, tokens[attackMatch.headerTokenIndex]!.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(attackDiag.nearestOutOfRange[i] ?? null, attackMaxDist) };

    const skillsAttached = skillsDiag.attached[i] ?? null;
    const skillsMatch = skillsAttached ? (skillsMatches.find((m) => m.headerTokenIndex === skillsAttached.tokenIndex) ?? null) : null;
    const skills: AttachDiagnosticResult<SectionListMatch> = skillsMatch
      ? { match: skillsMatch, distance: rectGapDistance(grid.bbox, tokens[skillsMatch.headerTokenIndex]!.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(skillsDiag.nearestOutOfRange[i] ?? null, skillsMaxDist) };

    const typeLabelAttached = typeLabelDiag.attached[i] ?? null;
    const typeLabelMatch = typeLabelAttached ? (typeLabelMatches.find((m) => m.tokenIndex === typeLabelAttached.tokenIndex) ?? null) : null;
    const typeLabel: AttachDiagnosticResult<FontRoleCandidateMatch> = typeLabelMatch
      ? { match: typeLabelMatch, distance: rectGapDistance(grid.bbox, typeLabelMatch.bbox), outOfRange: null }
      : { match: null, distance: null, outOfRange: toOutOfRange(typeLabelDiag.nearestOutOfRange[i] ?? null, typeLabelMaxDist) };

    const name = names[i]!;
    const notes: { label: string; text: string }[] = [];
    const noteRegionBboxes: Rect[] = [];
    const referenceTokenIndex = notesPatterns.length > 0 ? lastClaimedTokenIndex(tokens, { grid, derived: derivedMatch, attacks: attackMatch, skills: skillsMatch }, hardStopTokenIndices) : null;
    const referenceBbox = referenceTokenIndex !== null ? tokens[referenceTokenIndex]!.bbox : grid.bbox;
    // [KROK-34 Z2, zmierzony na zywo blad — patrz identyczny komentarz w
    // `assembleStatblocks.ts`] Wlasna kopia na KAZDA encje, rozszerzana o
    // zakres KAZDEGO trafienia PRZED proba kolejnego wzorca w tej samej
    // liscie — bez tego dwa bliskie sobie wzorce notatek (np. "Zaklęcia"/
    // "Utrata Poczytalności") moga zwrocic IDENTYCZNA tresc.
    const claimedForNotes = new Set(claimedTokenIndices);
    const ownNameText = name.kind === 'confident' ? name.text : undefined;
    for (const notePattern of notesPatterns) {
      const match = matchProseBlock(tokens, notePattern, referenceBbox, {
        hardStopTokenIndices,
        excludedTokenIndices: claimedForNotes,
        referenceTokenIndex: referenceTokenIndex ?? undefined,
        ownNameText,
      });
      if (match) {
        notes.push({ label: match.label, text: match.text });
        noteRegionBboxes.push(match.bbox);
        for (let t = match.startIndex; t < match.endIndex; t++) claimedForNotes.add(t);
      }
    }

    const regions: StudioRegion[] = [{ kind: 'grid', bbox: grid.bbox }];
    if (derived.match) regions.push({ kind: 'derived', bbox: derived.match.bbox });
    if (attacks.match) regions.push({ kind: 'attacks', bbox: sectionListMatchBbox(attacks.match, tokens) });
    if (skills.match) regions.push({ kind: 'skills', bbox: sectionListMatchBbox(skills.match, tokens) });
    if (name.kind === 'confident') regions.push({ kind: 'name', bbox: tokens[name.tokenIndex]!.bbox });
    if (typeLabel.match) regions.push({ kind: 'typeLabel', bbox: typeLabel.match.bbox });
    for (const bbox of noteRegionBboxes) regions.push({ kind: 'notes', bbox });

    return { ordinal: i, grid, name, derived, attacks, skills, typeLabel, notes, regions };
  });

  const patternMatchCounts: PatternMatchCount[] = Object.entries(patternSet.patterns).map(([patternId, pattern]) => {
    if (pattern.kind === 'labelledPairs') return { patternId, matchCount: matchLabelledPairs(tokens, pattern).length };
    if (pattern.kind === 'sectionList') return { patternId, matchCount: matchSectionList(tokens, pattern).length };
    // [KROK-34 Z2] `proseBlock` nie skanuje strony tekstowo (dopasowanie jest
    // WZGLEDEM kotwicy, nie regexem) — "0 trafien na cala ksiazke = literowka w
    // regexie" (sens tej diagnostyki, patrz `PatternMatchCount`) nie ma tu
    // zastosowania; entities[].notes ponizej juz pokazuje realny wynik per encja.
    if (pattern.kind === 'proseBlock') return { patternId, matchCount: 0 };
    return { patternId, matchCount: matchFontRoleCandidate(tokens, pattern).length };
  });

  return {
    page,
    route,
    routeSupported: true,
    entities,
    nameCandidates: classifyNameCandidates(nameMatches, names),
    overlaps: detectOverlaps(entities),
    patternMatchCounts,
  };
}


function toOutOfRange(entry: OutOfRangeCandidate | null, maxDistancePt: number): { distance: number; maxDistancePt: number; reason: OutOfRangeCandidate['reason'] } | null {
  return entry ? { distance: entry.distance, maxDistancePt, reason: entry.reason } : null;
}

export interface DocumentPageSummary {
  page: number;
  /** [KROK-39 Z1] Patrz `PageAnalysis.route`/`.routeSupported` — zastepuje dawne `isPregen: boolean`. */
  route: PageRoute;
  routeSupported: boolean;
  entityCount: number;
  fullCount: number;
  warningCount: number;
  placeholderNameCount: number;
}

export interface DocumentAnalysis {
  pageCount: number;
  pages: PageAnalysis[];
  /** Rozklad trafien per wzorzec, ZSUMOWANY po calym dokumencie — wzorzec z `matchCount: 0` to zazwyczaj literowka w regexie (brief kroku 22). */
  patternMatchTotals: PatternMatchCount[];
  totalEntities: number;
  totalWarnings: number;
  totalPlaceholderNames: number;
  pageSummaries: DocumentPageSummary[];
}

/** [KROK-22 Z4] Agreguje `PageAnalysis[]` (juz policzone przez `analyzeProfileDocument`) w podsumowanie catego dokumentu — CZYSTA funkcja, zero pdf.js, testowalna wprost na syntetycznych `PageAnalysis`. */
export function aggregateDocumentAnalysis(pages: readonly PageAnalysis[]): DocumentAnalysis {
  const patternTotals = new Map<string, number>();
  let totalEntities = 0;
  let totalWarnings = 0;
  let totalPlaceholderNames = 0;
  const pageSummaries: DocumentPageSummary[] = [];

  for (const p of pages) {
    for (const c of p.patternMatchCounts) patternTotals.set(c.patternId, (patternTotals.get(c.patternId) ?? 0) + c.matchCount);
    totalEntities += p.entities.length;
    totalWarnings += p.overlaps.length + p.entities.filter((e) => e.derived.outOfRange || e.attacks.outOfRange || e.skills.outOfRange || e.typeLabel.outOfRange).length;
    const placeholderCount = p.entities.filter((e) => e.name.kind === 'placeholder').length;
    totalPlaceholderNames += placeholderCount;
    const fullCount = p.entities.filter(
      (e) => e.name.kind === 'confident' && !e.derived.outOfRange && !e.attacks.outOfRange && !e.skills.outOfRange && !e.typeLabel.outOfRange,
    ).length;
    const pageWarningCount = p.overlaps.length + p.entities.filter((e) => e.derived.outOfRange || e.attacks.outOfRange || e.skills.outOfRange || e.typeLabel.outOfRange).length;
    pageSummaries.push({ page: p.page, route: p.route, routeSupported: p.routeSupported, entityCount: p.entities.length, fullCount, warningCount: pageWarningCount, placeholderNameCount: placeholderCount });
  }

  return {
    pageCount: pages.length,
    pages: [...pages],
    patternMatchTotals: [...patternTotals.entries()].map(([patternId, matchCount]) => ({ patternId, matchCount })),
    totalEntities,
    totalWarnings,
    totalPlaceholderNames,
    pageSummaries,
  };
}

/** [KROK-22 Z5] Ksztalt eksportu diagnostyki — CZYTELNY dla czlowieka (brief: "nie zrzut wewnetrznych struktur"), nie 1:1 z `DocumentAnalysis`. Wyklucza pola wewnetrzne (surowe `SectionListMatch`/tokeny), zostaje TYLKO to, co autor profilu faktycznie potrzebuje przeczytac/dolaczyc do zgloszenia. */
/** [KROK-29] `'poza-zasiegiem'` = kandydat faktycznie dalej niz `limit`; `'zajety'` = kandydat byl w zasiegu, ale przypadl innej encji w globalnym dopasowaniu (patrz `OutOfRangeCandidate`, `entityAssembly.ts`) — dwa rozne stany, ktore poprzednia wersja eksportu myliła pod jednym "poza-zasiegiem". */
export interface DiagnosticsExportEntity {
  ordinal: number;
  name: string;
  nameStatus: 'confident' | 'placeholder';
  nameCandidates?: readonly string[];
  derived: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  attacks: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  skills: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
  /** [ZGŁOSZENIE po kroku 30] `'brak'`, gdy profil nie wskazal `typeLabelPattern` LUB gdy nic nie dopasowano — ta sama konwencja co `derived`/`attacks`/`skills` powyzej (zadne z nich tez nie rozroznia "wzorzec nieskonfigurowany" od "skonfigurowany, ale bez trafienia"). */
  typeLabel: 'ok' | 'brak' | { status: 'poza-zasiegiem' | 'zajety'; dystans: number; limit: number };
}

export interface DiagnosticsExportOverlap {
  encjaA: number;
  encjaB: number;
  obszarA: StudioRegionKind;
  obszarB: StudioRegionKind;
}

export interface DiagnosticsExportPage {
  strona: number;
  /** [KROK-39 Z1] Trasa tej strony (`PageAnalysis.route`) — `'npc'` lub `'playerCharacter'`. */
  trasa: PageRoute;
  /** [KROK-39 Z1] Zastepuje dawne `pominietaJakoPregen` — `false` = strona pominieta, bo profil nie ma wzorcow dla `trasa` (`PageAnalysis.routeSupported`). */
  trasaObslugiwana: boolean;
  encje: DiagnosticsExportEntity[];
  zachodzenia: DiagnosticsExportOverlap[];
}

export interface DiagnosticsExport {
  liczbaStron: number;
  liczbaEncji: number;
  liczbaOstrzezen: number;
  liczbaNazwPlaceholder: number;
  trafieniaPerWzorzec: Record<string, number>;
  strony: DiagnosticsExportPage[];
}

function attachResultToExport<TMatch>(result: AttachDiagnosticResult<TMatch>): DiagnosticsExportEntity['derived'] {
  if (result.match) return 'ok';
  if (result.outOfRange) {
    const status = result.outOfRange.reason === 'tooFar' ? 'poza-zasiegiem' : 'zajety';
    return { status, dystans: Math.round(result.outOfRange.distance), limit: result.outOfRange.maxDistancePt };
  }
  return 'brak';
}

/** [KROK-22 Z5] `DocumentAnalysis` (JUZ policzone) -> ksztalt do zapisu jako plik JSON. CZYSTA funkcja (zero `Date.now()`/losowosci — determinizm, `check:size`-siostrzana zasada projektu), wolajacy (`ProfileStudio.ts`) dodaje ewentualna date/nazwe pliku PO stronie modulu. */
export function buildDiagnosticsExport(analysis: DocumentAnalysis): DiagnosticsExport {
  return {
    liczbaStron: analysis.pageCount,
    liczbaEncji: analysis.totalEntities,
    liczbaOstrzezen: analysis.totalWarnings,
    liczbaNazwPlaceholder: analysis.totalPlaceholderNames,
    trafieniaPerWzorzec: Object.fromEntries(analysis.patternMatchTotals.map((c) => [c.patternId, c.matchCount])),
    strony: analysis.pages
      .filter((p) => !p.routeSupported || p.entities.length > 0)
      .map((p) => ({
        strona: p.page,
        trasa: p.route,
        trasaObslugiwana: p.routeSupported,
        encje: p.entities.map((e) => ({
          ordinal: e.ordinal,
          name: e.name.kind === 'confident' ? e.name.text : e.name.placeholder,
          nameStatus: e.name.kind,
          nameCandidates: e.name.kind === 'placeholder' && e.name.candidates.length > 0 ? e.name.candidates : undefined,
          derived: attachResultToExport(e.derived),
          attacks: attachResultToExport(e.attacks),
          skills: attachResultToExport(e.skills),
          typeLabel: attachResultToExport(e.typeLabel),
        })),
        zachodzenia: p.overlaps.map((o) => ({ encjaA: o.entityOrdinalA, encjaB: o.entityOrdinalB, obszarA: o.regionKindA, obszarB: o.regionKindB })),
      })),
  };
}
