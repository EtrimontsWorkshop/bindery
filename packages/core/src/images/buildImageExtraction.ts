import { clusterByOverlap } from '../clustering.js';
import { overlapRatio, rectArea, rectIntersection, relativeArea, unionRect, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion } from '../inventory/vectorRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { classifyImages, confidenceForReason, EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, type ClassifiedImage, type ImageClassification } from './classify.js';
import { AUTOCROP_BRIGHTEN, brightenCroppedImage } from './brightenImage.js';
import { cropDecodedImage, detectContentBounds } from './cropUniformMargins.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder, OutputFormat } from './encodeImage.js';
import { extractDirect, probeIntrinsicLongEdgePx, type PdfPageForExtract } from './extract.js';
import { computeContentHash, computeLuminanceStdDev, finalizeImages, type FinalizedImage, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import { computeTargetLongEdgePx } from './renderResolution.js';
import { computeMaskedObjIds, decideExtractionStrategy } from './strategy.js';

/**
 * Orkiestracja fazy 3 (KROK-7): klasyfikacja (Z1) -> strategia (Z2) ->
 * ekstrakcja (Z4, render regionu Z3 gdy trzeba) -> finalizacja (Z5), z
 * dyscyplina pamieci i determinizmu (Z6). Mirror wzorca `buildPageLayout.ts`
 * z kroku 6: jeden entry point spinajacy wszystkie Z-zadania w jeden przebieg
 * per dokument.
 */

export interface InventoryForImages {
  images: readonly ImageEntry[];
  vectors: readonly VectorRegion[];
  perPage: readonly { pageNumber: number; box: Rect; rotation: number }[];
}

export interface PdfDocumentLikeForImages {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForExtract & { cleanup(): void }>;
}

export interface BuildImageExtractionOptions {
  /**
   * [KROK-8 Z3] Uzywane JAKO PUNKT WYJSCIA, NIE jako jedyna rozdzielczosc renderu
   * regionu — patrz `renderResolution.ts`. Nadal jedyna rozdzielczosc dla
   * regionow czysto wektorowych (brak obrazu, "wartosc z ustawien" z briefu).
   */
  targetLongEdgePx?: number;
  /** Twardy sufit rozdzielczosci renderu regionu (KROK-8 Z3) — chroni przed absurdalnym rozmiarem pliku z rozkladowki o bardzo wysokiej natywnej rozdzielczosci zasobow. */
  maxLongEdgePx?: number;
  outputFormat?: OutputFormat;
  outputQuality?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** `objId` obrazow sasiadujacych z blokiem `statblock`/`heading` (krok 6) — sygnal `portrait` w Z5. */
  nearStatblockOrHeadingObjIds?: ReadonlySet<string>;
  /** [KROK-9 Z2] Bboksy blokow `body` (potok tekstu) per strona — patrz `classify.ts`. Polaczenie potoku tekstu z potokiem obrazow, JAWNE przez ten parametr. */
  bodyBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /** [na zyczenie uzytkownika] Patrz komentarz przy `treatFullBleedAsContent` w `schema.ts` — omija `Z1-full-bleed-background`/`Z9-high-body-text-coverage` dla obrazow pod pelnym spadem. Domyslnie wylaczone. */
  treatFullBleedAsContent?: boolean;
  /** [na zyczenie uzytkownika, EKSPERYMENTALNE] Patrz komentarz przy `autoCropUniformMargins` w `schema.ts` i `cropUniformMargins.ts`. Bez znaczenia, gdy `treatFullBleedAsContent` jest wylaczone. Domyslnie wylaczone. */
  autoCropUniformMargins?: boolean;
  /** [na zyczenie uzytkownika] Patrz komentarz przy `brightenAutoCroppedImages` w `schema.ts` i `brightenImage.ts`. Bez znaczenia, gdy dany obraz nie zostal faktycznie przyciety przez `autoCropUniformMargins`. Domyslnie wylaczone. */
  brightenAutoCroppedImages?: boolean;
}

export interface BuildImageExtractionResult {
  images: FinalizedImage<EncodedImage>[];
  correlationClosedByBBox: number;
  correlationClosedByHash: number;
  duplicatesRemoved: number;
  diagnostics: Diagnostic[];
}

/** Rozsadny domyslny cel dla scen/handoutow — konfigurowalny per wywolanie, do kalibracji na `samples/`. */
const DEFAULT_TARGET_LONG_EDGE_PX = 2048;
/** Twardy sufit domyslny (KROK-8 Z3, brief) — konfigurowalny przez `maxLongEdgePx`. */
const DEFAULT_MAX_LONG_EDGE_PX = 4096;
/** Ten sam prog co `LARGE_AREA_CONTENT_THRESHOLD` w `classify.ts` — spojnosc miedzy "duzy obraz = tresc" i "duzy wektor bez obrazu = mapa rysowana". */
const LARGE_VECTOR_AREA_THRESHOLD = 0.4;
/**
 * [KROK-8 Z1] Zabezpieczenie DRUGIEGO RZEDU (nie glowny mechanizm — patrz
 * `groupIntoUnits`): klaster (>1 czlonek) o unii bboksow powyzej tego udzialu
 * powierzchni strony jest wymuszany na `undecided`, niezaleznie od klasyfikacji
 * reprezentanta. Wartosc z briefu KROK-8 ("np. 85%") — swiadomie WYSOKI prog,
 * bo GLOWNA naprawa (klastrowanie WYLACZNIE kandydatow content/undecided,
 * przeliczone od zera) juz eliminuje typowy przypadek (lancuch kafli tla
 * zbudowany z wpisow `decoration`/`mask`). To zabezpieczenie lapie tylko
 * rzadszy przypadek: gesty lancuch MALYCH, ale indywidualnie `content`/
 * `undecided` fragmentow, ktory i tak rozciaga sie niemal na cala strone.
 */
const CLUSTER_AREA_SAFEGUARD_THRESHOLD = 0.85;

/**
 * [KROK-16 Z2, naprawa zgloszonego bledu na zywo] Dwa kandydaty "niezaleznie
 * duzi" (>= tego udzialu powierzchni strony, kazdy z osobna — prawdopodobnie
 * gotowe, samodzielne obrazy tresci, nie fragmenty jednej kompozycji) laczone
 * w JEDNA "kotwice" tylko jesli ich nakladanie (`overlapRatio` — powierzchnia
 * przeciecia / powierzchnia MNIEJSZEGO z nich) osiaga ten prog. Male elementy
 * (ponizej progu powierzchni) NIGDY nie sa "kotwicami" — nadal laczone luznym
 * `rectsOverlap`, jak zawsze (patrz `partitionCandidatesIntoGroups`), bo
 * praktycznie NIGDY nie osiagaja tego progu powierzchni pojedynczo (fixture
 * `extract-cluster`: ikony 60x60/40x40pt to <1% strony kazda).
 *
 * [KROK-43 Z3, zweryfikowane na materiale gestym graficznie po audycie
 * stalych — patrz `RAPORT-KROK-43.md`] Obie stale strojone pod JEDEN
 * konkretny zgloszony przypadek (str. 13/14 z kroku 16), nigdy systematycznie
 * skalibrowane — sprawdzone na `sample/Archiwa_Imperium.pdf` (380 obrazow/97
 * stron, do 18 obrazow na jednej stronie — "Obcy" niedostepny w sample/,
 * `WRAK.pdf` odrzucony jako material testowy: eksportuje KAZDA strone jako
 * jeden plaski raster, wiec nie cwiczy klastrowania wielu obrazow wcale).
 * Przemiatanie OBU stalych niezaleznie w CALYM sensownym zakresie
 * (`INDEPENDENT_IMAGE_AREA_THRESHOLD`: 0.01-0.9; `EDGE_TOUCH_MAX_OVERLAP_RATIO`:
 * 0.01-0.9) dalo STABILNY wynik — liczba grup wachala sie tylko w waskim
 * pasmie (186-212 z 262 kandydatow), najwiekszy pojedynczy klaster pozostaje
 * identyczny (11 czlonkow) na calym zakresie obu parametrow — ZERO urwiska,
 * zero eksplozji do jednego megaklastra, zero rozpadu na same singletony.
 * Istniejace zloty testy regresji z kroku 16 (`extract-independent-touching`,
 * `extract-anchor-loose-fragment`, `extract-shared-resource-multipage`) nadal
 * zielone. Wniosek: wartosci startowe (0,1 / 0,2) leza bezpiecznie w SRODKU
 * szerokiego plateau — brak dowodu, ze sa zle, wiec ZOSTAJA NIEZMIENIONE
 * (zmiana bez powodu jest gorsza niz jej brak).
 */
const INDEPENDENT_IMAGE_AREA_THRESHOLD = 0.1;
const EDGE_TOUCH_MAX_OVERLAP_RATIO = 0.2;

function isAnchorCandidate(c: ClassifiedImage): boolean {
  return c.entry.maxRelativeArea >= INDEPENDENT_IMAGE_AREA_THRESHOLD;
}

/**
 * [KROK-16 Z2, druga iteracja naprawy] Pierwsza wersja tej naprawy (pojedyncza
 * bramka na `clusterByOverlap`, blokujaca WYLACZNIE bezposrednie polaczenie
 * dwoch "kotwic") naprawila `img_p15_1`+`img_p15_2` (str. 16, stykajace sie
 * BEZPOSREDNIO), ale NIE `img_p13_1`+`img_p13_2` (str. 14) — zgloszone przez
 * uzytkownika jako nadal nie dzialajace. Przyczyna: klastrowanie jest
 * PRZECHODNIE (union-find) — dwie "kotwice" A i B, ktorych bramka blokuje
 * BEZPOSREDNIE polaczenie, i tak koncza w JEDNYM klastrze, jesli kazda z nich
 * NIEZALEZNIE naklada sie na trzeci, MALY element C (bramka nie blokuje par
 * gdzie choc jeden czlonek jest maly, wiec A-C i B-C laczy sie normalnie, a A-C-B
 * daje A i B w jednym klastrze mimo ze A-B samo w sobie bylo zablokowane).
 * Zaobserwowane wprost: `img_p13_3`/`img_p13_4` (kazdy ~1.5% strony) leza W STREFIE
 * NAKLADANIA `img_p13_1` (26.9%) i `img_p13_2` (10.2%), mostkujac je z powrotem.
 *
 * Naprawa: DWUETAPOWE partycjonowanie zamiast plaskiego `clusterByOverlap` z
 * bramka. (1) Wydziel "kotwice" (>= progu powierzchni) i sklastruj WYLACZNIE
 * je, wymagajac silnego nakladania (`overlapRatio >= EDGE_TOUCH_MAX_OVERLAP_RATIO`)
 * do polaczenia — dwie kotwice stykajace sie slabo NIGDY nie trafiaja w jedna
 * grupe kotwic, niezaleznie od tego, ile malych elementow je "mostkuje".
 * (2) Kazdy MALY (nie-kotwica) element dolaczany jest do TEJ JEDNEJ grupy
 * kotwic, z ktora ma NAJWIEKSZE pole przeciecia (nie do wszystkich, z ktorymi
 * sie styka) — `img_p13_3` naklada sie na `img_p13_2` w ~91% wlasnej
 * powierzchni, a na `img_p13_1` tylko w ~9%, wiec trafia WYLACZNIE do grupy
 * `img_p13_2`. (3) Male elementy bez zadnego nakladania z kotwica na tej
 * stronie klastrowane sa miedzy soba po staremu (luzny `rectsOverlap`, zero
 * zmian) — zachowuje pierwotny mechanizm sklejania lancucha kafli (krok 7/8,
 * `img_p7_6`) na stronach BEZ zadnej kotwicy.
 */
/**
 * [na zyczenie uzytkownika, po naprawie klasyfikacji "Wrak"] Obraz wymuszony na
 * `content` WYLACZNIE dlatego, ze jest tlem pod pelnym spadem z tekstem na
 * wierzchu (`Z1-full-bleed-forced-content`, patrz `classify.ts`) MUSI zostac
 * WYLACZONY z klastrowania ponizej, inaczej cel calej flagi ("czysty obraz bez
 * tekstu") jest udaremniony: jego bbox z DEFINICJI "zawiera" (rectsOverlap i
 * overlapRatio ~1.0 wzgledem mniejszego) KAZDY inny obraz/wektor na tej samej
 * stronie, wiec zwykla logika kotwic (`isAnchorCandidate`/`EDGE_TOUCH_MAX_OVERLAP_RATIO`)
 * polaczylaby go z KAZDYM innym kandydatem w JEDNA jednostke, wymuszajac
 * `clusterMemberCount > 1` -> `region-render` CALEJ strony (z tekstem) zamiast
 * `direct` (surowy zasob, bez tekstu) — zmierzone wprost na eksporcie
 * uzytkownika: strona zamiast czystej ilustracji.
 */
function isForcedFullBleedContent(c: ClassifiedImage): boolean {
  return c.reason === 'Z1-full-bleed-forced-content';
}

function partitionCandidatesIntoGroups(candidates: readonly ClassifiedImage[]): ClassifiedImage[][] {
  const forcedFullBleed = candidates.filter(isForcedFullBleedContent);
  const clusterable = candidates.filter((c) => !isForcedFullBleedContent(c));

  const anchors = clusterable.filter(isAnchorCandidate);
  const rest = clusterable.filter((c) => !isAnchorCandidate(c));

  const anchorClusterId = clusterByOverlap(
    anchors,
    (c) => c.entry.occurrences[0]!.page,
    (c) => c.entry.occurrences[0]!.bbox,
    (_a, _b, bboxA, bboxB) => overlapRatio(bboxA, bboxB) >= EDGE_TOUCH_MAX_OVERLAP_RATIO,
  );
  const anchorGroups = new Map<string, ClassifiedImage[]>();
  for (const a of anchors) {
    const key = anchorClusterId.get(a)!;
    const arr = anchorGroups.get(key) ?? [];
    arr.push(a);
    anchorGroups.set(key, arr);
  }
  const groupKeyOfAnchor = new Map<ClassifiedImage, string>();
  for (const [key, group] of anchorGroups) for (const a of group) groupKeyOfAnchor.set(a, key);

  const anchorsByPage = new Map<number, ClassifiedImage[]>();
  for (const a of anchors) {
    const page = a.entry.occurrences[0]!.page;
    const arr = anchorsByPage.get(page) ?? [];
    arr.push(a);
    anchorsByPage.set(page, arr);
  }

  const unassignedRest: ClassifiedImage[] = [];
  for (const c of rest) {
    const page = c.entry.occurrences[0]!.page;
    const bboxC = c.entry.occurrences[0]!.bbox;
    let bestAnchor: ClassifiedImage | null = null;
    let bestOverlapArea = 0;
    for (const a of anchorsByPage.get(page) ?? []) {
      const inter = rectIntersection(a.entry.occurrences[0]!.bbox, bboxC);
      if (!inter) continue;
      const area = rectArea(inter);
      if (area > bestOverlapArea) {
        bestOverlapArea = area;
        bestAnchor = a;
      }
    }
    // [KROK-16 Z2, trzecia iteracja naprawy] Sam fakt "jakiegokolwiek" nakladania
    // z najlepsza kotwica NIE WYSTARCZA — zaobserwowane wprost: `img_p13_4`
    // (~1.5% strony) stykal sie z jedyna kotwica na stronie (`img_p13_1`, 26.9%)
    // WYLACZNIE waskim naroznikiem (overlapRatio wzgledem WLASNEJ powierzchni
    // ~9%), a mimo to jego bbox rozciagal sie ~200pt POZA kotwice — dolaczenie go
    // i tak odtwarzalo niemal identyczny, zbyt szeroki union bbox co przed
    // naprawa (bo `img_p13_2`, dekoracja miedzy nimi, zostala juz poprawnie
    // wykluczona z kandydatow, ale JEJ MIEJSCE zajal `img_p13_4`). Wymagany ten
    // sam prog co przy laczeniu dwoch kotwic (`overlapRatio >= EDGE_TOUCH_MAX_OVERLAP_RATIO`,
    // liczony wzgledem MNIEJSZEGO z dwoch — tu prawie zawsze samego elementu C) —
    // ponizej progu element idzie do wspolnego klastrowania reszty (albo staje
    // sie wlasna, osobna, mala jednostka), NIE zostaje wciagniety w kotwice.
    if (bestAnchor && overlapRatio(bestAnchor.entry.occurrences[0]!.bbox, bboxC) >= EDGE_TOUCH_MAX_OVERLAP_RATIO) {
      anchorGroups.get(groupKeyOfAnchor.get(bestAnchor)!)!.push(c);
    } else {
      unassignedRest.push(c);
    }
  }

  const groups: ClassifiedImage[][] = [...anchorGroups.values()];
  if (unassignedRest.length > 0) {
    const restClusterId = clusterByOverlap(
      unassignedRest,
      (c) => c.entry.occurrences[0]!.page,
      (c) => c.entry.occurrences[0]!.bbox,
    );
    const restGroups = new Map<string, ClassifiedImage[]>();
    for (const c of unassignedRest) {
      const key = restClusterId.get(c)!;
      const arr = restGroups.get(key) ?? [];
      arr.push(c);
      restGroups.set(key, arr);
    }
    groups.push(...restGroups.values());
  }
  groups.push(...forcedFullBleed.map((c) => [c]));
  return groups;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('buildImageExtraction przerwane przez AbortSignal', 'AbortError');
}

interface ExtractionUnit {
  /** `null` = region czysto wektorowy (mapa rysowana), brak obrazu do wyciagniecia. */
  representativeEntry: ImageEntry | null;
  memberEntries: readonly ImageEntry[];
  page: number;
  bbox: Rect;
  clusterMemberCount: number;
  classification: ImageClassification;
  /** [KROK-11 Z4] Patrz `ClassifiedImage.confidence` — pewnosc reprezentanta klastra, ewentualnie obnizona przy wymuszeniu `undecided` (patrz `IMAGE_CLUSTER_AREA_OVERREACH` nizej). */
  confidence: number;
  /** [na zyczenie uzytkownika] `reason` reprezentanta — uzywane WYLACZNIE do wykrycia `Z1-full-bleed-forced-content` (decyzja o probie `autoCropUniformMargins`), NIE do niczego innego. */
  reason: string;
}

/**
 * Grupuje kandydatow (content/undecided) po klastrach nakladajacych sie
 * bboksow (Z2: klaster = JEDNA jednostka ekstrakcji, nie N). Bbox jednostki to
 * UNIA wszystkich wystapien wszystkich czlonkow — tak, zeby render regionu
 * (gdy strategia tego wymaga) objal cala kompozycje, nie tylko jeden jej element.
 *
 * [KROK-8 Z1, odkrycie] Klastrowanie jest PRZELICZONE OD ZERA tutaj, na
 * PRZEFILTROWANYM zbiorze kandydatow (`clusterByOverlap`), a NIE odczytane z
 * `entry.clusterId` — to pole jest policzone w `imageRegistry.ts` (KROK-4/5) na
 * WSZYSTKICH wystapieniach, WLACZNIE z przyszla dekoracja/maska. Filtrowanie
 * WYNIKU takiego pre-computed klastrowania (po prostu odrzucenie czlonkow
 * decoration/mask z gotowej grupy) NIE rozbija lancucha, ktory te wlasnie
 * wpisy zmostkowaly — dwa genuinie osobne, oddalone od siebie obrazy tresci
 * polaczone WYLACZNIE przez lancuch malych, nakladajacych sie kafli dekoracji
 * miedzy nimi zostalyby w JEDNEJ grupie nawet po odrzuceniu tych kafli z listy
 * czlonkow. Zaobserwowane wprost: `img_p7_6` z `Wrath_&_Glory` (RAPORT-KROK-7.md)
 * — cala strona tekstu wyrenderowana jako "obraz". Przeliczenie od zera na
 * samych kandydatach sprawia, ze usuniecie mostkujacej dekoracji/maski Z GRAFU
 * naprawde rozbija lancuch, nie tylko filtruje jego czlonkow z wyniku.
 */
function groupIntoUnits(candidates: readonly ClassifiedImage[], pageBoxByPage: ReadonlyMap<number, Rect>, diagnostics: Diagnostic[]): ExtractionUnit[] {
  const groups = partitionCandidatesIntoGroups(candidates);

  return groups.map((group) => {
    const representative = group.reduce((best, cur) => (cur.entry.maxRelativeArea > best.entry.maxRelativeArea ? cur : best));
    const page = representative.entry.occurrences[0]!.page;
    // [KROK-16 Z2, czwarta iteracja naprawy] Unia TYLKO wystapien NA TEJ SAMEJ
    // stronie co jednostka — zaobserwowane wprost: `g_d0_img_p7_8` (jeden
    // zasob PDF uzyty w 5 RUZNYCH miejscach na 5 RUZNYCH stronach, 8/9/15/16/19,
    // NIE "ten sam element w tej samej pozycji" — to zwykle wspoldzielona
    // ikona/znacznik uzyty kontekstowo w roznych miejscach). Dawna wersja
    // unowala bboksy WSZYSTKICH wystapien encji, WLACZNIE z tymi na INNYCH
    // stronach — bbox jednostki renderowanej na stronie 8 obejmowal wiec tez
    // wspolrzedne z wystapien na stronach 9/15/16/19, dajac bezsensowna, ale
    // przypadkowo duza (~48% strony) unie, ktora przy renderze REGIONU na
    // stronie 8 lapala niemal cala tresc tej strony (obserwowane: cala strona
    // statbloku wyekstrahowana jako "obraz"). Blad byl UTAJONY od kroku 7/8 —
    // wczesniej KAZDY wpis obecny na >=2 skorelowanych stronach byl twardo
    // `decoration` (nigdy nie wchodzil do kandydatow), wiec ta sciezka kodu
    // nigdy nie byla cwiczona na prawdziwym multi-page wpisie. Krok 15 Z3
    // (prog podniesiony do 5 stron + miekki fallback do `undecided` zamiast
    // `decoration`) po raz pierwszy wpuscil taki wpis do ekstrakcji, ujawniajac
    // usypiony blad.
    const bbox = group
      .flatMap((c) => c.entry.occurrences.filter((o) => o.page === page).map((o) => o.bbox))
      .reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
    let classification = representative.classification;
    let confidence = representative.confidence;
    let reason = representative.reason;

    // Zabezpieczenie drugiego rzedu (patrz komentarz przy stalej) — tylko dla
    // FAKTYCZNYCH klastrow (>1 czlonek); pojedynczy obraz zajmujacy cala
    // strone to prawdopodobnie prawdziwa mapa/scena, nie efekt uboczny klastrowania.
    const pageBox = pageBoxByPage.get(page);
    if (group.length > 1 && pageBox && relativeArea(bbox, pageBox) > CLUSTER_AREA_SAFEGUARD_THRESHOLD) {
      if (classification !== 'undecided') {
        diagnostics.push({
          severity: 'warning',
          code: 'IMAGE_CLUSTER_AREA_OVERREACH',
          params: { imageCount: group.length, percent: (relativeArea(bbox, pageBox) * 100).toFixed(0), classification },
          pageNumber: page,
        });
      }
      classification = 'undecided';
      // [KROK-11 Z4] Wymuszenie 'undecided' unieważnia oryginalny `reason`/`confidence`
      // reprezentanta — ten klaster nie jest juz "duzy obszar bez maski", tylko
      // "wymuszony bezpiecznik", wiec dostaje ta sama niska pewnosc co
      // `Z1-no-strong-signal` (najslabsza kategoria `undecided`).
      confidence = confidenceForReason('Z1-no-strong-signal');
      reason = 'Z1-no-strong-signal';
    }

    return {
      representativeEntry: representative.entry,
      memberEntries: group.map((c) => c.entry),
      page,
      bbox,
      clusterMemberCount: group.length,
      classification,
      confidence,
      reason,
    };
  });
}

/**
 * Strony BEZ jakiegokolwiek obrazu, ale z duzym regionem wektorowym (fill/stroke
 * prostokatny — `walkOperators` nie wykrywa dowolnych sciezek, tylko
 * osiowo-zorientowane prostokaty, patrz `vectorRegistry.ts`) to kandydat na
 * "mape rysowana wektorowo" — jedyny sposob na wyciagniecie czegokolwiek to
 * render calego regionu (Z2/Z3), bo nie ma obrazu do ekstrakcji bezposredniej.
 */
function findVectorOnlyUnits(vectors: readonly VectorRegion[], pagesWithAnyImage: ReadonlySet<number>): ExtractionUnit[] {
  const bigVectorsByPage = new Map<number, VectorRegion[]>();
  for (const v of vectors) {
    if (v.relativeArea < LARGE_VECTOR_AREA_THRESHOLD) continue;
    if (pagesWithAnyImage.has(v.page)) continue;
    const arr = bigVectorsByPage.get(v.page) ?? [];
    arr.push(v);
    bigVectorsByPage.set(v.page, arr);
  }
  const units: ExtractionUnit[] = [];
  for (const [page, vecs] of bigVectorsByPage) {
    const bbox = vecs.map((v) => v.bbox).reduce((acc, b) => unionRect(acc, b));
    units.push({
      representativeEntry: null,
      memberEntries: [],
      page,
      bbox,
      clusterMemberCount: 0,
      classification: 'undecided',
      confidence: confidenceForReason('Z1-no-strong-signal'),
      reason: 'Z1-no-strong-signal',
    });
  }
  return units;
}

/** Placeholder `ImageEntry` dla jednostek bez prawdziwego obrazu (region czysto wektorowy) — potrzebny, zeby `finalizeImages` mialo na czym pracowac. */
function syntheticVectorOnlyEntry(pageNumber: number, bbox: Rect): ImageEntry {
  return {
    objId: null,
    occurrences: [{ page: pageNumber, bbox, index: -1 }],
    pageRefs: [pageNumber],
    maxRelativeArea: 1,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: null,
    intrinsicHeight: null,
  };
}

export async function buildImageExtraction(
  doc: PdfDocumentLikeForImages,
  inventory: InventoryForImages,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: BuildImageExtractionOptions = {},
): Promise<BuildImageExtractionResult> {
  const { signal, onProgress } = opts;
  checkAborted(signal); // musi byc sprawdzone TERAZ, nie dopiero w petli po stronach — dokument bez jednostek do przetworzenia (petla nigdy sie nie wykona) inaczej cicho zignorowalby juz-przerwany sygnal.
  const autoCropUniformMargins = opts.autoCropUniformMargins ?? false;
  const brightenAutoCroppedImages = opts.brightenAutoCroppedImages ?? false;
  const targetLongEdgePx = opts.targetLongEdgePx ?? DEFAULT_TARGET_LONG_EDGE_PX;
  const maxLongEdgePx = opts.maxLongEdgePx ?? DEFAULT_MAX_LONG_EDGE_PX;
  const nearStatblockOrHeadingObjIds = opts.nearStatblockOrHeadingObjIds ?? new Set<string>();
  const diagnostics: Diagnostic[] = [];

  const pageBoxByPage = new Map(inventory.perPage.map((p) => [p.pageNumber, p.box]));
  const bodyBlockBoxesByPage = opts.bodyBlockBoxesByPage ?? new Map();
  const classified = classifyImages(inventory.images, pageBoxByPage, bodyBlockBoxesByPage, {
    treatFullBleedAsContent: opts.treatFullBleedAsContent ?? false,
  });
  // [KROK-43 Z1, naprawa "cicha utrata" po audycie stalych] `Z13-extreme-aspect-ratio-undecided`
  // (patrz `classify.ts`) laduje w `undecided`, nie `decoration` — widoczny w
  // przegladzie, ale uzytkownik powinien wiedziec DLACZEGO obraz tam trafil
  // (proporcje, nie "brak jakiegokolwiek sygnalu"), stad wlasny Diagnostic
  // zamiast cichej zmiany klasyfikacji.
  for (const c of classified) {
    if (c.reason !== 'Z13-extreme-aspect-ratio-undecided') continue;
    diagnostics.push({
      severity: 'info',
      code: 'IMAGE_EXTREME_ASPECT_RATIO_UNDECIDED',
      params: { threshold: EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD },
      pageNumber: c.entry.occurrences[0]?.page,
    });
  }
  const maskedObjIds = computeMaskedObjIds(inventory.images);

  const candidates = classified.filter((c) => c.classification === 'content' || c.classification === 'undecided');
  const imageUnits = groupIntoUnits(candidates, pageBoxByPage, diagnostics);

  const pagesWithAnyImage = new Set<number>();
  for (const entry of inventory.images) for (const occ of entry.occurrences) pagesWithAnyImage.add(occ.page);
  const vectorOnlyUnits = findVectorOnlyUnits(inventory.vectors, pagesWithAnyImage);

  // Kolejnosc DETERMINISTYCZNA, niezalezna od kolejnosci wejscia: strona rosnaco,
  // wewnatrz strony po objId (regiony wektorowe, bez objId, na koncu kazdej strony).
  const allUnits = [...imageUnits, ...vectorOnlyUnits].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return (a.representativeEntry?.objId ?? '￿').localeCompare(b.representativeEntry?.objId ?? '￿');
  });

  const unitsByPage = new Map<number, ExtractionUnit[]>();
  for (const u of allUnits) {
    const arr = unitsByPage.get(u.page) ?? [];
    arr.push(u);
    unitsByPage.set(u.page, arr);
  }

  const prepared: PreparedEntryForFinalize<EncodedImage>[] = [];
  let done = 0;
  const total = allUnits.length;

  // [Z6] Sekwencyjnie, strona po stronie — NIGDY Promise.all na wielu stronach
  // (ten sam wzorzec co `inventory.ts`, MDD §12). `page.cleanup()` po kazdej
  // stronie (zmierzone w kroku 4: -58% szczytowego RSS).
  for (const pageNumber of [...unitsByPage.keys()].sort((a, b) => a - b)) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      // [U3, KROK-7 odkrycie] `page.objs`/`page.commonObjs` sa puste dopoki
      // `getOperatorList()` (lub render) nie przetworzy tej strony — ta strona
      // jest ze SWIEZEGO otwarcia dokumentu (`doc`), niezaleznego od tego
      // uzytego do inwentaryzacji, wiec jej `page.objs` NIGDY nie zostalo
      // zapelnione. Bez tego wywolania KAZDA probka `extractDirect` (nawet dla
      // najprostszego, pojedynczego obrazu) fallowala do renderu regionu,
      // mimo ze `has()` powinno zwrocic `true` — ten sam wzorzec co
      // `buildTextLayout.ts` (getOperatorList PRZED getTextContent).
      await page.getOperatorList();
      checkAborted(signal);
      for (const unit of unitsByPage.get(pageNumber)!) {
        checkAborted(signal);
        try {
          const isMasked = unit.memberEntries.some((e) => e.objId !== null && maskedObjIds.has(e.objId));
          const decision = decideExtractionStrategy({
            entry: unit.representativeEntry,
            isMasked,
            clusterMemberCount: Math.max(1, unit.clusterMemberCount),
          });
          const objIdForExtraction = decision.strategy === 'direct' ? unit.representativeEntry!.objId : null;

          // [KROK-8 Z3] Rozdzielczosc renderu regionu WYNIKA z natywnej
          // rozdzielczosci zasobow w regionie, nie ze stalej — patrz
          // `renderResolution.ts`. Bez znaczenia dla strategii `direct`
          // (ekstrakcja bezposrednia zawsze zwraca pelna rozdzielczosc
          // zrodlowa, `targetLongEdgePx` jest tam ignorowane, Z4) — sondujemy
          // wylacznie wtedy, gdy faktycznie renderujemy region.
          let effectiveTargetLongEdgePx = targetLongEdgePx;
          if (decision.strategy === 'region-render') {
            const intrinsicLongEdgesPx: number[] = [];
            for (const member of unit.memberEntries) {
              if (member.objId === null) continue;
              const longEdge = await probeIntrinsicLongEdgePx(page, member.objId);
              if (longEdge !== null) intrinsicLongEdgesPx.push(longEdge);
            }
            effectiveTargetLongEdgePx = computeTargetLongEdgePx({
              intrinsicLongEdgesPx,
              representativeMaxRelativeArea: unit.representativeEntry?.maxRelativeArea ?? null,
              defaultLongEdgePx: targetLongEdgePx,
              maxLongEdgePx,
            });
          }

          const extractResult = await extractDirect(
            page,
            objIdForExtraction,
            unit.bbox,
            renderer,
            { targetLongEdgePx: effectiveTargetLongEdgePx, signal },
            pageNumber,
          );
          diagnostics.push(...extractResult.diagnostics);

          // [na zyczenie uzytkownika, EKSPERYMENTALNE] Przyciecie pustego marginesu
          // — WYLACZNIE dla jednostek ujawnionych przez `Z1-full-bleed-forced-content`
          // (patrz `cropUniformMargins.ts`), NIE dla zwyklej tresci juz poprawnie
          // wyodrebnionej przez sama strukture PDF-a (ta ma juz wlasciwy bbox,
          // przycinanie jej pikseli byloby bezcelowe i ryzykowne).
          let image = extractResult.image;
          if (autoCropUniformMargins && unit.reason === 'Z1-full-bleed-forced-content') {
            const bounds = detectContentBounds(image);
            if (bounds) {
              image = cropDecodedImage(image, bounds);
              // [na zyczenie uzytkownika] WYLACZNIE dla obrazow faktycznie
              // przycietych na tej linii (`bounds` niepuste) — patrz
              // uzasadnienie w `brightenImage.ts`. Obraz, dla ktorego
              // `detectContentBounds` zwrocilo `null` (nic sensownego do
              // przyciecia), NIE przechodzi przez ta transformacje.
              if (brightenAutoCroppedImages) image = brightenCroppedImage(image, AUTOCROP_BRIGHTEN);
            }
          }

          // [Z6, budzet pamieci] hash + encode NATYCHMIAST; `extractResult.image`
          // (surowy RGBA, do 48MB dla 4000x3000) NIE jest przechowywany dalej —
          // tylko hash + wymiary + juz-skompresowane bajty trafiaja do `prepared`.
          const contentHash = await computeContentHash(image);
          // [KROK-8 Z2] Liczone TYLKO dla kandydatow 'content' — 'undecided' nie
          // podlega tej reklasyfikacji (patrz `finalize.ts`), wiec oszczedzamy
          // dodatkowy przebieg po pikselach tam, gdzie i tak nie zostanie uzyty.
          const luminanceStdDev = unit.classification === 'content' ? computeLuminanceStdDev(image) : undefined;
          // [KROK-17] Sugestia siatki — NIE ograniczone do 'content' (w
          // odroznieniu od `luminanceStdDev` powyzej): 'undecided' rowniez moze
          // trafic na scene reczna decyzja uzytkownika (Z4, ReviewScreen), a
          // koszt liczenia jest pomijalny wzgledem juz i tak wykonanego decode.
          const suggestedGrid = detectGrid(image) ?? undefined;
          const encoded = await encoder.encode(image, { format: opts.outputFormat, quality: opts.outputQuality });

          const entryForFinalize = unit.representativeEntry ?? syntheticVectorOnlyEntry(pageNumber, unit.bbox);
          // [KROK-11 Z4] Region czysto wektorowy wymuszony na 'content' (linia
          // wyzej) to swiadoma, pewna decyzja (udany render mapy rysowanej
          // wektorowo) — dostaje wysoka pewnosc, NIE nisza pewnosc `undecided`
          // odziedziczona z `unit.confidence` (ktora opisywala co innego:
          // "brak obrazu do wyciagniecia wprost").
          const confidence = unit.representativeEntry ? unit.confidence : confidenceForReason('Z1-large-relative-area');
          prepared.push({
            entry: entryForFinalize,
            classification: unit.representativeEntry ? unit.classification : 'content',
            confidence,
            extractSource: extractResult.source,
            contentHash,
            width: image.width,
            height: image.height,
            luminanceStdDev,
            suggestedGrid,
            payload: encoded,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          diagnostics.push({
            severity: 'error',
            code: 'IMAGE_EXTRACTION_FAILED',
            params: { objId: unit.representativeEntry?.objId ?? '(vector-region)', error: err instanceof Error ? err.message : String(err) },
            pageNumber,
          });
        }
        done++;
        onProgress?.(done, total);
      }
    } finally {
      page.cleanup();
    }
  }

  const finalized = finalizeImages(prepared, nearStatblockOrHeadingObjIds, diagnostics);

  return {
    images: finalized.images,
    correlationClosedByBBox: finalized.correlationClosedByBBox,
    correlationClosedByHash: finalized.correlationClosedByHash,
    duplicatesRemoved: finalized.duplicatesRemoved,
    diagnostics,
  };
}
