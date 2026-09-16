import { rectsOverlap, type Rect } from './geometry.js';

/**
 * Klastrowanie po przechodnio nakladajacych sie bboksach, NA TEJ SAMEJ STRONIE
 * (A naklada sie z B, B z C => A, B, C w jednym klastrze, nawet jesli A i C
 * same w sobie sie nie stykaja) — jeden wspolny mechanizm (KROK-8 Z1, ten sam
 * powod co `groupByQuantizedPosition`, KROK-6 Z1d) zamiast dwoch niezaleznych
 * implementacji: `clusterOccurrencesByPage` w `imageRegistry.ts` (KROK-4/5,
 * WSZYSTKIE wystapienia, w tym przyszla dekoracja/maska) i rekomputacja
 * klastrow WYLACZNIE dla kandydatow `content`/`undecided` w
 * `buildImageExtraction.ts` (KROK-8 Z1).
 *
 * [KROK-8, odkrycie] Bez rekomputacji na przefiltrowanym zbiorze, klaster
 * ekstrakcji dziedziczyl `clusterId` policzony PRZED klasyfikacja, na
 * WSZYSTKICH wystapieniach — lancuch malych, nakladajacych sie kafli tekstury
 * tla (klasyfikowanych `decoration`/`undecided`, individualnie male) mogl
 * "zmostkowac" dwa genuinie osobne, oddalone od siebie obrazy tresci w JEDEN
 * klaster, ktorego unia bboksow obejmuje niemal cala strone — zaobserwowane
 * wprost w RAPORT-KROK-7.md (`img_p7_6` z `Wrath_&_Glory`, cala strona tekstu
 * wyrenderowana jako "obraz"). Klastrowanie MUSI byc przeliczone OD ZERA na
 * zbiorze juz-przefiltrowanym (bez dekoracji/masek) — filtrowanie WYNIKU
 * pre-computed klastrowania (usuwanie mostkujacych wpisow z gotowej grupy) nie
 * wystarczy, bo grupa juz istnieje z ich udzialem.
 */
class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Klastruje `items` po przechodnio nakladajacych sie bboksach, osobno per
 * strona (`pageOf`). Zwraca Map item -> clusterId (`p${page}-c${num}`, unikalne
 * w calym wywolaniu). Kolejnosc numeracji klastrow w obrebie strony jest
 * deterministyczna (kolejnosc wejscia w `items`), nie zalezy od implementacji
 * `Map`/`Set`.
 *
 * [KROK-16 Z2, naprawa zgloszonego bledu] `extraMergeGate` — opcjonalny,
 * dodatkowy warunek ANDowany z bazowym `rectsOverlap`; domyslnie (brak
 * argumentu) zachowanie IDENTYCZNE jak wczesniej (kazde nakladanie sie laczy),
 * wiec wywolanie z `imageRegistry.ts` (surowe wystapienia, wlacznie z przyszla
 * dekoracja/maska) jest w ogole nietkniete. Uzyty WYLACZNIE przez
 * `buildImageExtraction.ts`, zeby odrozniac "lancuch malych kafli sklejajacy
 * jedna kompozycje" (musi zostac polaczony — pierwotny powod istnienia tej
 * funkcji, patrz komentarz na gorze pliku) od "dwa NIEZALEZNIE duze, gotowe
 * obrazy tresci stykajace sie tylko krawedzia" (nie powinny sie laczyc —
 * zaobserwowane wprost: `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf` str. 16,
 * dwa portrety ~27%/~22% powierzchni strony, nakladanie ~4% powierzchni
 * mniejszego z nich, polaczone w jedna jednostke ekstrakcji ktora zlapala tez
 * kolumne tekstu miedzy nimi).
 */
export function clusterByOverlap<T>(
  items: readonly T[],
  pageOf: (item: T) => number,
  bboxOf: (item: T) => Rect,
  extraMergeGate?: (a: T, b: T, bboxA: Rect, bboxB: Rect) => boolean,
): Map<T, string> {
  const byPage = new Map<number, number[]>();
  items.forEach((item, i) => {
    const page = pageOf(item);
    const arr = byPage.get(page) ?? [];
    arr.push(i);
    byPage.set(page, arr);
  });

  const result = new Map<T, string>();
  for (const [page, indices] of byPage) {
    const uf = new UnionFind(indices.length);
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const itemA = items[indices[a]!]!;
        const itemB = items[indices[b]!]!;
        const bboxA = bboxOf(itemA);
        const bboxB = bboxOf(itemB);
        if (rectsOverlap(bboxA, bboxB) && (!extraMergeGate || extraMergeGate(itemA, itemB, bboxA, bboxB))) {
          uf.union(a, b);
        }
      }
    }
    const rootToClusterNum = new Map<number, number>();
    let nextClusterNum = 0;
    for (let a = 0; a < indices.length; a++) {
      const root = uf.find(a);
      if (!rootToClusterNum.has(root)) rootToClusterNum.set(root, nextClusterNum++);
      result.set(items[indices[a]!]!, `p${page}-c${rootToClusterNum.get(root)}`);
    }
  }
  return result;
}
