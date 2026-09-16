import type { ImageEntry } from '../inventory/imageRegistry.js';

/**
 * Strategia ekstrakcji (KROK-7 Z2, MDD faza 3). Nie kazdy obraz sklasyfikowany
 * jako `content` wolno wyciagnac bezposrednio — decyzja zawsze z jawnym
 * uzasadnieniem (`reason`), nigdy samo `boolean` (brief: potrzebne w raporcie
 * i na ekranie przegladu, faza 9).
 *
 * Tabela z briefu ma piec wierszy, ale tylko DWIE strategie koncowe:
 * - `direct` — tylko "pojedynczy obraz, brak maski, brak klastra".
 * - `region-render` — wszystko inne (maska, klaster, brak obrazu/wektor, przezroczystosc nad tlem).
 *
 * Uwaga: "obraz z przezroczystoscia nad tlem" (ostatni wiersz tabeli) NIE ma
 * dzis niezaleznego sygnalu wykrywalnego bez decodowania kanalu alfa — celowo
 * NIE budujemy pod to osobnego mechanizmu (brief: nie inwestuj w luki U5-podobne).
 * Traktowany jako podzbior "obraz z maska" (`isMasked`): oba wymagaja renderu
 * kompozycji zamiast surowego zasobu, a `maskEvidence` juz to wykrywa dla
 * przypadkow z jawna maska SMask/Luminosity lub opcode maski.
 */

export type ExtractionStrategy = 'direct' | 'region-render';

export interface StrategyDecision {
  strategy: ExtractionStrategy;
  reason: string;
}

export interface StrategyInput {
  /** `null` = region czysto wektorowy (mapa rysowana), brak obrazu do wyciagniecia. */
  entry: ImageEntry | null;
  /** Czy TEN zasob jest maskowany przez inny wpis (jego objId to `masksImageObjId` jakiegos wpisu z twardym dowodem maski). */
  isMasked: boolean;
  /** Liczba ODREBNYCH zasobow (ImageEntry) dzielacych ten sam klaster nakladajacych sie wystapien na tej samej stronie, WLICZAJAC ten wpis. */
  clusterMemberCount: number;
}

export function decideExtractionStrategy(input: StrategyInput): StrategyDecision {
  if (input.entry === null) {
    return { strategy: 'region-render', reason: 'Z2-vector-only-no-image' };
  }
  if (input.isMasked) {
    return { strategy: 'region-render', reason: 'Z2-masked-direct-would-omit-mask' };
  }
  if (input.clusterMemberCount > 1) {
    return { strategy: 'region-render', reason: 'Z2-cluster-composition-is-content' };
  }
  return { strategy: 'direct', reason: 'Z2-single-clean-image' };
}

/**
 * Zbiór `objId` zasobow ZAMASKOWANYCH przez KTORYKOLWIEK wpis z twardym
 * dowodem maski (`maskEvidence` group/opcode) wskazujacy je przez `masksImageObjId`.
 */
export function computeMaskedObjIds(entries: readonly ImageEntry[]): ReadonlySet<string> {
  const masked = new Set<string>();
  for (const e of entries) {
    if ((e.maskEvidence === 'group' || e.maskEvidence === 'opcode') && e.masksImageObjId) {
      masked.add(e.masksImageObjId);
    }
  }
  return masked;
}

/**
 * Liczba ODREBNYCH wpisow dzielacych ten sam `clusterId` (patrz `ImageEntry.clusterId`,
 * przypisywany w kroku 4 per pierwsze wystapienie) — wpisy bez `clusterId` licza sie jako samotne (1).
 *
 * [wyjasnienie po recenzji calego designu — NIE mylic z prawdziwa decyzja
 * pipeline'u] To jest UPROSZCZONA, jednoprzebiegowa miara po `clusterId`
 * (wczesny sygnal z inwentaryzacji, liczony PRZED filtrowaniem do
 * content/undecided). Prawdziwy `clusterMemberCount` uzywany przez
 * `buildImageExtraction.ts` do faktycznej decyzji `direct` vs `region-render`
 * pochodzi z ZUPELNIE NIEZALEZNEGO, dwuetapowego algorytmu tamtego pliku
 * (`groupIntoUnits`/`partitionCandidatesIntoGroups`, oparty o kotwice i
 * wspolczynnik nakladania, naprawiony w KROK-16 wlasnie dlatego, ze
 * `clusterId`-owe grupowanie dawalo zle wyniki na `img_p13_*`/`img_p15_*`).
 * Te dwie liczby MOGA sie roznic dla tego samego obrazu. Ta funkcja istnieje
 * wylacznie do przyblizonego raportowania (`tools/calibrate-images.ts`) i
 * jest przetestowana jako WLASNA, izolowana jednostka — NIE uzywaj jej, zeby
 * przewidziec/zweryfikowac faktyczna strategie ekstrakcji konkretnego obrazu.
 */
export function computeClusterMemberCounts(entries: readonly ImageEntry[]): ReadonlyMap<ImageEntry, number> {
  const countByClusterId = new Map<string, number>();
  for (const e of entries) {
    if (!e.clusterId) continue;
    countByClusterId.set(e.clusterId, (countByClusterId.get(e.clusterId) ?? 0) + 1);
  }
  const result = new Map<ImageEntry, number>();
  for (const e of entries) {
    result.set(e, e.clusterId ? (countByClusterId.get(e.clusterId) ?? 1) : 1);
  }
  return result;
}
