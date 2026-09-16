import type { ImageClassification } from './classify.js';
import type { ExtractSource } from './extract.js';
import type { GridDetectionResult } from './detectGrid.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { Diagnostic } from '../text/types.js';

/**
 * Deduplikacja i klasyfikacja docelowa (KROK-7 Z5, MDD faza 3). Dopiero PO
 * decodowaniu jest dostepny `contentHash` — uzywamy go do (1) domkniecia
 * korelacji z U1 poza to, co zlapala korelacja pozycyjna (krok 5/6), (2)
 * deduplikacji finalnej listy, (3) heurystyk `scene`/`handout`/`portrait`
 * (domyslne — profile fazy 4 je nadpisza).
 *
 * `crypto.subtle` (Web Crypto) uzyty celowo zamiast `node:crypto` — standard
 * platformy webowej dostepny RowNIEZ w Node (>=20), wiec dziala identycznie w
 * przegladarce i w testach (ten sam wzorzec co `OffscreenCanvas`, A1).
 *
 * [KROK-7 Z6, budzet pamieci] Ta funkcja CELOWO nie przyjmuje surowego
 * `DecodedImage` (48MB dla obrazu 4000x3000) — tylko juz policzony `contentHash`
 * + wymiary + dowolny "payload" (np. juz zakodowane bajty WebP/PNG, o wiele
 * mniejsze). Orkiestrator liczy hash i koduje KAZDY obraz osobno, natychmiast
 * po decode, i zwalnia surowe piksele PRZED przejsciem do nastepnego — dopiero
 * WTEDY (gdy wszystkie surowe bufory juz nie istnieja) wywoluje `finalizeImages`
 * na lekkiej liscie metadanych. Bez tego rozdzielenia (obliczanie hashu
 * WEWNATRZ finalize, na calej liscie na raz) trzeba by trzymac WSZYSTKIE
 * zdekodowane obrazy dokumentu w pamieci jednoczesnie — dokladnie to, czego
 * brief zabrania (budzet RAM 1,2 GB, "Dwadziescia takich naraz to 1 GB").
 */

export type ImageTargetKind = 'scene' | 'handout' | 'portrait' | 'unknown';

/**
 * Rozmiar bezwzgledny ponizej ktorego obraz jest PODEJRZANY o bycie zbyt malym,
 * zeby byc uzyteczna trescia — wartosc WPROST z MDD §Faza 3 ("odrzuc
 * intrinsicWidth < 100 || intrinsicHeight < 100"), NIGDY nie zweryfikowana na
 * realnym materiale. Sprawdzany TUTAJ (po decode), nie w `classify.ts` — patrz
 * komentarz tam, dlaczego (pdf.js nie ujawnia intrinsicWidth/Height przed
 * rozwiazaniem obiektu).
 *
 * [KROK-43 Z1, naprawa "cicha utrata" po audycie stalych — A10] Reklasyfikacja
 * ponizej dawniej ladowala WPROST w `decoration`, NADPISUJAC nawet
 * NAJSILNIEJSZY sygnal `content` (np. `Z1-large-relative-area`, pewnosc 0,9) —
 * bez zadnego dowodu kalibracyjnego ani szansy na przeglad. Prawdziwy, maly
 * portret/ikona (np. 95x95px) trafialby w decoration po cichu, dokladnie ten
 * sam wzorzec bledu co `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD` (patrz
 * `classify.ts`) — w odroznieniu od reklasyfikacji "plaskiej tekstury" ponizej
 * (`FLAT_TEXTURE_STDDEV_THRESHOLD`), ktora dziala WYLACZNIE na juz-slabym
 * sygnale `content` (`confidence < FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`),
 * ta regula nie mala ZADNEGO takiego zabezpieczenia. Naprawa: laduje teraz w
 * `undecided` (widoczne w przegladzie, z `Diagnostic`
 * `IMAGE_TOO_SMALL_UNDECIDED` w `buildImageExtraction.ts`), nie w `decoration`.
 */
const MIN_ABSOLUTE_PX = 100;
/** [KROK-43 Z1] Pewnosc dla reklasyfikacji "za male" -> `undecided` — ten sam poziom co inne pojedyncze, niepotwierdzone-drugim-sygnalem sygnaly (patrz `Z13-extreme-aspect-ratio-undecided` w `classify.ts`), NIE `RECLASSIFIED_CONFIDENCE` (0,9) uzywane przez faktyczne twarde reklasyfikacje ponizej. */
const TOO_SMALL_UNDECIDED_CONFIDENCE = 0.4;

/**
 * [KROK-8 Z2, odkrycie] Powierzchnia wzgledna (i nawet proporcje bboksa) NIE
 * odrozniaja niezawodnie prawdziwej ilustracji od PLASKIEJ TEKSTURY TLA
 * (np. jednolity "papier"/"pergamin" uzywany jako dekoracyjne tlo strony) —
 * zaobserwowane wprost na `CP-RED-InterfaceVol1_v1.pdf` PO wdrozeniu
 * `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD` w `classify.ts`: dwie plaskie tekstury
 * tla (powierzchnia 0,193 i 0,279 strony — W ZAKRESIE prawdziwej tresci
 * 0,116-0,257) zostaly falszywie sklasyfikowane jako `content`. Odchylenie
 * standardowe luminancji pikseli PO decode odrozniA je jednoznacznie:
 * zmierzone teksturki = 2,33 i 13,16, prawdziwa tresc (6 obrazow) = 40,75-81,20
 * — czysta przerwa. Ten sygnal wymaga JUZ zdekodowanych pikseli (jak
 * `MIN_ABSOLUTE_PX` wyzej), wiec jest liczony przez WOLAJACEGO (orkiestrator,
 * `buildImageExtraction.ts`) i przekazany jako gotowa liczba — `finalize.ts`
 * nie trzyma surowego `DecodedImage` (patrz komentarz o budzecie pamieci).
 */
const FLAT_TEXTURE_STDDEV_THRESHOLD = 20;

/**
 * [KROK-17, zgloszony na zywo blad] Reklasyfikacja "plaskiej tekstury" ponizej
 * dziala TYLKO na wpisach ze SLABYM sygnalem `content` — dokladnie tak, jak
 * zostala skalibrowana (oba przypadki z komentarza `FLAT_TEXTURE_STDDEV_THRESHOLD`
 * to `Z2-moderate-area-no-mask-evidence`, pewnosc 0,5). Zaobserwowane wprost
 * na `CHA23131 Call of Cthulhu 7th Edition Quick-Start Rules.pdf`: mapa
 * rysowana czarna kreska na bialym tle ("Corbitt House Investigator Map",
 * `Z1-large-relative-area`, pewnosc 0,9 — MOCNY, jednoznaczny sygnal
 * geometryczny) ma niskie odchylenie standardowe luminancji z DOKLADNIE TEGO
 * SAMEGO powodu co plaska tekstura pergaminu (dominujace jasne tlo, rzadka
 * ciemna kreska) — reklasyfikacja bezwarunkowo nadpisywala mocny sygnal
 * slabym, jednosygnalowym heurystykiem pikselowym, gubiac faktyczny handout.
 * Prog = ten sam co gdzie indziej w tym pliku uzywana granica "content ponizej
 * tego progu startuje odznaczone w przegladzie" (patrz `ClassifiedImage.confidence`
 * w `classify.ts`) — nie nowa, niezalezna wartosc.
 */
const FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE = 0.6;

/** "Duza rozdzielczosc" (brief, `scene`) — dluzsza krawedz. Do weryfikacji w kalibracji na `samples/`. */
const SCENE_MIN_LONG_EDGE_PX = 1200;
/** "Srednia rozdzielczosc" (brief, `handout`). */
const HANDOUT_MIN_LONG_EDGE_PX = 400;
const SCENE_ASPECT_MIN = 0.5;
const SCENE_ASPECT_MAX = 2.2;
/** "Mala" (brief, `portrait`) — gorna granica dluzszej krawedzi. */
const PORTRAIT_MAX_LONG_EDGE_PX = 400;
const PORTRAIT_ASPECT_MIN = 0.6;
const PORTRAIT_ASPECT_MAX = 1.1;

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Hash tresci obrazu (wymiary + piksele RGBA) — NIE hash pliku PDF ani objId,
 * tylko faktyczna zdekodowana tresc. Wywolywany PRZEZ WOLAJACEGO (orkiestrator)
 * na KAZDYM obrazie osobno, natychmiast po decode — patrz komentarz na gorze pliku.
 */
export async function computeContentHash(image: DecodedImage): Promise<string> {
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, image.width);
  headerView.setUint32(4, image.height);
  const combined = new Uint8Array(header.length + image.rgba.length);
  combined.set(header, 0);
  combined.set(image.rgba, header.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Odchylenie standardowe luminancji pikseli (0-255) — sygnal "plaska tekstura"
 * vs "prawdziwa ilustracja", patrz `FLAT_TEXTURE_STDDEV_THRESHOLD`. Jeden
 * przebieg, bez alokacji tablicy posrednich probek (wazne dla obrazow do
 * 4096x4096 = ~16M pikseli). Wywolywane PRZEZ WOLAJACEGO, tak jak `computeContentHash`.
 */
export function computeLuminanceStdDev(image: DecodedImage): number {
  const { rgba, width, height } = image;
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lum = 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance);
}

export interface CorrelationClosureResult {
  /** Wpisy juz powiazane przez korelacje pozycyjna (`correlatedWith`, krok 5/6). */
  closedByBBox: number;
  /**
   * Wpisy DODATKOWO powiazane WYLACZNIE przez identyczny `contentHash` — tego
   * korelacja pozycyjna NIE zlapala (np. ten sam zasob osadzony na stronie w
   * innej pozycji/przycieciu niz jego "kanoniczne" wystapienie). MUSI byc
   * ISTOTNIE mniejsze niz `closedByBBox`, inaczej mechanizm z U1 nie dziala
   * (DoD kroku 7).
   */
  closedByHash: number;
  /** `objId` -> kanoniczny `objId` PO uwzglednieniu OBU sygnalow (bbox + hash). */
  canonicalObjIdByObjId: ReadonlyMap<string, string>;
}

/**
 * Domyka korelacje przez `contentHash` tam, gdzie korelacja pozycyjna (bbox)
 * jej nie zlapala — dwa wpisy o tym samym hashu tresci to ten sam zasob,
 * niezaleznie od pozycji. Zwraca TAKZE licznik juz domknietych przez bbox, do
 * porownania skutecznosci obu mechanizmow (brief: "zaraportuj, ile takich
 * przypadkow zostalo").
 */
export function closeCorrelationByHash(entries: readonly { entry: ImageEntry; contentHash: string }[]): CorrelationClosureResult {
  const bboxCanonicalOf = (e: ImageEntry): string => e.correlatedWith ?? e.objId ?? '';
  const closedByBBox = entries.filter(({ entry }) => entry.correlatedWith !== undefined).length;

  const entriesByBBoxCanonical = new Map<string, ImageEntry[]>();
  const byHash = new Map<string, Set<string>>();
  for (const { entry, contentHash } of entries) {
    if (entry.objId === null) continue; // inline: brak objId, nie ma czego korelowac
    const bboxCanonical = bboxCanonicalOf(entry);
    const arr = entriesByBBoxCanonical.get(bboxCanonical) ?? [];
    arr.push(entry);
    entriesByBBoxCanonical.set(bboxCanonical, arr);

    const set = byHash.get(contentHash) ?? new Set<string>();
    set.add(bboxCanonical);
    byHash.set(contentHash, set);
  }

  const totalOccurrences = (bboxCanonical: string): number =>
    (entriesByBBoxCanonical.get(bboxCanonical) ?? []).reduce((sum, e) => sum + e.occurrences.length, 0);

  // bboxCanonical -> nowy kanon PO domknieciu przez hash.
  const canonicalRemap = new Map<string, string>();
  let closedByHash = 0;
  for (const bboxCanonicalSet of byHash.values()) {
    if (bboxCanonicalSet.size <= 1) continue; // bbox juz to domknal (albo tylko jeden kanon w tej grupie hashu)
    const keys = [...bboxCanonicalSet];
    // Kanoniczny = najwiecej LACZNYCH wystapien; remis po kluczu (determinizm, brak zaleznosci od kolejnosci wejscia).
    const canonical = keys.sort((a, b) => totalOccurrences(b) - totalOccurrences(a) || a.localeCompare(b))[0]!;
    for (const key of keys) {
      if (key === canonical) continue;
      canonicalRemap.set(key, canonical);
      closedByHash += (entriesByBBoxCanonical.get(key) ?? []).length;
    }
  }

  const canonicalObjIdByObjId = new Map<string, string>();
  for (const { entry } of entries) {
    if (entry.objId === null) continue;
    const bboxCanonical = bboxCanonicalOf(entry);
    const remapped = canonicalRemap.get(bboxCanonical);
    if (remapped) canonicalObjIdByObjId.set(entry.objId, remapped);
  }

  return { closedByBBox, closedByHash, canonicalObjIdByObjId };
}

export interface TargetKindInput {
  width: number;
  height: number;
  classification: ImageClassification;
  /** Czy w sasiedztwie (ta sama strona) jest blok semantyczny `statblock` lub `heading` (krok 6). */
  nearStatblockOrHeading: boolean;
}

/**
 * Heurystyki DOMYSLNE (brief) — profile fazy 4 je nadpisza. Kolejnosc
 * sprawdzania ma znaczenie: `portrait` (mala + sasiedztwo) jest bardziej
 * specyficzny niz `scene`/`handout` (tylko rozdzielczosc), wiec sprawdzany
 * pierwszy, zeby maly portret w poblizu statbloku nie zostal zlapany przez
 * ogolniejsza regule `handout`.
 */
export function classifyTargetKind(input: TargetKindInput): ImageTargetKind {
  if (input.classification !== 'content') return 'unknown';
  const longEdge = Math.max(input.width, input.height);
  const aspect = input.width / input.height;

  if (input.nearStatblockOrHeading && longEdge <= PORTRAIT_MAX_LONG_EDGE_PX && aspect >= PORTRAIT_ASPECT_MIN && aspect <= PORTRAIT_ASPECT_MAX) {
    return 'portrait';
  }
  if (longEdge >= SCENE_MIN_LONG_EDGE_PX && aspect >= SCENE_ASPECT_MIN && aspect <= SCENE_ASPECT_MAX) {
    return 'scene';
  }
  if (longEdge >= HANDOUT_MIN_LONG_EDGE_PX) {
    return 'handout';
  }
  return 'unknown';
}

/**
 * Wpis gotowy do finalizacji — BEZ surowego `DecodedImage` (patrz komentarz na
 * gorze pliku o budzecie pamieci). `payload` to cokolwiek wolajacy chce
 * przeniesc do wyniku koncowego (typowo `EncodedImage` z `encodeImage.ts`, juz
 * skompresowane bajty WebP/PNG) — `finalizeImages` samo w sobie nie wie ani
 * nie musi wiedziec, czym jest `payload`.
 */
export interface PreparedEntryForFinalize<TPayload> {
  entry: ImageEntry;
  classification: ImageClassification;
  /** [KROK-11 Z4] Patrz `ClassifiedImage.confidence` w `classify.ts`. */
  confidence: number;
  extractSource: ExtractSource;
  contentHash: string;
  width: number;
  height: number;
  /** Patrz `computeLuminanceStdDev`/`FLAT_TEXTURE_STDDEV_THRESHOLD`. Opcjonalne — brak wartosci pomija reklasyfikacje "plaskiej tekstury" (np. w testach jednostkowych bez prawdziwych pikseli). */
  luminanceStdDev?: number;
  /** [KROK-17] Patrz `detectGrid.ts` — sugestia auto-detekcji siatki, `undefined` gdy nie liczona (np. testy) lub gdy `detectGrid` nie znalazlo zadnej okresowosci. */
  suggestedGrid?: GridDetectionResult;
  payload: TPayload;
}

export interface FinalizedImage<TPayload> {
  entry: ImageEntry;
  classification: ImageClassification;
  /** [KROK-11 Z4] Patrz `ClassifiedImage.confidence` w `classify.ts`. */
  confidence: number;
  extractSource: ExtractSource;
  contentHash: string;
  width: number;
  height: number;
  targetKind: ImageTargetKind;
  luminanceStdDev?: number;
  suggestedGrid?: GridDetectionResult;
  payload: TPayload;
}

export interface FinalizeResult<TPayload> {
  images: FinalizedImage<TPayload>[];
  correlationClosedByBBox: number;
  correlationClosedByHash: number;
  duplicatesRemoved: number;
}

/**
 * Krok koncowy: reklasyfikacja po rozmiarze bezwzglednym (odlozona z Z1, patrz
 * `MIN_ABSOLUTE_PX`), domkniecie korelacji przez hash, deduplikacja,
 * klasyfikacja docelowa. `prepared` MUSI byc juz w deterministycznej kolejnosci
 * (np. posortowane po `objId` jak w `imageRegistry.ts`) — reprezentant kazdej
 * grupy duplikatow to PIERWSZY wpis w tej kolejnosci. Czysta funkcja
 * (synchroniczna) — cale kosztowne I/O (decode/hash/encode) juz sie odbylo
 * u wolajacego.
 */
export function finalizeImages<TPayload>(
  prepared: readonly PreparedEntryForFinalize<TPayload>[],
  nearStatblockOrHeadingByObjId: ReadonlySet<string>,
  // [KROK-43 Z1] Opcjonalny — wolajacy bez potrzeby diagnostyk (np. istniejace
  // testy jednostkowe) dostaje dokladnie zachowanie sprzed tej flagi.
  diagnostics: Diagnostic[] = [],
): FinalizeResult<TPayload> {
  // [KROK-11 Z4] Reklasyfikacja "plaskiej tekstury" ponizej jest TWARDYM,
  // jednoznacznym sygnalem (zmierzone stddev luminancji, dziala WYLACZNIE na
  // juz-slabym `content` — patrz `FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`) —
  // dostaje wysoka pewnosc, NIE dziedziczy starej pewnosci `content` sprzed
  // reklasyfikacji (juz nieaktualnej, bo klasyfikacja sie zmienila).
  const RECLASSIFIED_CONFIDENCE = 0.9;
  const reclassified = prepared.map((d) => {
    if (d.classification === 'content' && (d.width < MIN_ABSOLUTE_PX || d.height < MIN_ABSOLUTE_PX)) {
      diagnostics.push({
        severity: 'info',
        code: 'IMAGE_TOO_SMALL_UNDECIDED',
        params: { width: d.width, height: d.height, threshold: MIN_ABSOLUTE_PX },
        pageNumber: d.entry.occurrences[0]?.page,
      });
      return { ...d, classification: 'undecided' as ImageClassification, confidence: TOO_SMALL_UNDECIDED_CONFIDENCE };
    }
    // [KROK-8 Z2] Plaska tekstura (np. tlo z papieru) — powierzchnia/proporcje same
    // w sobie NIE odrozniaja jej od prawdziwej ilustracji, patrz komentarz przy
    // `FLAT_TEXTURE_STDDEV_THRESHOLD`. [KROK-17] WYLACZNIE dla SLABEGO sygnalu
    // `content` — patrz `FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`.
    if (
      d.classification === 'content' &&
      d.confidence < FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE &&
      d.luminanceStdDev !== undefined &&
      d.luminanceStdDev < FLAT_TEXTURE_STDDEV_THRESHOLD
    ) {
      return { ...d, classification: 'decoration' as ImageClassification, confidence: RECLASSIFIED_CONFIDENCE };
    }
    return d;
  });

  const closure = closeCorrelationByHash(reclassified.map((d) => ({ entry: d.entry, contentHash: d.contentHash })));

  const canonicalKeyOf = new Map<ImageEntry, string>();
  reclassified.forEach((d, i) => {
    if (d.entry.objId === null) {
      canonicalKeyOf.set(d.entry, `__inline_${i}__`);
      return;
    }
    const afterHash = closure.canonicalObjIdByObjId.get(d.entry.objId);
    canonicalKeyOf.set(d.entry, afterHash ?? d.entry.correlatedWith ?? d.entry.objId);
  });

  const groups = new Map<string, typeof reclassified>();
  for (const d of reclassified) {
    const key = canonicalKeyOf.get(d.entry)!;
    const arr = groups.get(key) ?? [];
    arr.push(d);
    groups.set(key, arr);
  }

  let duplicatesRemoved = 0;
  const images: FinalizedImage<TPayload>[] = [];
  for (const group of groups.values()) {
    const representative = group[0]!;
    duplicatesRemoved += group.length - 1;
    const targetKind = classifyTargetKind({
      width: representative.width,
      height: representative.height,
      classification: representative.classification,
      nearStatblockOrHeading: representative.entry.objId !== null && nearStatblockOrHeadingByObjId.has(representative.entry.objId),
    });
    images.push({ ...representative, targetKind });
  }

  return {
    images,
    correlationClosedByBBox: closure.closedByBBox,
    correlationClosedByHash: closure.closedByHash,
    duplicatesRemoved,
  };
}
