import type { Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';

/**
 * Klasyfikacja tresc/dekoracja/maska (KROK-7 Z1, MDD faza 3 "Decyzja"). Wejscie:
 * `ImageEntry[]` z inwentaryzacji (krok 4, zero decode). Dzialaj WYLACZNIE na
 * faktach juz zebranych — nie decoduj tutaj (przebieg 2 to Z4, osobny krok).
 *
 * Sygnaly w kolejnosci sily z briefu, z JEDNYM udokumentowanym odstepstwem:
 * "rozmiar bezwzgledny" (krok 4 briefu) wymaga intrinsicWidth/Height, ktore
 * pdf.js ujawnia dopiero przy rozwiazywaniu obiektu (`page.objs.get()`/
 * `commonObjs.get()`) — operator list (inwentaryzacja) nie niesie tej
 * informacji, tylko bbox w przestrzeni urzadzenia (po CTM). Odrzucenie po
 * rozmiarze bezwzglednym jest wiec zastosowane PO decode, w `finalize.ts`
 * (Z5) — udokumentowane tam wprost, nie pominiete milczaco.
 */

export type ImageClassification = 'content' | 'decoration' | 'mask' | 'undecided';

export interface ClassifiedImage {
  entry: ImageEntry;
  classification: ImageClassification;
  /** Ktora regula zdecydowala — debugowalnosc, ten sam wzorzec co `matchedRuleId` w Z6 kroku 6. */
  reason: string;
  /**
   * [KROK-11 Z4] Pewnosc decyzji (0-1), WYPROWADZONA z sily sygnalu regulwy
   * ktora zdecydowala (`reason`) — NIE nowy, niezalezny model. Ekran
   * przegladu (faza 9, `packages/module`) uzywa jej do domyslnego
   * zaznaczenia: `content` z `confidence < 0.6` (jedyny taki przypadek:
   * `Z2-moderate-area-no-mask-evidence`, patrz komentarz przy tej regule —
   * "umiarkowana powierzchnia + zero dowodu" to NAJSLABSZY z sygnalow
   * pozytywnych) startuje odznaczone mimo klasyfikacji `content`, tak samo
   * jak `undecided`. Wartosci skalibrowane wprost na hierarchii sily
   * sygnalow juz udokumentowanej w naglowku tego pliku ("Sygnaly w
   * kolejnosci sily z briefu") — NIE osobny, nowy model.
   */
  confidence: number;
}

/**
 * [KROK-11 Z4] Mapowanie `reason` (identyfikator reguly z `classifyImages`)
 * na pewnosc (0-1) — patrz komentarz przy `ClassifiedImage.confidence`.
 * Twardy dowod (maska grupa/opcode, spad drukarski) = wysoka pewnosc;
 * `undecided` z definicji ponizej 0.5 (sprzeczne lub zerowe dowody);
 * `Z2-moderate-area-no-mask-evidence` to jedyny przypadek `content` PONIZEJ
 * progu 0.6 z Z4 — celowo, to najslabszy pozytywny sygnal w calym pliku.
 */
const CONFIDENCE_BY_REASON: Readonly<Record<string, number>> = {
  'Z1-mask-evidence-group': 0.95,
  'Z1-mask-evidence-opcode': 0.95,
  'Z1-full-bleed-background': 0.9,
  'Z1-large-relative-area': 0.9,
  'Z1-multi-page-correlated': 0.85,
  'Z2-strong-content-overrides-weak-geometry-evidence': 0.85,
  'Z9-high-body-text-coverage': 0.8,
  'Z2-moderate-area-no-mask-evidence': 0.5,
  'Z10-high-center-text-coverage': 0.35,
  // [KROK-15 Z3, A10] Wersje "miekkie" dwoch dawnych twardych regul — JEDEN
  // sygnal (powtarzalnosc albo spad drukarski) bez drugiego, niezaleznego
  // potwierdzenia. Ten sam poziom pewnosci co inne pojedyncze, sprzeczne
  // sygnaly (`Z1-conflicting-geometry-mask-vs-large-area`).
  'Z11-repeated-no-bleed-evidence': 0.4,
  'Z12-bleeding-no-center-text-evidence': 0.4,
  'Z1-conflicting-geometry-mask-vs-large-area': 0.4,
  'Z1-weak-geometry-mask-evidence': 0.3,
  'Z1-no-strong-signal': 0.2,
  // [KROK-43 Z1, naprawa "cicha utrata"] Pojedynczy sygnal proporcji SAM W
  // SOBIE — juz NIE hard `decoration` (patrz komentarz przy
  // `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`), tylko `undecided`. Ta sama
  // pewnosc co inne pojedyncze, niepotwierdzone-drugim-sygnalem przypadki
  // `undecided` ponizej (`Z12`/`Z1-conflicting`) — nie `Z1-no-strong-signal`
  // (0.2), bo proporcje SA realnym, tylko niepotwierdzonym sygnalem.
  'Z13-extreme-aspect-ratio-undecided': 0.4,
  // [zgloszenie uzytkownika, "Archiwa Imperium"] Dwa NIEZALEZNE sygnaly razem
  // (powtarzalnosc NA WIELU stronach + skrajne proporcje bboksa) — ta sama
  // pewnosc co `Z1-multi-page-correlated` (powtarzalnosc + spad drukarski),
  // bo to KONCEPCYJNIE ten sam wzorzec, tylko drugi sygnal jest inny.
  'Z14-repeated-extreme-aspect-ratio': 0.85,
};
/** Domyslna pewnosc dla nierozpoznanego `reason` (np. przyszla regula bez wpisu) — bezpieczny srodek, poniewaz `< 0.6` i tak trafia do przegladu. */
const DEFAULT_CONFIDENCE = 0.5;

export function confidenceForReason(reason: string): number {
  return CONFIDENCE_BY_REASON[reason] ?? DEFAULT_CONFIDENCE;
}

/**
 * Zasob obecny na >= tylu SKORELOWANYCH stronach (patrz `correlatedPageCount`)
 * jest KANDYDATEM na dekoracje (od kroku 15 — patrz A10 przy miejscu uzycia,
 * juz NIE twardym rozstrzygnieciem samym w sobie) — MDD: "ozdobnik na 40
 * stronach", ale bez korelacji pierwsze wystapienie kazdego takiego zasobu
 * wyglada jak unikalna tresc (U1).
 *
 * [KROK-15 Z3, kalibracja na zestawie referencyjnym z kroku 14 — 556 recznie
 * oznaczonych obrazow] Wartosc startowa z briefu/MDD (=2) zmierzona wprost:
 * `useful` z correlatedPages>=2: 22/133 (falszywie zlapane — mapa regionu
 * odwolywana w kilku rozdzialach, powtarzajacy sie symbol frakcji).
 * `decoration` z correlatedPages>=2: 21/200 (prawidlowo zlapane). Podniesienie
 * do >=5 daje 12/133 falszywych (-45%) kosztem tylko 19/200 prawdziwych
 * (-10%) — wyraznie lepszy bilans. Powyzej 5 dalszy zysk znikomy (>=10 daje
 * te same 12/133). `tools/analyze-correlation-threshold.ts` (jednorazowy
 * skrypt diagnostyczny, nie do utrzymania) ma pelne dane.
 */
const MULTI_PAGE_DECORATION_THRESHOLD = 5;

/**
 * Udzial powierzchni strony powyzej ktorego obraz jest kandydatem na tresc —
 * wartosc wprost z MDD §Faza 3 ("obraz zajmujacy > 40% strony to kandydat na
 * tresc"). Do weryfikacji w kalibracji.
 */
const LARGE_AREA_CONTENT_THRESHOLD = 0.4;

/**
 * Margines tolerancji (w jednostkach bbox/MediaBox, zwykle pt) przy sprawdzaniu
 * czy bbox "wychodzi" poza MediaBox — male, nieuniknione zaokraglenia CTM nie
 * powinny falszywie oznaczac obrazu jako spadu drukarskiego. Male w porownaniu
 * do typowego spadu drukarskiego (zwykle >=9pt/3mm).
 */
const BLEED_TOLERANCE_PT = 1;

/**
 * [KROK-8 Z2] Dlugosc dluzszej krawedzi bboksa (w pt strony, NIE w pikselach
 * zrodlowych — to jest dostepne juz na etapie inwentaryzacji, bez decode'u,
 * w odroznieniu od `MIN_ABSOLUTE_PX` w `finalize.ts`) powyzej ktorej obraz
 * uznajemy za "obiektywnie duzy", niezaleznie od udzialu procentowego strony.
 * Odroznia pelnostronicowa ilustracje (typowo 400-700pt na dluzszej krawedzi
 * dla stron Letter/A4) od malej ikony, ktora przypadkiem trafila na mala
 * strone. Wartosc do kalibracji na `samples/` — startowa, wyraznie ponizej
 * typowej ilustracji, zeby nie odrzucac prawdziwej tresci.
 */
const LARGE_ABSOLUTE_SIZE_PT = 300;

/**
 * [KROK-8 Z2, odkrycie] Kontrola reczna kroku 7 zidentyfikowala rzeczywista
 * tresc (reklamy/ilustracje w swiecie gry z CP-RED) sklasyfikowana `undecided`
 * z powodem `Z1-no-strong-signal` — NIE `geometry` (empirycznie zweryfikowane:
 * przeszukanie WSZYSTKICH 9 plikow z `samples/` nie znalazlo ANI JEDNEGO wpisu
 * `undecided` z `maskEvidence==='geometry'` — diagnoza briefu KROK-8 o
 * "slabej przeslance geometry" jako przyczynie nie potwierdza sie na tych
 * danych). Prawdziwa przyczyna: `maxRelativeArea` ponizej `LARGE_AREA_CONTENT_THRESHOLD`
 * (0,4) przy KOMPLETNYM BRAKU jakiegokolwiek dowodu (nie tylko slabego) w
 * ZADNA strone. Brak dowodu ≠ dowod przeciwny — obraz o umiarkowanej (nie
 * ogromnej) powierzchni i zerowej przeslance maskowania to WCIAZ silniejszy
 * sygnal tresci niz brak jakiejkolwiek informacji. Prog skalibrowany wprost na
 * dwoch zidentyfikowanych w kroku 7 przypadkach (`img_p64_1`: 25,7% strony,
 * `img_p9_3`: 11,6% strony — oba prawdziwa tresc) I na dwoch przypadkach,
 * ktore CELOWO zostaja `undecided` (`img_p18_1`/`img_p26_1`: 2,6% strony,
 * genuinie male na stronie mimo renderu w duzej rozdzielczosci docelowej —
 * male dekoracyjne/portretowe elementy nie powinny automatycznie stac sie
 * `content` tylko dlatego, ze SA maskowane/klastrowane).
 */
const MEDIUM_AREA_NO_EVIDENCE_THRESHOLD = 0.1;

/**
 * [KROK-17, zgloszony na zywo blad; KROK-43 Z1, naprawa po audycie stalych —
 * A10 "cicha utrata"] Stosunek dluzszej do krotszej krawedzi bboksa, powyzej
 * ktorego obraz jest PODEJRZANY o bycie waskim paskiem-rozdzielaczem sekcji
 * (linia z motywem graficznym pod naglowkiem/ramka) — zaobserwowane wprost na
 * `CHA23131 Call of Cthulhu 7th Edition Quick-Start Rules.pdf`, str. 7: trzy
 * warianty tego samego motywu macek (962x84px ~11,5:1, 962x86px ~11,3:1,
 * 478x79px ~6,1:1).
 *
 * [KROK-43, audyt Z2 zgloszenia] TA STALA SAMA W SOBIE nigdy nie byla
 * kalibrowana wprost na przypadkach negatywnych (panoramiczna mapa 3000x500,
 * pionowa ilustracja na cala kolumne — oba typowe w podrecznikach RPG, oba
 * majaby proporcje POWYZEJ progu=6). Gdy ten JEDYNY sygnal (`Z13`, ponizej)
 * decydowal wprost o `decoration`, blad progu byl NIEODWRACALNY: obraz byl
 * kasowany Z POMINIECIEM ekranu przegladu (naruszenie A5 — czlowiek nigdy go
 * nie widzial — i A10, ktore juz raz naprawilo dokladnie ten sam wzorzec przy
 * `MULTI_PAGE_DECORATION_THRESHOLD` w krokach 14-15, ale nie zostalo tu
 * zastosowane). Naprawa NIE wymaga kalibrowania samej stalej — usuwa
 * KONSEKWENCJE bledu progu: `Z13` (pojedyncze wystapienie, TEN sygnal SAM)
 * ladowanie teraz w `undecided` (widoczne w przegladzie, z `Diagnostic`
 * `IMAGE_EXTREME_ASPECT_RATIO_UNDECIDED` w `buildImageExtraction.ts`), nie w
 * `decoration`. `Z14` (ponizej, `correlatedPages>=5` RAZEM z proporcjami)
 * zostaje TWARDYM `decoration` — DWA niezalezne sygnaly zbiegajace sie razem
 * (powtarzalnosc na wielu stronach + proporcje) to inny, silniejszy przypadek
 * niz JEDEN sygnal sam w sobie, ten sam wzorzec co `Z1-multi-page-correlated`
 * (powtarzalnosc + spad drukarski) tuz obok — realna tresc niemal nigdy nie
 * ma OBU tych cech naraz, wiec regresja z "Archiwa Imperium" (dekoracyjne
 * paski powtorzone na 6-23 stronach) pozostaje odsiana jako `decoration`
 * WLASNIE przez `Z14`, mimo zmiany `Z13`.
 */
export const EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD = 6;

/**
 * [KROK-9 Z2] Udzial bboksa obrazu pokryty PLYNACYM TEKSTEM NARRACYJNYM z
 * potoku tekstu (`semantic/blockBuilder.ts`) powyzej ktorego obraz jest
 * tlem/dekoracja, nie trescia — sygnal ORTOGONALNY do statystyki pikseli
 * (KROK-8 pozostawil nierozwiazany `img_p14_5`, teksturowane tlo pergaminowe
 * nieodrozniale przez stddev luminancji/chrome/gradient). Realna ilustracja ma
 * pod soba co najwyzej podpis (waski pasek), tlo ma na sobie CALE akapity.
 *
 * [odkrycie, kalibracja na `samples/`] Brief mowi wprost o blokach `body`, ale
 * `img_p14_5` (docelowy przypadek) ma na sobie tekst zaklasyfikowany jako
 * `caption`, nie `body` — to ten sam akapit flavor-textu z ozdobnym
 * dekoracyjnym fontem, ktory regula Z9-caption-near-image (Z1a, ten sam krok)
 * poprawnie zlapala jako `caption` (blisko obrazu), NIE jako blad. Prawdziwe
 * body-tekst-na-obrazie i caption-tekst-na-obrazie to STRUKTURALNIE ten sam
 * sygnal ("tu jest realny plynacy tekst, nie tylko podpis pod obrazem") —
 * dlatego wywolujacy przekazuje bboxy blokow `body` ORAZ `caption` razem
 * (patrz `extractImagesFromDocument.ts`), nie tylko `body`. `sidebar`/`heading`/
 * `table`/`marginalia` swiadomie WYLACZONE: sa albo zbyt krotkie, zeby
 * kiedykolwiek dac wysokie pokrycie, albo (sidebar) legalnie wystepuja WEWNATRZ
 * ramek z prawdziwymi ilustracjami bez oznaczania ich jako tlo.
 *
 * [odkrycie, kontrola reczna wizualna] Prawdziwa ilustracja (portret orka,
 * `Wrath_&_Glory` str. 16) w ukladzie "tekst oplywa ilustracje w tej samej
 * kolumnie" dala DOKLADNIE tak wysokie pokrycie bboksem (~77%) jak faktyczne
 * tlo (`img_p10_1`, ~72%) — sam bbox NIE ROZROZNIA "tekst NAD obrazem" od
 * "tekst W TEJ SAMEJ kolumnie co obraz o hojnym/przezroczystym marginesie
 * bboksa" bez dekodowania pikseli (poza architektura tego pliku — zero decode,
 * patrz naglowek). Zabezpieczenie: sygnal NIE dziala dla obrazow z DUZYM
 * rozmiarem bezwzglednym (`hasLargeAbsoluteOccurrence`, ten sam prog co
 * `Z2-strong-content-overrides-weak-geometry-evidence` powyzej) — prawdziwe
 * ilustracje-portrety sa z reguly duze, teksturowane tla-karty tez bywaja
 * duze, ale skoro nie da sie ich odroznic bezpiecznie, priorytet ma NIE
 * degradowanie prawdziwej tresci (MDD A5 — czlowiek i tak przejrzy w fazie 9).
 * Kosztem: kilka faktycznych teł >=300pt (np. `img_p10_1`) zostaje `content`
 * — TA SAMA (nie nowa) luka co KROK-8, nie regresja.
 */
const TEXT_COVERAGE_DECORATION_THRESHOLD = 0.15;

/**
 * Grupuje wpisy po KANONICZNYM objId (wlasny objId, chyba ze `correlatedWith`
 * wskazuje inny — patrz `correlateImagesByBBox` w kroku 5/6) i zwraca dla
 * kazdego wpisu LICZBE UNIKALNYCH STRON calej grupy korelacyjnej — to jest
 * wlasciwy sygnal do klasyfikacji "wielostronicowy ozdobnik" (U1), nie samo
 * `entry.pageRefs.length`, ktore po rozbiciu objId widzi tylko fragment.
 */
function computeCorrelatedPageCounts(entries: readonly ImageEntry[]): Map<ImageEntry, number> {
  const canonicalKey = (e: ImageEntry): string => e.correlatedWith ?? e.objId ?? '';
  const pagesByCanonical = new Map<string, Set<number>>();
  for (const e of entries) {
    if (e.objId === null) continue; // wpisy inline nie maja objId do korelacji — traktowane osobno, patrz ponizej
    const key = canonicalKey(e);
    const pages = pagesByCanonical.get(key) ?? new Set<number>();
    for (const p of e.pageRefs) pages.add(p);
    pagesByCanonical.set(key, pages);
  }
  const result = new Map<ImageEntry, number>();
  for (const e of entries) {
    if (e.objId === null) {
      result.set(e, e.pageRefs.length);
      continue;
    }
    result.set(e, pagesByCanonical.get(canonicalKey(e))?.size ?? e.pageRefs.length);
  }
  return result;
}

/** Czy KTOREKOLWIEK wystapienie wychodzi poza MediaBox swojej strony — sygnal spadu drukarskiego/tla (F0). */
function hasBleedingOccurrence(entry: ImageEntry, pageBoxByPage: ReadonlyMap<number, Rect>): boolean {
  return entry.occurrences.some((occ) => {
    const pageBox = pageBoxByPage.get(occ.page);
    if (!pageBox) return false;
    return (
      occ.bbox.minX < pageBox.minX - BLEED_TOLERANCE_PT ||
      occ.bbox.minY < pageBox.minY - BLEED_TOLERANCE_PT ||
      occ.bbox.maxX > pageBox.maxX + BLEED_TOLERANCE_PT ||
      occ.bbox.maxY > pageBox.maxY + BLEED_TOLERANCE_PT
    );
  });
}

/** Czy KTOREKOLWIEK wystapienie ma dluzsza krawedz bboksa >= progu — patrz `LARGE_ABSOLUTE_SIZE_PT`. */
function hasLargeAbsoluteOccurrence(entry: ImageEntry): boolean {
  return entry.occurrences.some((occ) => Math.max(occ.bbox.maxX - occ.bbox.minX, occ.bbox.maxY - occ.bbox.minY) >= LARGE_ABSOLUTE_SIZE_PT);
}

/** Czy KTOREKOLWIEK wystapienie ma proporcje bboksa >= progu — patrz `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`. */
function hasExtremeAspectRatioOccurrence(entry: ImageEntry): boolean {
  return entry.occurrences.some((occ) => {
    const w = occ.bbox.maxX - occ.bbox.minX;
    const h = occ.bbox.maxY - occ.bbox.minY;
    if (w <= 0 || h <= 0) return false;
    return Math.max(w, h) / Math.min(w, h) >= EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD;
  });
}

/**
 * [KROK-9 Z2] Udzial powierzchni `bbox` pokryty suma (bez odejmowania nakladania
 * MIEDZY blokami — bloki `body` na tej samej stronie praktycznie nigdy sie nie
 * nakladaja, wiec to bezpieczne przyblizenie, nie prawdziwa unia geometryczna)
 * przeciec z blokami `body` TEJ SAMEJ strony. Zero blokow na stronie = 0.
 */
function computeTextCoverageRatio(bbox: Rect, page: number, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  const boxes = bodyBoxesByPage.get(page);
  if (!boxes || boxes.length === 0) return 0;
  const area = Math.max(0, bbox.maxX - bbox.minX) * Math.max(0, bbox.maxY - bbox.minY);
  if (area <= 0) return 0;
  let covered = 0;
  for (const b of boxes) {
    const ix = Math.max(0, Math.min(bbox.maxX, b.maxX) - Math.max(bbox.minX, b.minX));
    const iy = Math.max(0, Math.min(bbox.maxY, b.maxY) - Math.max(bbox.minY, b.minY));
    covered += ix * iy;
  }
  return Math.min(1, covered / area);
}

/** Maksimum pokrycia tekstem PO WSZYSTKICH wystapieniach — ten sam wzorzec "any occurrence" co `hasBleedingOccurrence`/`hasLargeAbsoluteOccurrence`. */
function maxTextCoverageRatio(entry: ImageEntry, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  let max = 0;
  for (const occ of entry.occurrences) {
    const ratio = computeTextCoverageRatio(occ.bbox, occ.page, bodyBoxesByPage);
    if (ratio > max) max = ratio;
  }
  return max;
}

/**
 * [KROK-14 H1] Zweza bbox do centralnych ok. 50% powierzchni (skala liniowa
 * 1/sqrt(2) wokol srodka) — patrz `maxCenterTextCoverageRatio`.
 */
function shrinkToCenter(bbox: Rect): Rect {
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const shrink = (1 - Math.SQRT1_2) / 2;
  return {
    minX: bbox.minX + w * shrink,
    maxX: bbox.maxX - w * shrink,
    minY: bbox.minY + h * shrink,
    maxY: bbox.maxY - h * shrink,
  };
}

/**
 * [KROK-14 H1] Pokrycie tekstem `body`/`caption` liczone WYLACZNIE dla
 * centralnych ~50% powierzchni bboksa, nie calego bboksa jak
 * `maxTextCoverageRatio`. Rozwiazuje luke odkryta w KROK-9 (patrz komentarz
 * przy `TEXT_COVERAGE_DECORATION_THRESHOLD`): prawdziwe tlo z akapitem NA
 * SRODKU i prawdziwa ilustracja oplywana tekstem PRZY KRAWEDZI daja PRAWIE
 * IDENTYCZNE pokrycie CALEGO bboksa (~72-77% w obu przypadkach, zmierzone
 * recznie w KROK-9) — te dwa przypadki rozroznia ROZKLAD PRZESTRZENNY, nie
 * ilosc: tlo ma tekst POSRODKU, ilustracja ma srodek CZYSTY.
 *
 * Zmierzone na zestawie referencyjnym (600 recznie oznaczonych obrazow z 3
 * podrecznikow, nie w tym repo): podniosło precyzje klasyfikacji `content`
 * z 36% do 95% na tej probce.
 */
function maxCenterTextCoverageRatio(entry: ImageEntry, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  let max = 0;
  for (const occ of entry.occurrences) {
    const ratio = computeTextCoverageRatio(shrinkToCenter(occ.bbox), occ.page, bodyBoxesByPage);
    if (ratio > max) max = ratio;
  }
  return max;
}

/**
 * Klasyfikuje wszystkie wpisy rejestru obrazow. `'undecided'` jest DOZWOLONY i
 * POZADANY przy sprzecznych sygnalach (brief) — ekran przegladu (faza 9) pokaze
 * je uzytkownikowi domyslnie odznaczone, zamiast zgadywac za niego.
 */
export function classifyImages(
  entries: readonly ImageEntry[],
  pageBoxByPage: ReadonlyMap<number, Rect>,
  // [KROK-9 Z2] Bboxy blokow plynacego tekstu (`body`+`caption`, patrz komentarz
  // przy `TEXT_COVERAGE_DECORATION_THRESHOLD`) grupowane po numerze strony —
  // POLACZENIE JAWNE (parametr), nie przez stan globalny, zgodnie z briefem
  // KROK-9. Domyslnie pusta mapa: wywolujacy bez potoku tekstu (np. istniejace
  // testy jednostkowe) dostaja dokladnie zachowanie sprzed Z2.
  bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]> = new Map(),
  // [na zyczenie uzytkownika, ksiazka z bespoke tlem na kazdej stronie] Patrz
  // komentarz przy `treatFullBleedAsContent` w `schema.ts`. Domyslnie `{}`
  // (wylaczone) — zachowanie identyczne jak przed dodaniem tej flagi.
  options: { treatFullBleedAsContent?: boolean } = {},
): ClassifiedImage[] {
  const treatFullBleedAsContent = options.treatFullBleedAsContent ?? false;
  const correlatedPageCounts = computeCorrelatedPageCounts(entries);

  return entries.map((entry): ClassifiedImage => {
    // 1. Twardy dowod maski — koniec decyzji, niezaleznie od czegokolwiek innego.
    if (entry.maskEvidence === 'group' || entry.maskEvidence === 'opcode') {
      return { entry, classification: 'mask', reason: `Z1-mask-evidence-${entry.maskEvidence}`, confidence: confidenceForReason(`Z1-mask-evidence-${entry.maskEvidence}`) };
    }

    // [KROK-15 Z3, A10] Obliczone WCZESNIE, bo teraz uzywane przez DWIE
    // niezalezne reguly ponizej (wielostronicowa korelacja I spad drukarski),
    // nie tylko przez pozniejszy sygnal H1 (Z10). Ten sam wzorzec co
    // `maxCenterTextCoverageRatio` z kroku 14 — patrz jej wlasny komentarz.
    const centerTextCoverage = maxCenterTextCoverageRatio(entry, bodyBoxesByPage);

    // 2. Liczba stron PO korelacji (U1) — wielostronicowy zasob to KANDYDAT na
    // dekoracje, ale JUZ NIE twardo. [KROK-15 Z3, odkrycie na zestawie
    // referencyjnym kroku 14] Prog=2 zaklasyfikowal falszywie 22/133 `useful`
    // (mapa regionu odwolywana w kilku rozdzialach, powtarzajacy sie symbol
    // frakcji) — realny rozklad pokazal, ze podniesienie do 5 obnizyloby to do
    // 12/133, tracac tylko 2/21 prawidlowo zlapanych `decoration` (z 21 do 19).
    // Zgodnie z A10: powyzej progu to JUZ NIE `decoration` wprost, tylko
    // `undecided`, CHYBA ZE towarzyszy DRUGI, niezalezny sygnal — spad
    // drukarski (`hasBleedingOccurrence`). Prawdziwa mapa/symbol odwolywany
    // wielokrotnie prawie NIGDY nie wychodzi poza MediaBox (celowo
    // umieszczona ilustracja, nie tlo strony) — dwa zgodne sygnaly razem
    // dajа taka sama pewnosc jak dawna twarda regula.
    const correlatedPages = correlatedPageCounts.get(entry) ?? entry.pageRefs.length;
    if (correlatedPages >= MULTI_PAGE_DECORATION_THRESHOLD) {
      if (hasBleedingOccurrence(entry, pageBoxByPage)) {
        return { entry, classification: 'decoration', reason: 'Z1-multi-page-correlated', confidence: confidenceForReason('Z1-multi-page-correlated') };
      }
      // [zgloszenie uzytkownika, "Archiwa Imperium", waskie paski-rozdzielacze
      // powtorzone na 6-23 stronach] DRUGI niezalezny sygnal rownowazny
      // spadowi drukarskiemu powyzej — proporcje bboksa (`Z13-extreme-aspect-ratio-divider`
      // nizej w tej funkcji uzywa TEJ SAMEJ `hasExtremeAspectRatioOccurrence`,
      // ale jest sprawdzana DOPIERO PO tym bloku, wiec nigdy nie dostawala
      // szansy dla wpisow, ktore najpierw trafialy tutaj). Zmierzone wprost:
      // dekoracyjny pasek-rozdzielacz uzyty w calej ksiazce (kazde uzycie
      // to <1% powierzchni strony, BEZ spadu drukarskiego — lezy W SRODKU
      // strony, nie na jej krawedzi) trafial w `undecided` na KAZDYM z 6-23
      // wystapien, mimo skrajnie wydluzonych proporcji (>16:1) — sygnal rownie
      // jednoznaczny jak spad, tylko nigdy nie sprawdzany w tym miejscu.
      // Prawdziwa, powtarzana TRESC (np. mapa regionu, symbol frakcji z
      // KROK-15 Z3) niemal nigdy nie ma takich proporcji, wiec to bezpieczne
      // rozszerzenie — nie zawezy pelnosci `content`/`undecided` dla realnej
      // tresci, tylko zamyka luke dla tego jednego, wąskiego ksztaltu.
      if (hasExtremeAspectRatioOccurrence(entry)) {
        return { entry, classification: 'decoration', reason: 'Z14-repeated-extreme-aspect-ratio', confidence: confidenceForReason('Z14-repeated-extreme-aspect-ratio') };
      }
      return { entry, classification: 'undecided', reason: 'Z11-repeated-no-bleed-evidence', confidence: confidenceForReason('Z11-repeated-no-bleed-evidence') };
    }

    // 6. Pozycja pelnospadowa — sprawdzona wczesnie (twardy sygnal geometryczny,
    // niezalezny od niepewnosci sygnalow 3-5), zanim jakikolwiek "duzy bbox"
    // zostanie mylnie policzony jako tresc. [KROK-15 Z3, A10] Rowniez JUZ NIE
    // twardo — krok 14 policzyl, ze 25/49 utraconych `useful` w probce
    // referencyjnej ginelo WLASNIE tutaj (pelnostronicowa mapa/ilustracja
    // rozkladowkowa legalnie wychodzi poza spad tak samo jak teksturowane
    // tlo). Drugi, niezalezny sygnal: pokrycie tekstem NA SRODKU (ten sam
    // `centerTextCoverage` co Z10 nizej) — prawdziwe tlo ma akapit na sobie,
    // celowa ilustracja pod pelny spad zwykle nie.
    if (hasBleedingOccurrence(entry, pageBoxByPage)) {
      if (centerTextCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD) {
        // [na zyczenie uzytkownika] `treatFullBleedAsContent` omija zalozenie
        // "pelny spad + tekst na wierzchu = powtarzalne tlo" dokladnie tutaj —
        // patrz komentarz przy fladze w `schema.ts`. Publikacje z bespoke
        // ilustracja pod kazda strona trafiaja WLASNIE w ta galaz.
        if (treatFullBleedAsContent) {
          return { entry, classification: 'content', reason: 'Z1-full-bleed-forced-content', confidence: confidenceForReason('Z1-full-bleed-background') };
        }
        return { entry, classification: 'decoration', reason: 'Z1-full-bleed-background', confidence: confidenceForReason('Z1-full-bleed-background') };
      }
      return { entry, classification: 'undecided', reason: 'Z12-bleeding-no-center-text-evidence', confidence: confidenceForReason('Z12-bleeding-no-center-text-evidence') };
    }

    // 3. Duza powierzchnia strony — kandydat na tresc.
    const isLargeArea = entry.maxRelativeArea >= LARGE_AREA_CONTENT_THRESHOLD;

    // 5. maskEvidence==='geometry' — slaby dowod, sam z siebie NIGDY nie przesadza.
    //
    // [KROK-8 Z2, odkrycie] Kontrola reczna kroku 7 (RAPORT-KROK-7.md) ujawnila
    // pelnostronicowe ilustracje sklasyfikowane `undecided` mimo bycia
    // "genuinie dobra trescia" — slaby dowod `geometry` (czesto fikcyjny:
    // obraz narysowany tuz PRZED/PO innym o podobnym bboksie, bez zadnego
    // faktycznego maskowania) przygniatal silne, zgodne ze soba sygnaly tresci.
    // Regula nadrzedna: koniunkcja DUZEJ powierzchni WZGLEDNEJ, POJEDYNCZEGO
    // wystapienia po korelacji (juz zagwarantowane — inaczej zwrocilibysmy
    // 'decoration' wyzej) i DUZEGO rozmiaru BEZWZGLEDNEGO przebija slaby dowod
    // geometryczny -> `content`. `group`/`opcode` (twardy dowod, sprawdzony na
    // samej gorze funkcji) NIGDY nie podlegaja tej regule.
    if (entry.maskEvidence === 'geometry') {
      if (isLargeArea && hasLargeAbsoluteOccurrence(entry)) {
        return { entry, classification: 'content', reason: 'Z2-strong-content-overrides-weak-geometry-evidence', confidence: confidenceForReason('Z2-strong-content-overrides-weak-geometry-evidence') };
      }
      if (isLargeArea) {
        return { entry, classification: 'undecided', reason: 'Z1-conflicting-geometry-mask-vs-large-area', confidence: confidenceForReason('Z1-conflicting-geometry-mask-vs-large-area') };
      }
      return { entry, classification: 'undecided', reason: 'Z1-weak-geometry-mask-evidence', confidence: confidenceForReason('Z1-weak-geometry-mask-evidence') };
    }

    // [KROK-9 Z2] Pokrycie tekstem `body` — sprawdzone PO nuansowej obsludze
    // `geometry` powyzej (nie zmienia jej), ale PRZED regulami "duza
    // powierzchnia -> tresc": teksturowane tlo z akapitami na sobie ma czesto
    // TEZ duza powierzchnie wzgledna, a to WLASNIE przypadek, ktory ten sygnal
    // ma zlapac (patrz komentarz przy `TEXT_COVERAGE_DECORATION_THRESHOLD`).
    const textCoverage = maxTextCoverageRatio(entry, bodyBoxesByPage);
    if (textCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD && !hasLargeAbsoluteOccurrence(entry)) {
      return { entry, classification: 'decoration', reason: 'Z9-high-body-text-coverage', confidence: confidenceForReason('Z9-high-body-text-coverage') };
    }

    // [KROK-14 H1] Sygnal Z9 powyzej jest WYLACZONY dla duzych obrazow
    // (`hasLargeAbsoluteOccurrence`) od kroku 9 wlasnie z powodu opisanego przy
    // `maxCenterTextCoverageRatio`. Tutaj wraca — ale liczony na SRODKU, nie na
    // calym bboksie, wiec nie cierpi na ten sam problem, i laduje w `undecided`
    // (NIE `decoration`): zmierzone na tym samym zestawie referencyjnym, ze
    // ladowanie bezposrednio w `decoration` zmniejszalo "osiagalna" pelnosc
    // (content+undecided, czyli cokolwiek widoczne w ekranie przegladu) z 63%
    // do 45% — czesc prawdziwie przydatnych obrazow stawala sie CALKOWICIE
    // niewidoczna zamiast wymagac jednego kliknięcia w `undecided`. [KROK-15
    // Z3] `centerTextCoverage` juz policzone wyzej — Z1-multi-page-correlated
    // i Z1-full-bleed-background teraz tez z niego korzystaja.
    if (centerTextCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD) {
      return { entry, classification: 'undecided', reason: 'Z10-high-center-text-coverage', confidence: confidenceForReason('Z10-high-center-text-coverage') };
    }

    if (isLargeArea) {
      return { entry, classification: 'content', reason: 'Z1-large-relative-area', confidence: confidenceForReason('Z1-large-relative-area') };
    }

    // [KROK-8 Z2] Zero dowodu maskowania (nie tylko slabego) + umiarkowana
    // powierzchnia — patrz komentarz przy `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD`.
    if (entry.maskEvidence === null && entry.maxRelativeArea >= MEDIUM_AREA_NO_EVIDENCE_THRESHOLD) {
      return { entry, classification: 'content', reason: 'Z2-moderate-area-no-mask-evidence', confidence: confidenceForReason('Z2-moderate-area-no-mask-evidence') };
    }

    // [KROK-17, naprawione w KROK-43 Z1 — patrz komentarz przy
    // `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`] Waski pasek-rozdzielacz —
    // JEDEN sygnal (proporcje) SAM W SOBIE juz NIE decyduje `decoration`
    // wprost (A5/A10: obraz musi przejsc przez ekran przegladu, gdzie
    // uzytkownik go zobaczy i zdecyduje) — laduje w `undecided`, z
    // `Diagnostic` dodawanym w `buildImageExtraction.ts`. Sprawdzone PO
    // wszystkich regulach "duza powierzchnia -> tresc" (nie nadpisuje ich),
    // ale PRZED finalnym `undecided`/`Z1-no-strong-signal` — inaczej ten
    // przypadek dostalby najnizsza mozliwa pewnosc, mimo ze proporcje SA
    // realnym (tylko niepotwierdzonym) sygnalem.
    if (!isLargeArea && hasExtremeAspectRatioOccurrence(entry)) {
      return { entry, classification: 'undecided', reason: 'Z13-extreme-aspect-ratio-undecided', confidence: confidenceForReason('Z13-extreme-aspect-ratio-undecided') };
    }

    // Brak jakiegokolwiek mocnego sygnalu w zadna strone — nie zgaduj.
    return { entry, classification: 'undecided', reason: 'Z1-no-strong-signal', confidence: confidenceForReason('Z1-no-strong-signal') };
  });
}
