import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { LabelledPairsMatch } from './patterns.js';

/**
 * [KROK-18 Z3] Skladanie encji przez geometrie — implementacja
 * `entityAssembly` z §5.5 MDD. Parowanie GEOMETRYCZNE (bbox), nie po
 * kolejnosci w strumieniu tekstu — S3: encje wystepuja partiami (wszystkie
 * nazwy, potem wszystkie siatki, potem wszystkie bloki pochodne/ataki, NIE
 * przeplecione per-encja, potwierdzone bezposrednio na str. 55 ksiazki z
 * kroku 12/13).
 *
 * Dwie oddzielne funkcje:
 * - `attachNearest` — ogolne dolaczanie (derivedBlock/attackSection do
 *   kotwicy-siatki), zwraca po prostu najblizszego kandydata w danym
 *   kierunku albo `null`. Zaden pomysl pewnosci — MDD nie wymaga confidence
 *   dla tych wzorcow, tylko dla nazwy (S4).
 * - `resolveEntityNames` — parowanie nazwa<->siatka (H3 ze spike'u kroku 13),
 *   Z WBUDOWANA pewnoscia i progiem (S4): ponizej `nameConfidenceThreshold`
 *   NIGDY nie zgaduj, placeholder + lista kandydatow do rozstrzygniecia w
 *   przegladzie (bledna nazwa gorsza niz jej brak).
 */

export interface GeometricAnchor {
  bbox: Rect;
  /** Indeks pierwszego tokenu tej kotwicy w strumieniu — do porzadku przetwarzania i `preferEarlierSibling`. */
  anchorTokenIndex: number;
}

export interface AttachCandidate {
  bbox: Rect;
  tokenIndex: number;
}

export type AttachStrategy = 'nearestBelow' | 'nearestAbove' | 'nearest';

export interface PreferEarlierSiblingConfig {
  maxDeltaYPt: number;
}

/**
 * Odleglosc kandydata od kotwicy WE WLASCIWYM KIERUNKU, albo `null` jesli
 * kandydat wcale nie lezy w tym kierunku (PDF: Y rosnie W GORE strony —
 * "below" = MNIEJSZE Y, patrz `pageOverlayGeometry.ts`).
 *
 * [KROK-18 Z7] `nearest` — BEZ wymogu kierunku, sam dystans euklidesowy
 * miedzy krawedziami bboksow. Dopisane po pomiarze na calej ksiazce: strony z
 * wieloma postaciami ukladaja siatke i jej blok pochodnych OBOK SIEBIE w tej
 * samej linii (kolumny), nie jedna pod druga — `nearestBelow`/`nearestAbove`
 * nigdy nie znajduja takiego kandydata (warunek kierunkowy nigdy spelniony),
 * niezaleznie od `maxDistancePt`. Zob. komentarz przy `AttachStrategy` w schema.ts.
 */
export function directionalDistance(anchor: Rect, candidate: Rect, strategy: AttachStrategy): number | null {
  const horizontalGap = Math.max(candidate.minX - anchor.maxX, anchor.minX - candidate.maxX, 0);
  if (strategy === 'nearest') return rectGapDistance(anchor, candidate);
  if (strategy === 'nearestBelow') {
    if (candidate.maxY > anchor.minY) return null;
    return Math.hypot(anchor.minY - candidate.maxY, horizontalGap);
  }
  if (candidate.minY < anchor.maxY) return null;
  return Math.hypot(candidate.minY - anchor.maxY, horizontalGap);
}

export type RelativeDirection = 'below' | 'above' | 'beside';

/**
 * [KROK-24 Z2] Klasyfikuje POLOZENIE kandydata wzgledem kotwicy, BEZ progu
 * odleglosci — do pomiaru geometrii (`measureAttachGeometry.ts`), nie do
 * samego dopasowania. Reuzywa `directionalDistance`, zeby definicja
 * "ponizej"/"powyzej" byla JEDNYM zrodlem prawdy z faktycznym dopasowaniem
 * uzywanym przez `attachNearestInternal`.
 */
export function classifyRelativeDirection(anchor: Rect, candidate: Rect): RelativeDirection {
  if (directionalDistance(anchor, candidate, 'nearestBelow') !== null) return 'below';
  if (directionalDistance(anchor, candidate, 'nearestAbove') !== null) return 'above';
  return 'beside';
}

interface BestPick {
  index: number;
  distance: number;
}

function pickBest(anchor: Rect, candidates: readonly AttachCandidate[], used: ReadonlySet<number>, strategy: AttachStrategy, maxDistancePt: number): BestPick | null {
  let best: BestPick | null = null;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    const dist = directionalDistance(anchor, candidates[i]!.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    if (!best || dist < best.distance) best = { index: i, distance: dist };
  }
  return best;
}

/**
 * [H3, spike krok 13] Nazwa i podtytul stoja blisko w tym samym kroju —
 * naiwny "najblizszy" wybiera czesc PODTYTUL, bo lezy blizej (nizej/pozniej)
 * kotwicy niz sama nazwa. Preferuj WCZESNIEJSZEGO (w strumieniu) sasiada w
 * bliskiej odleglosci pionowej od `best` — zalozenie "Nazwa nad Podtytulem".
 */
function preferEarlierSibling(
  anchor: Rect,
  candidates: readonly AttachCandidate[],
  used: ReadonlySet<number>,
  strategy: AttachStrategy,
  maxDistancePt: number,
  best: BestPick,
  config: PreferEarlierSiblingConfig,
): BestPick {
  const bestCandidate = candidates[best.index]!;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i) || i === best.index) continue;
    const candidate = candidates[i]!;
    if (candidate.tokenIndex >= bestCandidate.tokenIndex) continue;
    if (Math.abs(candidate.bbox.minY - bestCandidate.bbox.minY) > config.maxDeltaYPt) continue;
    const dist = directionalDistance(anchor, candidate.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    return { index: i, distance: dist };
  }
  return best;
}

/**
 * [KROK-30, zmierzony na zywo blad, ZAWEZONE po regresji] `preferEarlierSibling`
 * wyklucza podtytul z liczenia dwuznacznosci WYLACZNIE wtedy, gdy musial
 * aktywnie PRZELACZYC wybor z podtytulu na nazwe (`chosen.index !== best.index`
 * w `resolveEntityNames`). Gdy nazwa jest JUZ geometrycznie najblizsza (typowy
 * uklad "Nazwa nad Podtytulem" na TEJ SAMEJ linii, nazwa zaczyna sie bardziej
 * na lewo wiec bywa i tak najblizsza kotwicy), przelaczenie nigdy nie zachodzi,
 * wiec podtytul NIGDY nie zostaje wykluczony — zostaje policzony jako "drugi
 * najlepszy kandydat" i uruchamia kare dwuznacznosci, mimo ze to DOKLADNIE ten
 * sam, oczekiwany wzorzec "Nazwa+Podtytul". Zmierzone wprost na realnych
 * danych (str. 23-24 "Zew Cthulhu 7ed. Wrak.pdf", KROK-30 Z5,
 * RAPORT-KROK-30.md): Calhoun/Hansen/Sciapod wszyscy dostawali placeholder
 * zamiast pewnej nazwy z tego wlasnie powodu.
 *
 * [Regresja, zmierzona na zywo NATYCHMIAST po pierwszej wersji] Pierwsza
 * wersja wykluczala KAZDEGO sasiada w tym samym pasmie Y, bez wzgledu na
 * polozenie X — zlapala test `studioAnalysis.test.ts` skonstruowany
 * SWIADOMIE odwrotnie: dwa NIEZALEZNE, KONKURUJACE kandydaty na nazwe
 * ("Kandydat A"/"Kandydat B") postawione NIEMAL W TYM SAMYM miejscu (ten sam
 * X, 1pt roznicy Y) maja reprezentowac PRAWDZIWA dwuznacznosc, ktora silnik
 * MA wykryc, a "poszerzone" wykluczenie mylnie je scalalo. Prawdziwa nazwa +
 * podtytul NIE stoja w tym samym miejscu — leza NA TEJ SAMEJ LINII, jedno PO
 * DRUGIM (podtytul zaczyna sie tam, gdzie nazwa sie konczy, X nie zachodzi na
 * siebie): zmierzone wprost, "John Calhoun," konczy sie na X=143.0, "kapitan
 * jachtu" zaczyna sie na X=146.6. Naprawa: DODATKOWO wymagaj, zeby kandydat
 * (a) byl POZNIEJ w strumieniu niz wybrany (lustrzane odbicie kierunku
 * `preferEarlierSibling`, ktory patrzy WSTECZ) i (b) jego X NIE zachodzil na
 * X wybranego (zaczyna sie tam, gdzie wybrany sie konczy, albo dalej) — to
 * dokladnie odrzuca test-owy przypadek "dwa kandydaci w tym samym miejscu"
 * (Kandydat B zaczyna sie na X=1, wybrany "Kandydat A" konczy sie na X=8 —
 * zachodzi), zachowujac naprawe prawdziwego przypadku "Nazwa+Podtytul".
 */
function findKnownSiblingIndex(
  anchor: Rect,
  candidates: readonly AttachCandidate[],
  used: ReadonlySet<number>,
  strategy: AttachStrategy,
  maxDistancePt: number,
  chosenIndex: number,
  config: PreferEarlierSiblingConfig,
): number | null {
  const chosenCandidate = candidates[chosenIndex]!;
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i) || i === chosenIndex) continue;
    const candidate = candidates[i]!;
    if (candidate.tokenIndex <= chosenCandidate.tokenIndex) continue;
    if (candidate.bbox.minX < chosenCandidate.bbox.maxX) continue;
    if (Math.abs(candidate.bbox.minY - chosenCandidate.bbox.minY) > config.maxDeltaYPt) continue;
    const dist = directionalDistance(anchor, candidate.bbox, strategy);
    if (dist === null || dist > maxDistancePt) continue;
    return i;
  }
  return null;
}

/**
 * [KROK-21, zmierzony na zywo blad] Dolacza kandydatow do kotwic jako
 * GLOBALNE dopasowanie o minimalnym LACZNYM dystansie (zachlanne po
 * posortowanych parach rosnaco), NIE per-kotwica w kolejnosci strumienia.
 * Roznica ma znaczenie: str. 55 "nie czas na krzyk" ma 3 postacie w ukladzie
 * dwukolumnowym, gdzie siatka JEDNEJ postaci bywa geometrycznie BLIZEJ
 * sekcji ATAKI SASIADA (przez odstepy portretu/obrazu w jej WLASNEJ kolumnie)
 * niz wlasnej sekcji ATAKI. Wersja "kazda kotwica bierze swojego
 * najblizszego, kotwice przetwarzane w kolejnosci strumienia" prowadzila do
 * zamiany: pierwsza przetworzona kotwica (Warwick) "kradla" sekcje ATAKI
 * sasiadki (Pielegniarki, bo byla jej geometrycznie blizej niz wlasna), a
 * Pielegniarka dostawala to, co zostalo — Warwicka wlasna sekcje. Zmierzone
 * wprost: obie pary MYLONYCH kandydatow maja WIEKSZY dystans niz ich
 * WLASCIWE (prawidlowe) pary — globalne sortowanie po najmniejszym dystansie
 * NAJPIERW przydziela wlasciwe, ciasno dopasowane pary (np. Pielegniarka<->jej
 * wlasna ATAKI, dystans ~25pt), zanim jakikolwiek dalszy/dwuznaczny kandydat
 * (Warwick<->cudza ATAKI, dystans ~120pt) w ogole dostanie szanse. Dla stron
 * BEZ dwuznacznosci (typowa jedna postac na stronie) wynik identyczny jak
 * poprzednio — kazda kotwica i tak dostaje swojego jedynego/najblizszego
 * kandydata, kolejnosc przetwarzania nie ma tu znaczenia.
 */
/**
 * [KROK-22 Z2/Z3] Kandydat najblizszy kotwicy bez zadnego dopasowania w
 * `maxDistancePt` — diagnostyka "kandydat poza zasiegiem" (odkrycie #6 kroku
 * 21: dzis to milczy, nieodroznialne od "strona faktycznie nic nie ma").
 *
 * [KROK-29, zmierzony na zywo blad] Nazwa jest MYLACA — ten kandydat CZESTO
 * jest FAKTYCZNIE poza `maxDistancePt` (`reason: 'tooFar'`), ale zdarza sie
 * TEZ (globalne, zachlanne dopasowanie w `attachNearestInternal`), ze lezy
 * DOBRZE wewnatrz limitu, po prostu inna kotwica dostala go pierwsza w
 * sortowaniu po najmniejszym dystansie (`reason: 'claimedByOther'`) —
 * zmierzone wprost: str. 23 "Zew Cthulhu 7ed. Wrak.pdf", Calhoun pokazywal
 * "kandydat 87pt, limit 400pt" jako "poza zasiegiem", mimo ze 87 < 400,
 * dokladnie dlatego, ze jego wlasciwy kandydat zostal PRZEJETY przez inna,
 * geometrycznie blizsza kotwice (spowodowane INNYM bledem — sekcja sasiada
 * bez wlasnej granicy rozrosla sie na cala strone). `distance`/`maxDistancePt`
 * SAME W SOBIE nie mowia, ktory to przypadek — komunikat UI musi rozroznic
 * `reason`, zeby nie pokazac nonsensownego "87pt > 400pt" (dystans MNIEJSZY
 * niz limit, opisany jako przekroczenie).
 */
export interface OutOfRangeCandidate {
  distance: number;
  candidate: AttachCandidate;
  reason: 'tooFar' | 'claimedByOther';
}

export interface AttachDiagnostics {
  attached: (AttachCandidate | null)[];
  /** Dla kazdej kotwicy BEZ dopasowania (`attached[i] === null`): najblizszy kandydat IGNORUJAC `maxDistancePt`, jesli jakikolwiek istnieje w tym kierunku na stronie. `null` przy dopasowaniu ALBO przy calkowitym braku kandydatow. */
  nearestOutOfRange: (OutOfRangeCandidate | null)[];
}

function attachNearestInternal(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): AttachDiagnostics {
  const allPairs: { anchorIndex: number; candidateIndex: number; distance: number }[] = [];
  for (let ai = 0; ai < anchors.length; ai++) {
    for (let ci = 0; ci < candidates.length; ci++) {
      const dist = directionalDistance(anchors[ai]!.bbox, candidates[ci]!.bbox, strategy);
      if (dist === null) continue;
      allPairs.push({ anchorIndex: ai, candidateIndex: ci, distance: dist });
    }
  }
  const withinLimit = allPairs.filter((p) => p.distance <= maxDistancePt).sort((a, b) => a.distance - b.distance);

  const usedAnchors = new Set<number>();
  const usedCandidates = new Set<number>();
  const attached: (AttachCandidate | null)[] = new Array(anchors.length).fill(null);
  for (const pair of withinLimit) {
    if (usedAnchors.has(pair.anchorIndex) || usedCandidates.has(pair.candidateIndex)) continue;
    usedAnchors.add(pair.anchorIndex);
    usedCandidates.add(pair.candidateIndex);
    attached[pair.anchorIndex] = candidates[pair.candidateIndex]!;
  }

  const nearestOutOfRange: (OutOfRangeCandidate | null)[] = anchors.map((_, ai) => {
    if (attached[ai]) return null;
    let best: { candidateIndex: number; distance: number } | null = null;
    for (const p of allPairs) {
      if (p.anchorIndex !== ai) continue;
      if (!best || p.distance < best.distance) best = { candidateIndex: p.candidateIndex, distance: p.distance };
    }
    if (!best) return null;
    // [KROK-29, zmierzony na zywo blad] `best.distance <= maxDistancePt`
    // znaczy, ze ten kandydat BYL w zasiegu, ale poszedl do innej kotwicy w
    // zachlannym globalnym dopasowaniu wyzej (inaczej `attached[ai]` bylby
    // ustawiony) — patrz komentarz przy `OutOfRangeCandidate`.
    const reason: OutOfRangeCandidate['reason'] = best.distance > maxDistancePt ? 'tooFar' : 'claimedByOther';
    return { distance: best.distance, candidate: candidates[best.candidateIndex]!, reason };
  });

  return { attached, nearestOutOfRange };
}

export function attachNearest(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): (AttachCandidate | null)[] {
  return attachNearestInternal(anchors, candidates, strategy, maxDistancePt).attached;
}

/** [KROK-22 Z2/Z3] Jak `attachNearest`, ale zwraca TEZ diagnostyke "kandydat poza zasiegiem" — WYLACZNIE do Profile Studio (podglad/diagnostyka), nie do prawdziwego potoku importu (ktory dalej wola `attachNearest` bez zmian). Ta sama wewnetrzna logika co `attachNearest` (`attachNearestInternal`), zeby diagnostyka nigdy nie mogla rozjechac sie z prawdziwym dopasowaniem. */
export function attachNearestWithDiagnostics(
  anchors: readonly GeometricAnchor[],
  candidates: readonly AttachCandidate[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): AttachDiagnostics {
  return attachNearestInternal(anchors, candidates, strategy, maxDistancePt);
}

export interface MergedLabelledPairsAttachment {
  attached: (LabelledPairsMatch | null)[];
  /**
   * [KROK-34 Z2, zmierzony na zywo blad] `attached[i].startIndex..endIndex`
   * to bounding UNIA wszystkich dolaczonych dopasowan — NIE ciagly zakres
   * tokenow, gdy `attached[i]` powstalo ze SCALENIA rozlacznych dopasowan
   * (np. glowny blok pochodnych, tokeny 20-32, PLUS "Pancerz" we WLASNYM
   * akapicie, tokeny 70-72 — bounding `[20, 72)` polyka TEZ cala nieklaimowana
   * proze MIEDZY nimi). Kod, ktory potrzebuje "faktycznie skonsumowane
   * tokeny" (np. `proseBlock`'s wykluczenia, zeby notatka nie dublowala
   * pochodnych, ale TEZ nie przeskakiwala niezaklaimowanej prozy miedzy
   * scalonymi fragmentami) MUSI iterowac PO TEJ liscie (kazdy wpis WLASNY,
   * ciagly `[startIndex,endIndex)`), NIE po `attached[i]` bounding range.
   */
  subMatches: LabelledPairsMatch[][];
  /** Diagnostyka WYLACZNIE z pierwszej (najblizszej) rundy — jak w `attachNearestWithDiagnostics` (Studio). */
  nearestOutOfRange: (OutOfRangeCandidate | null)[];
}

/**
 * [KROK-34 Z1, zmierzony na zywo problem, "Wrak.pdf" str. 24, Sciapod] `Pancerz:`
 * bywa zapisany jako WLASNY, osobny akapit ("Pancerz: 5, niezwykle gruba
 * skóra...") daleko (inny wiersz, PONIZEJ atakow) od reszty bloku pochodnych
 * (PW/MO/Krzepa/Ruch/PM, w jednym wierszu WCZESNIEJ na stronie, zaraz po
 * siatce cech) — `matchLabelledPairs` zwraca to jako DWA ROZLACZNE
 * dopasowania TEGO SAMEGO wzorca (kazde samo w sobie spelnia `minPairs: 1`),
 * a zwykly `attachNearest` (bipartite, JEDEN kandydat na kotwice) przypisuje
 * kotwicy TYLKO blizsze z nich — drugie ("Pancerz") zostawalo CALKOWICIE
 * odrzucone, mimo ze na stronie byla dokladnie JEDNA encja, do ktorej mogl
 * nalezec (zmierzone wprost: `armour` nie pojawialo sie WCALE w
 * `CIFActor.statistics`, nie tylko okrojone). Generalizacja (DoD kroku 34:
 * "to samo dotyczy kazdej pochodnej z opisem, nie tylko pancerza") — KAZDY
 * wzorzec `labelledPairs` dolaczany do kotwicy MOZE zwrocic wiecej niz jedno
 * dopasowanie na strone.
 *
 * Dziala w rundach: pierwsza runda to DOKLADNIE `attachNearest` (ten sam
 * bezpieczny bipartite algorytm co reszta silnika) — na stronach z DOKLADNIE
 * jednym dopasowaniem na kotwice (wszystkie dotychczasowe profile
 * referencyjne) wynik jest IDENTYCZNY jak przed ta funkcja, zero regresji.
 * Dopasowania nieprzejete w pierwszej rundzie ("osierocone") proboja
 * dolaczyc sie w KOLEJNYCH rundach do NAJBLIZSZEJ WCIAZ dostepnej kotwicy —
 * TEN SAM bipartite algorytm, wiec dwie kotwice na stronie nigdy nie
 * licytuja sie o TEN SAM osierocony match (wygrywa blizsza), a kandydat poza
 * `maxDistancePt` KAZDEJ kotwicy zostaje odrzucony tak jak wczesniej (A10 —
 * brak dopasowania to nadal poprawny wynik, nie zgadywanie). Pary z kazdego
 * dodatkowego dopasowania sa DOKLADANE (union po `canonicalKey`, pierwsze
 * — najblizsze — dopasowanie wygrywa przy konflikcie) do wyniku pierwszej
 * rundy, nigdy go nie zastepuja.
 */
/**
 * [zgloszenie uzytkownika, powtorzony trzykrotnie na zywo, "Wrak.pdf", Sciapod]
 * Mnoznik zasiegu WYLACZNIE dla rund dolaczania OSIEROCONYCH dopasowan
 * (ponizej), NIE dla pierwszej/glownej rundy. Zmierzone wprost: prawdziwa
 * odleglosc do osieroconego "Pancerz:" Sciapoda to 410.85pt — autor profilu
 * (Profile Studio, wartosc domyslna nowej reguly dolaczenia) ustawia
 * `maxDistancePt` na 400pt, wiec dopasowanie odpadalo jako "poza zasiegiem"
 * (armour nigdy nie trafial na karte), MIMO ze na stronie jest dokladnie
 * jedna kotwica, do ktorej ten osierocony fragment mogl nalezec. Poprzednio
 * naprawiane recznie w SAMYM PROFILU (podniesienie `maxDistancePt` do 450) —
 * ale kazda przebudowa profilu w Profile Studio (nowa regula dolaczenia)
 * wraca do wartosci domyslnej 400, wiec ten sam blad wracal przy KAZDEJ
 * kolejnej edycji. Naprawa w SILNIKU zamiast w danych profilu: rundy
 * osierocone z natury lapia tresc CELOWO polozona daleko od glownego bloku
 * (osobny akapit), wiec zasluguja na wiekszy zasieg niz pierwsza runda —
 * bez ryzyka falszywych trafien pierwszej rundy (ktora NIE jest tym
 * mnoznikiem objeta), bo kandydat na ta runde i tak musi juz byc
 * "osierocony" (odrzucony przez WSZYSTKIE kotwice w pierwszej rundzie).
 */
const ORPHAN_ROUND_DISTANCE_MULTIPLIER = 1.5;

export function attachAndMergeLabelledPairs(
  anchors: readonly GeometricAnchor[],
  matches: readonly LabelledPairsMatch[],
  strategy: AttachStrategy,
  maxDistancePt: number,
): MergedLabelledPairsAttachment {
  const toCandidate = (m: LabelledPairsMatch): AttachCandidate => ({ bbox: m.bbox, tokenIndex: m.startIndex });
  const primaryDiag = attachNearestInternal(anchors, matches.map(toCandidate), strategy, maxDistancePt);

  const byAnchor: LabelledPairsMatch[][] = anchors.map(() => []);
  const usedMatchIndices = new Set<number>();
  primaryDiag.attached.forEach((cand, ai) => {
    if (!cand) return;
    const idx = matches.findIndex((m) => m.startIndex === cand.tokenIndex);
    byAnchor[ai]!.push(matches[idx]!);
    usedMatchIndices.add(idx);
  });

  const orphanRoundMaxDistancePt = maxDistancePt * ORPHAN_ROUND_DISTANCE_MULTIPLIER;
  let leftoverIndices = matches.map((_, idx) => idx).filter((idx) => !usedMatchIndices.has(idx));
  while (leftoverIndices.length > 0) {
    const roundCandidates = leftoverIndices.map((idx) => toCandidate(matches[idx]!));
    const roundDiag = attachNearestInternal(anchors, roundCandidates, strategy, orphanRoundMaxDistancePt);
    let attachedAny = false;
    roundDiag.attached.forEach((cand, ai) => {
      if (!cand) return;
      const idx = leftoverIndices.find((li) => matches[li]!.startIndex === cand.tokenIndex)!;
      byAnchor[ai]!.push(matches[idx]!);
      usedMatchIndices.add(idx);
      attachedAny = true;
    });
    if (!attachedAny) break;
    leftoverIndices = leftoverIndices.filter((idx) => !usedMatchIndices.has(idx));
  }

  const attached: (LabelledPairsMatch | null)[] = byAnchor.map((list) => {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0]!;
    const seenKeys = new Set(list[0]!.pairs.map((p) => p.canonicalKey));
    const pairs = [...list[0]!.pairs];
    for (const extra of list.slice(1)) {
      for (const p of extra.pairs) {
        if (seenKeys.has(p.canonicalKey)) continue;
        seenKeys.add(p.canonicalKey);
        pairs.push(p);
      }
    }
    const bbox = list.reduce<Rect | null>((acc, m) => (acc ? unionRect(acc, m.bbox) : m.bbox), null)!;
    return {
      pairs,
      startIndex: Math.min(...list.map((m) => m.startIndex)),
      endIndex: Math.max(...list.map((m) => m.endIndex)),
      bbox,
    };
  });

  return { attached, subMatches: byAnchor, nearestOutOfRange: primaryDiag.nearestOutOfRange };
}

export interface NameCandidate extends AttachCandidate {
  text: string;
}

export type NameResolution =
  | { kind: 'confident'; text: string; confidence: number; tokenIndex: number }
  | { kind: 'placeholder'; placeholder: string; candidates: readonly string[] };

export interface ResolveEntityNamesConfig {
  strategy: AttachStrategy;
  maxDistancePt: number;
  preferEarlierSibling?: PreferEarlierSiblingConfig;
  nameConfidenceThreshold: number;
  /** Wstawiane w miejsce `{page}`/`{ordinal}` w `namePlaceholder`. */
  page: number;
  namePlaceholder: string;
  /**
   * [ZGŁOSZENIE po kroku 30, "Dlaczego muszę wskazywać ręcznie, skoro profil
   * już to zawiera"] `tokenIndex`-y tokenow rozpoznanych przez WLASNY,
   * ODDZIELNY wzorzec zawodu/typu (`entityAssembly.typeLabelPattern`) —
   * NIEZALEZNIE od tego, czy autor zdazyl juz zawezic mu `requireFontKeys`.
   * Autor JUZ POWIEDZIAL profilowi "to jest zawod/typ, nie nazwa" samym
   * faktem wskazania osobnego wzorca — silnik nie powinien wiec ZNOWU pytac
   * czlowieka o rozstrzygniecie miedzy tymi dwoma polami (kara dwuznacznosci
   * ponizej), skoro odpowiedz juz jest w konfiguracji profilu. Bez tego:
   * dopoki `requireFontKeys` obu wzorcow nie sa jawnie rozne (autor jeszcze
   * nie klikal wystarczajaco), kandydat na zawod/typ nadal liczy sie jako
   * "prawie tak samo bliski konkurent" nazwy, wiec `resolveEntityNames`
   * fałszywie karze pewnosc i encja trafia do przegladu jako placeholder z
   * dwoma kandydatami do RECZNEGO rozstrzygniecia — mimo ze profil JUZ ma
   * wystarczajaca informacje, zeby to rozstrzygnac automatycznie.
   */
  knownSiblingTokenIndices?: ReadonlySet<number>;
}

/**
 * [S4] Ponizej `nameConfidenceThreshold` NIGDY nie zgaduj — placeholder +
 * lista kandydatow (posortowana po odleglosci) do rozstrzygniecia w
 * przegladzie. Pewnosc = f(odleglosc najlepszego kandydata WZGLEDEM progu) Z
 * KARA za dwuznacznosc (drugi kandydat prawie tak samo blisko jak pierwszy —
 * dokladnie przypadek H3 "50% trafnosci", gdzie dwa krotkie teksty w tym
 * samym kroju stoja blisko siebie). Formula NIEKALIBROWANA na prawdziwej
 * ksiazce — to zadanie Z7 (pomiar na calej ksiazce), tutaj jest jawnie
 * udokumentowana i testowalna, nie zaszyta bez wyjasnienia.
 */
const AMBIGUITY_RATIO_THRESHOLD = 1.5;
const AMBIGUITY_CONFIDENCE_PENALTY = 0.5;

export function resolveEntityNames(anchors: readonly GeometricAnchor[], nameCandidates: readonly NameCandidate[], config: ResolveEntityNamesConfig): NameResolution[] {
  const used = new Set<number>();
  const order = anchors.map((_, i) => i).sort((a, b) => anchors[a]!.anchorTokenIndex - anchors[b]!.anchorTokenIndex);
  const result: NameResolution[] = new Array(anchors.length).fill(null) as NameResolution[];

  for (const ai of order) {
    const anchor = anchors[ai]!;
    const best = pickBest(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt);
    const placeholder = config.namePlaceholder.replace('{page}', String(config.page)).replace('{ordinal}', String(ai + 1));

    if (!best) {
      result[ai] = { kind: 'placeholder', placeholder, candidates: [] };
      continue;
    }

    const chosen = config.preferEarlierSibling
      ? preferEarlierSibling(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt, best, config.preferEarlierSibling)
      : best;

    // Drugi najlepszy kandydat (poza wybranym) — sygnal dwuznacznosci. Gdy
    // `preferEarlierSibling` przelaczyl wybor z `best` (geometrycznie
    // najblizszy) na wczesniejszego sasiada (nazwa zamiast podtytulu),
    // `best` jest ZROZUMIALYM, oczekiwanym "konkurentem" (to WLASNIE podtytul,
    // ktory bylby najblizej) — NIE prawdziwa dwuznacznoscia. Wyklucz go z
    // liczenia dwuznacznosci, inaczej kazde poprawne zadzialanie reguly
    // "nazwa nad podtytulem" byloby mylnie karane jako niepewne.
    const ambiguityExclusions = new Set([...used, chosen.index]);
    if (chosen.index !== best.index) ambiguityExclusions.add(best.index);
    // [KROK-30] Symetryczny przypadek: `chosen` jest JUZ najblizszy (`best`),
    // wiec powyzsze wykluczenie nigdy sie nie uruchamia, mimo ze podtytul
    // dalej stoi na tej samej linii i dalej jest "oczekiwanym konkurentem",
    // nie prawdziwa dwuznacznoscia — patrz komentarz przy `findKnownSiblingIndex`.
    if (config.preferEarlierSibling) {
      const sibling = findKnownSiblingIndex(anchor.bbox, nameCandidates, used, config.strategy, config.maxDistancePt, chosen.index, config.preferEarlierSibling);
      if (sibling !== null) ambiguityExclusions.add(sibling);
    }
    // [ZGŁOSZENIE po kroku 30] Kandydat rozpoznany przez WLASNY wzorzec
    // zawodu/typu ma juz "niewinne wytlumaczenie" — profil sam go zaklasyfikowal
    // jako INNE pole, wiec nie liczy sie jako prawdziwa dwuznacznosc nazwy,
    // niezaleznie od geometrii/`preferEarlierSibling`.
    if (config.knownSiblingTokenIndices) {
      nameCandidates.forEach((c, i) => {
        if (config.knownSiblingTokenIndices!.has(c.tokenIndex)) ambiguityExclusions.add(i);
      });
    }
    const secondBest = pickBest(anchor.bbox, nameCandidates, ambiguityExclusions, config.strategy, config.maxDistancePt);

    let confidence = Math.max(0, 1 - chosen.distance / config.maxDistancePt);
    if (secondBest && secondBest.distance <= chosen.distance * AMBIGUITY_RATIO_THRESHOLD) {
      confidence *= AMBIGUITY_CONFIDENCE_PENALTY;
    }

    used.add(chosen.index);

    if (confidence < config.nameConfidenceThreshold) {
      const candidateTexts = [chosen, ...(secondBest ? [secondBest] : [])].map((c) => (nameCandidates[c.index] as NameCandidate).text);
      result[ai] = { kind: 'placeholder', placeholder, candidates: candidateTexts };
    } else {
      // [KROK-22, znaleziony przy budowie Profile Studio] `chosen.index` to indeks
      // WEWNATRZ tablicy `nameCandidates` (pozycja kandydata w argumencie tej
      // funkcji), NIE prawdziwy indeks tokenu w strumieniu — te dwie liczby myliy
      // sie tutaj do tej pory NIEZAUWAZONE, bo `NameResolution.tokenIndex` nie mial
      // zadnego konsumenta w produkcie (`buildCIFActor.ts` czyta wylacznie `.text`).
      // Profile Studio jest PIERWSZYM kodem, ktory faktycznie uzywa tego pola (do
      // narysowania nakladki nazwy nad wlasciwym tokenem) — bez tej poprawki
      // wskazywalby na losowy, przypadkowy token w strumieniu.
      const chosenCandidate = nameCandidates[chosen.index] as NameCandidate;
      result[ai] = { kind: 'confident', text: chosenCandidate.text, confidence, tokenIndex: chosenCandidate.tokenIndex };
    }
  }

  return result;
}
