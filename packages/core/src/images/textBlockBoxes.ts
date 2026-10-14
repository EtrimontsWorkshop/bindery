import type { Rect } from '../geometry.js';

/** The part of a layout block that the grouping below needs. */
export interface BlockBoxLike {
  pageNumber: number;
  kind: string;
  bbox: Rect;
}

/** Bboxes of the layout blocks per page; every kind when `kinds` is omitted. */
export function groupBlockBoxesByPage(blocks: readonly BlockBoxLike[], kinds?: ReadonlySet<string>): Map<number, Rect[]> {
  const byPage = new Map<number, Rect[]>();
  for (const b of blocks) {
    if (kinds && !kinds.has(b.kind)) continue;
    const arr = byPage.get(b.pageNumber) ?? [];
    arr.push(b.bbox);
    byPage.set(b.pageNumber, arr);
  }
  return byPage;
}
