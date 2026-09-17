import { rectsOverlap, type Rect } from './geometry.js';

/**
 * Clustering by transitively overlapping bboxes, ON THE SAME PAGE (A
 * overlaps B, B overlaps C => A, B, C in one cluster, even if A and C don't
 * touch each other directly) — one shared mechanism (Step 8 Z1, the same
 * reason as `groupByQuantizedPosition`, Step 6 Z1d) instead of two
 * independent implementations: `clusterOccurrencesByPage` in
 * `imageRegistry.ts` (Step 4/5, ALL occurrences, including future
 * decoration/mask) and recomputing clusters ONLY for `content`/`undecided`
 * candidates in `buildImageExtraction.ts` (Step 8 Z1).
 *
 * [Step 8, discovery] Without recomputation on the filtered set, the
 * extraction cluster inherited a `clusterId` computed BEFORE
 * classification, over ALL occurrences — a chain of small, overlapping
 * background-texture tiles (classified as `decoration`/`undecided`,
 * individually small) could "bridge" two genuinely separate, far-apart
 * content images into ONE cluster whose bbox union covers almost the
 * entire page — observed directly in RAPORT-KROK-7.md (`img_p7_6` from
 * `Wrath_&_Glory`, an entire page of text rendered as an "image").
 * Clustering MUST be recomputed FROM SCRATCH on the already-filtered set
 * (without decoration/masks) — filtering the RESULT of pre-computed
 * clustering (removing bridging entries from an already-formed group) is
 * not enough, because the group already exists with their participation.
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
 * Clusters `items` by transitively overlapping bboxes, separately per page
 * (`pageOf`). Returns a Map item -> clusterId (`p${page}-c${num}`, unique
 * across the whole call). Cluster numbering order within a page is
 * deterministic (the order of entry in `items`), it does not depend on the
 * `Map`/`Set` implementation.
 *
 * [Step 16 Z2, reported-bug fix] `extraMergeGate` — an optional, additional
 * condition ANDed with the base `rectsOverlap`; by default (no argument)
 * the behavior is IDENTICAL to before (every overlap merges), so the call
 * from `imageRegistry.ts` (raw occurrences, including future
 * decoration/mask) is entirely untouched. Used ONLY by
 * `buildImageExtraction.ts`, to distinguish "a chain of small tiles gluing
 * together one composition" (must be merged — the original reason this
 * function exists, see the comment at the top of the file) from "two
 * INDEPENDENTLY large, finished content images touching only at an edge"
 * (should not be merged — observed directly:
 * `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf` p. 16, two portraits
 * ~27%/~22% of the page area, an overlap of ~4% of the smaller one's area,
 * merged into one extraction unit that also caught the text column between them).
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
