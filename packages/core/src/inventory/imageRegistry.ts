import { clusterByOverlap } from '../clustering.js';
import { groupByQuantizedPosition } from '../collections.js';
import type { Rect } from '../geometry.js';
import { overlapRatio, relativeArea as computeRelativeArea } from '../geometry.js';
import type { WalkEvent } from './walkOperators.js';

/**
 * Rejestr obrazow — objId -> wystapienia na stronach, dowod maski, klaster
 * (MDD faza 3, F0 Q2/Q3, KROK-4 Z3). Klasyfikacja tresc/dekoracja NALEZY DO
 * FAZY 3 — ten modul tylko zbiera fakty (pageRefs, maskEvidence, clusterId),
 * nigdy nie decyduje.
 */

/**
 * Trzy niezalezne sciezki dowodowe na maske — pojedyncza ma luke:
 * - 'group'    — obraz wewnatrz beginGroup/Luminosity. Najsilniejszy dowod, ufaj bezwarunkowo.
 * - 'opcode'   — paintImageMaskXObject (83). Jednoznaczne z definicji formatu PDF.
 * - 'geometry' — bbox pokrywa sie >=95% z obrazem narysowanym index<=3 wczesniej.
 *                Slaby dowod (moze byc tez zwykly duplikat) — nigdy nie zwijaj do boolean.
 */
export type MaskEvidence = 'group' | 'opcode' | 'geometry' | null;

export interface ImageOccurrence {
  page: number;
  bbox: Rect;
  index: number;
}

export interface ImageEntry {
  objId: string | null;
  /** Ten sam zasob moze byc rysowany wielokrotnie (na jednej lub wielu stronach). */
  occurrences: ImageOccurrence[];
  /** Unikalne numery stron. */
  pageRefs: number[];
  /** Najwiekszy bbox/powierzchnia-strony ze wszystkich wystapien. */
  maxRelativeArea: number;
  isMaskLayer: boolean;
  maskEvidence: MaskEvidence;
  masksImageObjId?: string;
  clusterId?: string;
  /**
   * [KROK-16 Z1] Rozdzielczosc wewnetrzna z PIERWSZEGO wystapienia, ktore ja
   * niesie (patrz `WalkEvent['image'].intrinsicWidth/Height`). `null` gdy
   * zaden opcode w tym wpisie jej nie dostarczyl (repeat/inline). Uzywana
   * jako dodatkowy skladnik klucza w `correlateImagesByBBox` — dwa rozne
   * obrazy w tej samej ramce strony maja niemal na pewno rozna rozdzielczosc
   * zasobu, mimo identycznego bboksa na stronie.
   */
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
  /**
   * [KROK-5 Z6, dlug z KROK-4] `objId` innego wpisu, z ktorym ten wpis zostal
   * POWIAZANY pozycyjnie (skwantowany bbox, patrz `correlateImagesByBBox`) —
   * najprawdopodobniej TEN SAM zasob PDF, ktory pdf.js rozdzielil na osobne
   * wpisy bo nie przydziela stabilnego objId od pierwszego uzycia (RAPORT-KROK-4.md).
   * NIE nadpisuje `pageRefs` — to osobny, jawny fakt korelacyjny, nie zmiana
   * tozsamosci; klasyfikacja tego, co z tym zrobic, nalezy do fazy 3.
   */
  correlatedWith?: string;
}

const OPCODE_PAINT_IMAGE_MASK_XOBJECT = 83;
const GEOMETRY_OVERLAP_THRESHOLD = 0.95;
const GEOMETRY_INDEX_WINDOW = 3;

interface RawOccurrence extends ImageOccurrence {
  objId: string | null;
  opcode: number;
  groupSubtype: string | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
}

/** Wejscie: eventy 'image' z walkOperators dla JEDNEJ strony, w kolejnosci wystapienia. */
export interface PageImageEvents {
  page: number;
  pageBox: Rect;
  events: readonly WalkEvent[];
}

function collectRawOccurrences(pages: readonly PageImageEvents[]): { page: number; occ: RawOccurrence }[] {
  const all: { page: number; occ: RawOccurrence }[] = [];
  for (const { page, events } of pages) {
    for (const e of events) {
      if (e.type !== 'image') continue;
      all.push({
        page,
        occ: {
          page,
          bbox: e.bbox,
          index: e.index,
          objId: e.objId,
          opcode: e.opcode,
          groupSubtype: e.inGroup?.subtype ?? null,
          intrinsicWidth: e.intrinsicWidth,
          intrinsicHeight: e.intrinsicHeight,
        },
      });
    }
  }
  return all;
}


/**
 * Ile kolejnych wystapien NA TEJ SAMEJ STRONIE przeszukac w poszukiwaniu
 * tresci narysowanej POD maska (dowod 'group'/'opcode') — miedzy zamknieciem
 * grupy maski a faktycznym namalowaniem zamaskowanej tresci moze wystapic kilka
 * innych, niepowiazanych operatorow (np. `setGState`), wiec nie zawsze jest to
 * NASTEPNY wprost element.
 */
const GROUP_MASK_SEARCH_WINDOW = 5;

/**
 * [KROK-7, odkrycie] `masksImageObjId` byl ustawiany WYLACZNIE przez sciezke
 * 'geometry' (najslabszy dowod) — sciezki 'group'/'opcode' (NAJSILNIEJSZY
 * dowod) nigdy nie zapisywaly, KTORY obraz jest maskowany, bo `beginGroup`
 * opakowuje WYLACZNIE wlasna tresc formy maski (MDD), nie zamaskowany obraz —
 * nie ma zadnego bezposredniego powiazania w operator liscie. Bez tego Z2
 * (strategia ekstrakcji, krok 7) nigdy nie wykrywal `isMasked=true` dla
 * NAJPEWNIEJSZEGO przypadku masek (jawny `beginGroup`/`Luminosity`), tylko dla
 * najslabszego. Naprawa: geometryczne dopasowanie (jak sciezka 'geometry'),
 * ale szukajace W PRZOD (tresc jest malowana PO zamknieciu grupy maski, nie
 * przed) — bbox formy maski (po naprawie CTM z Z4, patrz walkOperators.ts)
 * pokrywa sie z bboxem zamaskowanej tresci, bo obie dziedzicza te sama
 * macierz zewnetrznego `cm` w momencie wywolania `gs`.
 */
function findMaskedContentObjId(occurrences: readonly RawOccurrence[], indices: readonly number[], pos: number, maskOcc: RawOccurrence): string | undefined {
  for (let fwd = 1; fwd <= GROUP_MASK_SEARCH_WINDOW; fwd++) {
    const nextPos = pos + fwd;
    if (nextPos >= indices.length) break;
    const nextOcc = occurrences[indices[nextPos]!]!;
    if (nextOcc.objId === maskOcc.objId) continue;
    if (overlapRatio(nextOcc.bbox, maskOcc.bbox) >= GEOMETRY_OVERLAP_THRESHOLD) return nextOcc.objId ?? undefined;
  }
  return undefined;
}

/** Wykrywa dowod maski dla kazdego wystapienia (sciezki group/opcode/geometry, w tej kolejnosci sily). */
function detectMaskEvidence(
  occurrences: readonly RawOccurrence[],
): { evidence: MaskEvidence; masksObjId?: string }[] {
  const results: { evidence: MaskEvidence; masksObjId?: string }[] = occurrences.map(() => ({ evidence: null }));

  // Grupuj indeksy per strona, w kolejnosci `index` rosnaco — potrzebne dla sciezki geometry.
  const byPage = new Map<number, number[]>();
  occurrences.forEach((o, i) => {
    const arr = byPage.get(o.page) ?? [];
    arr.push(i);
    byPage.set(o.page, arr);
  });
  for (const indices of byPage.values()) {
    indices.sort((a, b) => occurrences[a]!.index - occurrences[b]!.index);
  }

  for (const [, indices] of byPage) {
    for (let pos = 0; pos < indices.length; pos++) {
      const i = indices[pos]!;
      const occ = occurrences[i]!;

      // Sciezka 1 — group (najsilniejszy dowod).
      if (occ.groupSubtype === 'Luminosity') {
        results[i] = { evidence: 'group', masksObjId: findMaskedContentObjId(occurrences, indices, pos, occ) };
        continue;
      }
      // Sciezka 2 — opcode (jednoznaczne).
      if (occ.opcode === OPCODE_PAINT_IMAGE_MASK_XOBJECT) {
        results[i] = { evidence: 'opcode', masksObjId: findMaskedContentObjId(occurrences, indices, pos, occ) };
        continue;
      }
      // Sciezka 3 — geometry (slaby dowod): obraz narysowany index<=3 WCZESNIEJ
      // na tej samej stronie z bbox pokrywajacym sie >=95%.
      for (let back = 1; back <= GEOMETRY_INDEX_WINDOW; back++) {
        const prevPos = pos - back;
        if (prevPos < 0) break;
        const prevIdx = indices[prevPos]!;
        const prevOcc = occurrences[prevIdx]!;
        if (occ.index - prevOcc.index > GEOMETRY_INDEX_WINDOW) break;
        if (overlapRatio(occ.bbox, prevOcc.bbox) >= GEOMETRY_OVERLAP_THRESHOLD) {
          results[i] = { evidence: 'geometry', masksObjId: prevOcc.objId ?? undefined };
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Buduje rejestr obrazow z eventow `walkOperators` zebranych ze WSZYSTKICH stron
 * dokumentu. Zero dekodowania obrazow — wylacznie fakty geometryczne/strukturalne.
 */
export function buildImageEntries(pages: readonly PageImageEvents[]): ImageEntry[] {
  const rawList = collectRawOccurrences(pages);
  const occurrences = rawList.map((r) => r.occ);
  const clusterIdByOccurrence = clusterByOverlap(
    occurrences,
    (o) => o.page,
    (o) => o.bbox,
  );
  const maskInfo = detectMaskEvidence(occurrences);
  const pageBoxByPage = new Map(pages.map((p) => [p.page, p.pageBox]));

  // Klucz grupowania: objId, gdy dostepny; w przeciwnym razie kazde wystapienie
  // inline jest samo w sobie osobnym wpisem (brak referencji obiektu do korelacji).
  const entriesByKey = new Map<string, ImageEntry>();
  let inlineCounter = 0;

  occurrences.forEach((occ, i) => {
    const key = occ.objId ?? `__inline_${inlineCounter++}__`;
    let entry = entriesByKey.get(key);
    if (!entry) {
      entry = {
        objId: occ.objId,
        occurrences: [],
        pageRefs: [],
        maxRelativeArea: 0,
        isMaskLayer: false,
        maskEvidence: null,
        intrinsicWidth: null,
        intrinsicHeight: null,
      };
      entriesByKey.set(key, entry);
    }

    entry.occurrences.push({ page: occ.page, bbox: occ.bbox, index: occ.index });

    // Pierwsze wystapienie niosace rozdzielczosc wewnetrzna wystarcza — ten sam
    // objId zawsze odnosi sie do tego samego zasobu, wiec kolejne wystapienia
    // niosa (przy okazji) te sama wartosc.
    if (entry.intrinsicWidth === null && occ.intrinsicWidth !== null) entry.intrinsicWidth = occ.intrinsicWidth;
    if (entry.intrinsicHeight === null && occ.intrinsicHeight !== null) entry.intrinsicHeight = occ.intrinsicHeight;

    const pageBox = pageBoxByPage.get(occ.page);
    if (pageBox) {
      const ra = computeRelativeArea(occ.bbox, pageBox);
      if (ra > entry.maxRelativeArea) entry.maxRelativeArea = ra;
    }

    const evidence = maskInfo[i]!;
    // 'group' > 'opcode' > 'geometry' > null — jesli entry ma juz mocniejszy dowod
    // z innego wystapienia, nie nadpisuj go slabszym.
    const strength: Record<Exclude<MaskEvidence, null>, number> = { group: 3, opcode: 2, geometry: 1 };
    const currentStrength = entry.maskEvidence ? strength[entry.maskEvidence] : 0;
    const newStrength = evidence.evidence ? strength[evidence.evidence] : 0;
    if (newStrength > currentStrength) {
      entry.maskEvidence = evidence.evidence;
      entry.isMaskLayer = evidence.evidence === 'group' || evidence.evidence === 'opcode';
      if (evidence.masksObjId) entry.masksImageObjId = evidence.masksObjId;
    }

    if (!entry.clusterId) entry.clusterId = clusterIdByOccurrence.get(occ);
  });

  for (const entry of entriesByKey.values()) {
    entry.pageRefs = [...new Set(entry.occurrences.map((o) => o.page))].sort((a, b) => a - b);
  }

  const sorted = [...entriesByKey.values()].sort((a, b) => (a.objId ?? '').localeCompare(b.objId ?? ''));
  return correlateImagesByBBox(sorted);
}

/** Kwantyzacja do 0.5pt — naglowki biegnace/stopki/ramki sa z definicji nieruchome, wiec drobny szum zaokraglenia to jedyna tolerancja potrzebna. */
const CORRELATION_QUANTIZE_PT = 0.5;

function quantize(v: number): number {
  return Math.round(v / CORRELATION_QUANTIZE_PT) * CORRELATION_QUANTIZE_PT;
}

function quantizedBBoxKey(bbox: Rect): string {
  return `${quantize(bbox.minX)}|${quantize(bbox.minY)}|${quantize(bbox.maxX)}|${quantize(bbox.maxY)}`;
}

/**
 * [KROK-16 Z1] Rozdzielczosc wewnetrzna dopisana do klucza — patrz odkrycie w
 * RAPORT-KROK-15.md (grupa o 148 skorelowanych stronach mieszajaca etykiety
 * useful/fragment/decoration). Hipoteza: to nie jeden zasob powtorzony 148 razy,
 * tylko wspolna RAMKA (ten sam prostokat na stronie) z rozna zawartoscia w
 * srodku — korelacja pozycyjna sama nie odroznia tych przypadkow. Ten sam
 * zasob PDF ma zawsze identyczna rozdzielczosc wewnetrzna; rozne ilustracje w
 * tej samej ramce prawie nigdy. Brak danych (`null`) traktowany jako WLASNA
 * kategoria (`*x*`), nie jako "brak ograniczenia" — wpisy bez rozdzielczosci
 * korelujemy tylko ze soba nawzajem, nigdy z wpisami, ktore ja maja, zeby nie
 * cofnac ostroznosci ponizej stanu sprzed tej zmiany.
 */
function intrinsicSizeKey(entry: ImageEntry): string {
  const w = entry.intrinsicWidth;
  const h = entry.intrinsicHeight;
  return `${w ?? '*'}x${h ?? '*'}`;
}

/**
 * [KROK-30, zmierzony na zywo blad "Zew Cthulhu 7ed. Wrak.pdf"] Obraz
 * pokrywajacy PRAWIE CALA strone ma bbox niemal IDENTYCZNY z MediaBox
 * WLASNEJ strony NIEZALEZNIE OD TEGO, CO FAKTYCZNIE PRZEDSTAWIA — w
 * odroznieniu od malego, KONKRETNIE pozycjonowanego elementu (logo w rogu,
 * ramka-dzielnik), gdzie "ta sama pozycja na wielu stronach" jest realnym,
 * zaskakujacym sygnalem wspolnej tozsamosci (dokladnie cel tej funkcji —
 * patrz komentarz ponizej). Dla pelnostronicowego spadu ta koincydencja jest
 * GWARANTOWANA geometria, nie dowodem.
 *
 * Zmierzone wprost: unikalna okladka (str. 1, gigant kosmicznego horroru nad
 * statkiem) i OSOBNO OSADZONE, zupelnie inne teksturowane tlo kazdej
 * kolejnej strony maja WLASNE, ROZNE piksele (potwierdzone wizualnie), ale
 * IDENTYCZNY bbox (cala strona) I nawet identyczna rozdzielczosc wewnetrzna
 * (eksport z narzedzia DTP do jednego szablonowego rozmiaru platna) — bez
 * tego wykluczenia korelacja mylila 30 z 35 obrazow ksiazki w "dwa
 * powtarzajace sie zasoby", zaniżajac `content` do zera na calym dokumencie.
 * Wykluczone CALKOWICIE z tego mechanizmu — korelacja zostaje dla mniejszych,
 * faktycznie pozycjonowanych elementow (jej udokumentowany cel ponizej).
 * Deduplikacja PRAWDZIWIE identycznych pelnostronicowych obrazow (rzeczywiscie
 * ten sam zasob) nadal dziala pozniej, w fazie ekstrakcji, przez
 * `closeCorrelationByHash` (`finalize.ts`) — TEN mechanizm porownuje
 * faktyczna tresc po dekodowaniu, wiec nie cierpi na te sama slepote
 * geometryczna.
 */
const FULL_PAGE_AREA_THRESHOLD = 0.97;

/**
 * Powiazuje wpisy, ktorych PIERWSZE wystapienie ma identyczny (po kwantyzacji)
 * bbox ORAZ identyczna rozdzielczosc wewnetrzna — bez dekodowania pikseli
 * (KROK-5 Z6.2, rozszerzone KROK-16 Z1, zawezone KROK-30 — patrz
 * `FULL_PAGE_AREA_THRESHOLD` powyzej). Zero-decode, wiec to nadal
 * PRZYBLIZENIE: dwie rozne, male ikony powtarzajace sie w tej samej pozycji I
 * o tej samej rozdzielczosci (np. znaczniki wypunktowania) daja falszywe
 * powiazanie — akceptowalne dla naglowkow/stopek/ramek (cel tego zadania),
 * ale klasyfikacja "czy to naprawde ten sam zasob" nadal nalezy do fazy 3
 * (por. `masksImageObjId`, tez tylko sugestia).
 */
export function correlateImagesByBBox(entries: readonly ImageEntry[]): ImageEntry[] {
  const correlatable = entries.filter((entry) => entry.objId !== null && entry.occurrences.length > 0 && entry.maxRelativeArea < FULL_PAGE_AREA_THRESHOLD);
  const groups = groupByQuantizedPosition(
    correlatable,
    (entry) => `${quantizedBBoxKey(entry.occurrences[0]!.bbox)}|${intrinsicSizeKey(entry)}`,
  );

  const canonicalObjIdByObjId = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Kanoniczny = najwiecej wystapien; remis rozstrzygniety po objId (determinizm, brak zaleznosci od kolejnosci wejscia).
    const canonical = [...group].sort(
      (a, b) => b.occurrences.length - a.occurrences.length || a.objId!.localeCompare(b.objId!),
    )[0]!;
    for (const entry of group) {
      if (entry.objId !== canonical.objId) canonicalObjIdByObjId.set(entry.objId!, canonical.objId!);
    }
  }

  if (canonicalObjIdByObjId.size === 0) return [...entries];
  return entries.map((entry) => {
    const correlatedWith = entry.objId ? canonicalObjIdByObjId.get(entry.objId) : undefined;
    return correlatedWith ? { ...entry, correlatedWith } : entry;
  });
}
