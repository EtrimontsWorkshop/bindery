/**
 * Polityka rozdzielczosci renderu regionu (KROK-8 Z3). Kalibracja kroku 7
 * (RAPORT-KROK-7.md) pokazala, ze 92,7% obrazow-kandydatow wymaga renderu
 * regionu (nie ekstrakcji bezposredniej), a stala domyslna 2048px byla
 * niewystarczajaca dla scen/map (dluzsza krawedz zrodlowego zasobu czesto
 * przekracza 2048px, wiec render W DOL skaluje ostrzejsze od zrodla obrazy).
 *
 * [KROK-8, ograniczenie architektoniczne] Prawdziwy `targetKind` (`scene`/
 * `handout`/`portrait`, `finalize.ts`) wymaga JUZ zdekodowanych wymiarow
 * wynikowych — nie jest dostepny PRZED renderem (obliczamy TU wlasnie
 * rozdzielczosc TEGO renderu). Zamiast probowac przewidziec `targetKind`
 * z wyprzedzeniem (ryzyko rozjazdu z prawdziwa, pozniejsza klasyfikacja),
 * uzywamy `maxRelativeArea` reprezentanta regionu — DOKLADNIE TEGO SAMEGO
 * sygnalu, ktorego `classify.ts` juz uzywa do klasyfikacji tresc/dekoracja —
 * jako PROXY wielkosci kategorii (duzy obraz "scene-like" -> najwyzsze
 * minimum, sredni "handout-like" -> srednie, maly "portrait-like" -> najnizsze).
 * To swiadome przyblizenie, udokumentowane tutaj, nie pomylka.
 */

/** Ten sam prog co `LARGE_AREA_CONTENT_THRESHOLD` w `classify.ts` (>=40% strony = "scene-like"). */
const SCENE_LIKE_AREA_THRESHOLD = 0.4;
/** Ten sam prog co `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD` w `classify.ts` (>=10% strony = "handout-like"). */
const HANDOUT_LIKE_AREA_THRESHOLD = 0.1;

/** Minima z briefu KROK-8 Z3 — do kalibracji na `samples/`. */
const MIN_SCENE_LONG_EDGE_PX = 2048;
const MIN_HANDOUT_LONG_EDGE_PX = 1024;
const MIN_PORTRAIT_LONG_EDGE_PX = 512;

/**
 * Mnoznik bezpieczenstwa nad natywna rozdzielczoscia zrodla — render regionu
 * nie jest 1:1 z zasobem (obejmuje tez okoliczne piksele bboksa, ewentualne
 * skalowanie CTM), wiec lekka nadwyzka nad "goly" rozmiar zrodla chroni przed
 * delikatnym niedoswietleniem przy przyblizeniu w Foundry. Wartosc startowa,
 * do kalibracji.
 */
const SAFETY_MARGIN = 1.15;

export interface RenderResolutionInput {
  /**
   * Natywne (zrodlowe) dlugosci dluzszych krawedzi (px) WSZYSTKICH obrazow w
   * regionie, ktorych rozdzielczosc udalo sie ustalic (patrz
   * `probeIntrinsicLongEdgePx` w `extract.ts`) — PUSTE dla regionu czysto
   * wektorowego (brak obrazu) lub gdy zaden czlonek nie dal sie rozwiazac.
   */
  intrinsicLongEdgesPx: readonly number[];
  /** `maxRelativeArea` reprezentanta jednostki — patrz komentarz na gorze pliku. `null` dla regionu czysto wektorowego. */
  representativeMaxRelativeArea: number | null;
  /** Domyslna dlugosc krawedzi uzywana WYLACZNIE, gdy nie ma zadnego obrazu w regionie (brief: "wartosc z ustawien"). */
  defaultLongEdgePx: number;
  /** Twardy sufit — chroni przed wyprodukowaniem pliku o absurdalnym rozmiarze z rozkladowki. */
  maxLongEdgePx: number;
}

/** Minimum wg kategorii wielkosci (proxy dla `targetKind`, patrz komentarz na gorze pliku) — `null` gdy region czysto wektorowy (brief: bez minimum kategorii, tylko wartosc z ustawien). */
function minimumForCategory(representativeMaxRelativeArea: number | null): number | null {
  if (representativeMaxRelativeArea === null) return null;
  if (representativeMaxRelativeArea >= SCENE_LIKE_AREA_THRESHOLD) return MIN_SCENE_LONG_EDGE_PX;
  if (representativeMaxRelativeArea >= HANDOUT_LIKE_AREA_THRESHOLD) return MIN_HANDOUT_LONG_EDGE_PX;
  return MIN_PORTRAIT_LONG_EDGE_PX;
}

/**
 * `targetLongEdge = clamp(max(intrinsicLongEdge) * marginBezpieczenstwa, minimum wg kategorii, maksimum z ustawien)`
 * (brief KROK-8 Z3). Region czysto wektorowy (`intrinsicLongEdgesPx` puste I
 * `representativeMaxRelativeArea===null`) pomija minimum kategorii calkowicie
 * — nie ma czego odwzorowywac, wiec sama `defaultLongEdgePx` z ustawien
 * (przyciete do sufitu) wystarcza (brief: "wartosc z ustawien").
 */
export function computeTargetLongEdgePx(input: RenderResolutionInput): number {
  if (input.intrinsicLongEdgesPx.length === 0) {
    const minimum = minimumForCategory(input.representativeMaxRelativeArea);
    const base = minimum !== null ? Math.max(input.defaultLongEdgePx, minimum) : input.defaultLongEdgePx;
    return Math.min(base, input.maxLongEdgePx);
  }

  const intrinsicMax = Math.max(...input.intrinsicLongEdgesPx);
  const desired = intrinsicMax * SAFETY_MARGIN;
  const minimum = minimumForCategory(input.representativeMaxRelativeArea) ?? MIN_PORTRAIT_LONG_EDGE_PX;
  return Math.min(Math.max(desired, minimum), input.maxLongEdgePx);
}
