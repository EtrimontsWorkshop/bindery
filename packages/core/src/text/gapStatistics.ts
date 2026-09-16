import { groupByQuantizedPosition } from '../collections.js';
import { axisPositions, baselineTolerance, computeStreamAngle, fontSizeFromTransform } from '../layout/textGeometry.js';

/**
 * Statystyka odstepow miedzy itemami per klucz fontu (KROK-5 Z2) — "enabler"
 * calego kroku (zalozenie A8: nie da sie tego policzyc na jednej stronie).
 *
 * Metoda znajdowania doliny: **histogram z wygladzaniem (srednia ruchoma) +
 * jawna detekcja dwoch najwyzszych szczytow i doliny miedzy nimi**. Wybrana
 * PO odrzuceniu Otsu (1979): kalibracja na syntetycznych rozkladach (patrz
 * RAPORT-KROK-5.md) wykazala, ze eta Otsu (stosunek wariancji miedzyklasowej
 * do calkowitej) NIE jest miara bimodalnosci — nawet czysto jednomodalny,
 * szeroki rozklad jednostajny dostaje eta ~0.75 (bo Otsu zawsze znajduje
 * "najlepszy mozliwy" podzial dwuklasowy, niezaleznie od tego, czy realna
 * dolina istnieje). Odrzucono tez k-means (iteracyjny, wrazliwy na
 * inicjalizacje, niedeterministyczny bez ustalonego ziarna). Jawna detekcja
 * szczytow + doliny miedzy nimi daje separation=0 gdy szczyt jest tylko jeden
 * (prawdziwie jednomodalny rozklad), zgodnie z wymaganiem briefu.
 */

export interface GapSample {
  fontKey: string;
  /** Odstep poziomy (wzdluz kierunku czytania) miedzy koncem poprzedniego a poczatkiem kolejnego itemu, w pt. */
  gap: number;
  /** [KROK-6 Z1a] Numer strony pochodzenia probki — enabler profilu stronicowego. */
  page: number;
}

export interface FontGapProfile {
  fontKey: string;
  /** Odstep PONIZEJ (scisle) tego progu -> ten sam wyraz. */
  intraWordThreshold: number;
  /** Odstep POWYZEJ tego progu -> osobne wyrazy. Miedzy progami: strefa niepewnosci, NIGDY nie scalaj (P1). */
  interWordThreshold: number;
  /** Jakosc rozdzielenia modow (eta Otsu, 0-1). Niska = rozklad jednomodalny. */
  separation: number;
  sampleCount: number;
  /** false gdy sampleCount ponizej progu LUB separation ponizej progu ufnosci — Z4 warunek #6 wymaga true do scalania. */
  reliable: boolean;
}

const MIN_SAMPLE_COUNT = 50;
const MIN_SEPARATION = 0.3;
/** Margines +/-15% wokol znalezionej doliny — strefa bezpieczenstwa (P1: nigdy nie scalaj na granicy niepewnosci). */
const VALLEY_MARGIN_RATIO = 0.15;
/** Wartosci zapasowe z briefu: 0.25x rozmiar fontu dla progu wewnatrzwyrazowego. */
const FALLBACK_INTRA_RATIO = 0.25;
const FALLBACK_INTER_RATIO = 0.6;
const HISTOGRAM_BINS = 48;

export interface GapAwareItem {
  fontKey: string;
  transform: readonly number[];
  width: number;
}

/**
 * Zbiera probki odstepow z itemow JEDNEJ strony (juz po higienie — bez itemow
 * bialoznakowych, patrz Z1). Grupuje po (kat, przyblizona pozycja cross-axis),
 * sortuje wzdluz kierunku czytania, liczy odstepy miedzy KONCEM poprzedniego a
 * POCZATKIEM kolejnego itemu. Odstep przypisany do klucza fontu itemu
 * POPRZEDZAJACEGO (wlasciwosc jego metryki/kerningu).
 */
export function collectGapSamples(items: readonly GapAwareItem[], page: number): GapSample[] {
  const groups = groupByQuantizedPosition(items, (item) => {
    const angle = computeStreamAngle(item.transform);
    const cross = axisPositions(item.transform, angle).cross;
    const tolerance = baselineTolerance(fontSizeFromTransform(item.transform));
    return `${angle}|${Math.round(cross / tolerance)}`;
  });

  const samples: GapSample[] = [];
  for (const arr of groups.values()) {
    const withAxis = arr.map((item) => {
      const angle = computeStreamAngle(item.transform);
      return { item, along: axisPositions(item.transform, angle).along };
    });
    withAxis.sort((a, b) => a.along - b.along);
    for (let i = 1; i < withAxis.length; i++) {
      const prev = withAxis[i - 1]!;
      const curr = withAxis[i]!;
      const gap = curr.along - (prev.along + prev.item.width);
      if (gap >= 0) samples.push({ fontKey: prev.item.fontKey, gap, page });
    }
  }
  return samples;
}

interface ValleyResult {
  threshold: number;
  separation: number;
}

/** Ile binow szerokosci minimum musza dzielic dwa szczyty, zeby liczyc je jako odrebne mody (nie szum kwantyzacji). */
const MIN_PEAK_SEPARATION_BINS = 3;

function buildHistogram(values: readonly number[], bins: number, binWidth: number): number[] {
  const histogram = new Array<number>(bins).fill(0);
  for (const v of values) {
    const bin = Math.min(bins - 1, Math.floor(v / binWidth));
    histogram[bin]!++;
  }
  return histogram;
}

/** Wygladzenie srednia ruchoma szerokosci 3 — tlumi szum pojedynczych binow bez zakladania konkretnego ksztaltu rozkladu. */
function smooth(histogram: readonly number[]): number[] {
  return histogram.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(histogram.length - 1, i + 1);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += histogram[j]!;
    return sum / (hi - lo + 1);
  });
}

/** Lokalne maksima (>= obu sasiadow, > 0), posortowane malejaco wg wysokosci. */
function findPeaks(histogram: readonly number[]): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < histogram.length; i++) {
    const h = histogram[i]!;
    if (h <= 0) continue;
    const prev = i > 0 ? histogram[i - 1]! : -Infinity;
    const next = i < histogram.length - 1 ? histogram[i + 1]! : -Infinity;
    if (h >= prev && h >= next) peaks.push(i);
  }
  return peaks.sort((a, b) => histogram[b]! - histogram[a]!);
}

/**
 * Znajduje dolina miedzy dwoma najwyzszymi, wystarczajaco odleglymi szczytami
 * wygladzonego histogramu. Brak dwoch odrebnych szczytow -> separation=0
 * (rozklad jednomodalny, brief §Z2: "niska separation = rozklad jednomodalny").
 */
function findValley(values: readonly number[]): ValleyResult {
  const max = Math.max(...values);
  if (max <= 0 || values.length === 0) return { threshold: 0, separation: 0 };

  const binWidth = max / HISTOGRAM_BINS || 1;
  const raw = buildHistogram(values, HISTOGRAM_BINS, binWidth);
  const histogram = smooth(raw);
  const peaks = findPeaks(histogram);

  if (peaks.length < 2) return { threshold: max / 2, separation: 0 };

  // Najwyzszy szczyt + najwyzszy INNY szczyt odlegly o >= MIN_PEAK_SEPARATION_BINS binow.
  const first = peaks[0]!;
  const second = peaks.slice(1).find((p) => Math.abs(p - first) >= MIN_PEAK_SEPARATION_BINS);
  if (second === undefined) return { threshold: max / 2, separation: 0 };

  const lo = Math.min(first, second);
  const hi = Math.max(first, second);
  let valleyBin = lo;
  for (let i = lo; i <= hi; i++) {
    if (histogram[i]! < histogram[valleyBin]!) valleyBin = i;
  }

  const peakHeight = Math.min(histogram[lo]!, histogram[hi]!);
  const separation = peakHeight > 0 ? Math.max(0, Math.min(1, 1 - histogram[valleyBin]! / peakHeight)) : 0;
  return { threshold: (valleyBin + 0.5) * binWidth, separation };
}

function fallbackProfile(fontKey: string, size: number, sampleCount: number): FontGapProfile {
  return {
    fontKey,
    intraWordThreshold: size * FALLBACK_INTRA_RATIO,
    interWordThreshold: size * FALLBACK_INTER_RATIO,
    separation: 0,
    sampleCount,
    reliable: false,
  };
}

/**
 * Buduje profil odstepow per klucz fontu z probek zebranych z CALEGO dokumentu.
 * `fontSizeByKey` (z InventoryResult.fonts) zasila wartosc zapasowa, gdy
 * probek jest za malo LUB rozklad jest jednomodalny (Z2 zabezpieczenia).
 * Nigdy nie ekstrapoluje profilu jednego fontu na inny — brak wpisu w
 * `fontSizeByKey` dla klucza bez probek daje fallback z rozmiarem 1 (ostatnia
 * deska ratunku, zawsze reliable=false).
 */
/** Buduje jeden profil z tablicy odstepow juz przypisanych do jednego klucza fontu — rdzen wspoldzielony przez poziom dokumentu i poziom strony (Z1a). */
function profileFromGaps(fontKey: string, gaps: readonly number[], size: number): FontGapProfile {
  if (gaps.length < MIN_SAMPLE_COUNT) {
    return fallbackProfile(fontKey, size, gaps.length);
  }
  const { threshold, separation } = findValley(gaps);
  if (separation < MIN_SEPARATION) {
    return { ...fallbackProfile(fontKey, size, gaps.length), separation };
  }
  return {
    fontKey,
    intraWordThreshold: threshold * (1 - VALLEY_MARGIN_RATIO),
    interWordThreshold: threshold * (1 + VALLEY_MARGIN_RATIO),
    separation,
    sampleCount: gaps.length,
    reliable: true,
  };
}

function groupGapsByFont(samples: readonly GapSample[]): Map<string, number[]> {
  const byFont = new Map<string, number[]>();
  for (const s of samples) {
    const arr = byFont.get(s.fontKey);
    if (arr) arr.push(s.gap);
    else byFont.set(s.fontKey, [s.gap]);
  }
  return byFont;
}

/**
 * Buduje profil odstepow per klucz fontu z probek zebranych z CALEGO dokumentu.
 * `fontSizeByKey` (z InventoryResult.fonts) zasila wartosc zapasowa, gdy
 * probek jest za malo LUB rozklad jest jednomodalny (Z2 zabezpieczenia).
 * Nigdy nie ekstrapoluje profilu jednego fontu na inny — brak wpisu w
 * `fontSizeByKey` dla klucza bez probek daje fallback z rozmiarem 1 (ostatnia
 * deska ratunku, zawsze reliable=false).
 */
export function buildFontGapProfiles(
  samples: readonly GapSample[],
  fontSizeByKey: ReadonlyMap<string, number>,
): Map<string, FontGapProfile> {
  const byFont = groupGapsByFont(samples);
  const profiles = new Map<string, FontGapProfile>();
  const allKeys = new Set<string>([...byFont.keys(), ...fontSizeByKey.keys()]);
  for (const fontKey of allKeys) {
    profiles.set(fontKey, profileFromGaps(fontKey, byFont.get(fontKey) ?? [], fontSizeByKey.get(fontKey) ?? 1));
  }
  return profiles;
}

/**
 * [KROK-6 Z1a] Profil hierarchiczny: dokumentowy + per-strona. Naprawia
 * systematyczny blad z KROK-5 (RAPORT-KROK-5.md): strony o gestym, nietypowym
 * ukladzie (spisy tresci) maja WLASNY, ciasniejszy rozklad odstepow, ktory
 * profil dokumentowy (usredniony po calym pliku, w tym po akapitach o innej
 * geometrii) nie wychwytuje. Bez zadnej wiedzy o semantyce strony — czysto
 * geometryczne, per-strona statystyki tego samego mechanizmu co poziom
 * dokumentu.
 */
export interface HierarchicalGapProfile {
  fontKey: string;
  document: FontGapProfile;
  /** Profil TYLKO dla stron z wystarczajaca liczba probek (>= MIN_PAGE_SAMPLE_COUNT) — brak wpisu = brak wlasnego profilu tej strony dla tego fontu. */
  byPage: Map<number, FontGapProfile>;
}

/**
 * Prog probek na poziomie STRONY, nizszy niz dokumentowy (MIN_SAMPLE_COUNT=50).
 * Pojedyncza strona z natury ma mniej probek niz caly dokument — wymaganie tego
 * samego progu co dla calego dokumentu praktycznie uniemozliwiloby powstanie
 * jakiegokolwiek profilu stronicowego (zweryfikowane empirycznie na
 * Cienie_posrod_mgie.pdf str. 3: 32 probki dla fontu spisu tresci, ponizej 50,
 * ale to JUZ POLOWA wszystkich wystapien tego fontu w calym dokumencie — brief
 * "nie zgaduj z kilku probek" dotyczy garstki probek, nie tego przypadku).
 */
const MIN_PAGE_SAMPLE_COUNT = 20;

export function buildHierarchicalGapProfiles(
  samples: readonly GapSample[],
  fontSizeByKey: ReadonlyMap<string, number>,
): Map<string, HierarchicalGapProfile> {
  const documentProfiles = buildFontGapProfiles(samples, fontSizeByKey);

  const samplesByPage = new Map<number, GapSample[]>();
  for (const s of samples) {
    const arr = samplesByPage.get(s.page);
    if (arr) arr.push(s);
    else samplesByPage.set(s.page, [s]);
  }

  const hierarchical = new Map<string, HierarchicalGapProfile>();
  for (const [fontKey, document] of documentProfiles) {
    hierarchical.set(fontKey, { fontKey, document, byPage: new Map() });
  }

  for (const [page, pageSamples] of samplesByPage) {
    const byFontOnPage = groupGapsByFont(pageSamples);
    for (const [fontKey, gaps] of byFontOnPage) {
      // [Wymog Z1a] Ponizej progu probek na TEJ stronie -> nie zgaduj, brak wpisu (uzyj wylacznie profilu dokumentowego).
      if (gaps.length < MIN_PAGE_SAMPLE_COUNT) continue;
      const size = fontSizeByKey.get(fontKey) ?? 1;
      // Zaakceptuj profil strony NAWET gdy nie jest "reliable" (brak wyraznej doliny) —
      // fallback (0.25x rozmiar) to nadal legalny, konserwatywny szacunek "z tej strony",
      // nie zgadywanie z garstki probek (mamy juz >= MIN_PAGE_SAMPLE_COUNT). To wlasnie
      // ten przypadek pozwala gestym stronom (spis tresci) "obronic sie samemu" (brief Z1a) —
      // ich rozklad czesto nie ma czystej doliny bimodalnej, bo WSZYSTKIE obserwowane
      // odstepy sa juz miedzy-pozycyjne (kazda pozycja spisu to jeden Tj, brak fragmentacji
      // wewnatrz), wiec fallback jest tu WLASCIWYM, nie zastepczym, oszacowaniem.
      const pageProfile = profileFromGaps(fontKey, gaps, size);
      hierarchical.get(fontKey)?.byPage.set(page, pageProfile);
    }
  }

  return hierarchical;
}

/**
 * Efektywny profil do scalania na danej stronie: gdy strona ma WLASNY
 * wiarygodny profil dla tego fontu, uzywa BARDZIEJ ZACHOWAWCZEGO (mniejszego)
 * z dwoch progow wewnatrzwyrazowych — dokumentowego i stronicowego. W
 * przeciwnym razie (za malo probek na tej stronie, brief Z1a) uzywa wylacznie
 * profilu dokumentowego.
 */
export function effectiveGapProfileForPage(hierarchical: HierarchicalGapProfile, page: number): FontGapProfile {
  const pageProfile = hierarchical.byPage.get(page);
  if (!pageProfile) return hierarchical.document;
  if (!hierarchical.document.reliable) return pageProfile;

  return {
    fontKey: hierarchical.fontKey,
    intraWordThreshold: Math.min(hierarchical.document.intraWordThreshold, pageProfile.intraWordThreshold),
    interWordThreshold: Math.min(hierarchical.document.interWordThreshold, pageProfile.interWordThreshold),
    separation: Math.min(hierarchical.document.separation, pageProfile.separation),
    sampleCount: pageProfile.sampleCount,
    reliable: true,
  };
}

/**
 * [KROK-6 Z1b] Metryka wiarygodnosci WAZONA GLIFAMI — w odroznieniu od surowego
 * zliczania kluczy fontow (`fontsWithUnreliableProfile`, RAPORT-KROK-5.md:
 * 76-94%), ktore traktuje rzadki naglowek uzyty raz na 5 glifow tak samo jak
 * font akapitowy niosacy 80% tekstu strony. `key` fontu to font+rozmiar, wiec
 * rzadkie kombinacje dominuja LICZBE kluczy, ale niosa znikomy odsetek
 * faktycznego tekstu — ta metryka mowi, jaki odsetek GLIFOW (nie kluczy) ma
 * wiarygodny profil dokumentowy.
 */
export function computeReliableGlyphCoverage(
  fonts: readonly { key: string; glyphCount: number }[],
  documentProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
): number {
  let totalGlyphs = 0;
  let reliableGlyphs = 0;
  for (const font of fonts) {
    totalGlyphs += font.glyphCount;
    if (documentProfiles.get(font.key)?.document.reliable) reliableGlyphs += font.glyphCount;
  }
  return totalGlyphs > 0 ? reliableGlyphs / totalGlyphs : 0;
}
