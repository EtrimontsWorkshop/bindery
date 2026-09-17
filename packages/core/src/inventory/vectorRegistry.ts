import type { Rect } from '../geometry.js';
import { relativeArea as computeRelativeArea } from '../geometry.js';
import type { WalkEvent } from './walkOperators.js';

/**
 * Rectangular fills/strokes — candidates for stat-block frames and
 * backgrounds (phase 2, the block-merging step). `walkOperators` has already
 * rejected everything that isn't an axis-aligned rectangle — this module
 * just adds `relativeArea` and orders the result per page.
 */
export interface VectorRegion {
  kind: 'fill' | 'stroke';
  bbox: Rect;
  page: number;
  /** Area relative to the page — distinguishes a stat-block frame from a full-page background. */
  relativeArea: number;
  /**
   * [Step 5 Z6, debt from Step 4] The subtype of the parent group (e.g.
   * "Luminosity"), when this path/fill was drawn inside a beginGroup.
   * Without this field, luminosity masks whose form paints a vector fill
   * instead of an image (see RAPORT-KROK-4.md) were completely invisible to
   * any future mask classification — this module only carries the
   * geometric fact, the classification decision still belongs to phase 3.
   */
  groupSubtype: string | null;
}

/** Builds vector regions for one page from `walkOperators` events of type 'vector'. */
export function buildVectorRegions(events: readonly WalkEvent[], page: number, pageBox: Rect): VectorRegion[] {
  const regions: VectorRegion[] = [];
  for (const e of events) {
    if (e.type !== 'vector') continue;
    regions.push({
      kind: e.kind,
      bbox: e.bbox,
      page,
      relativeArea: computeRelativeArea(e.bbox, pageBox),
      groupSubtype: e.inGroup?.subtype ?? null,
    });
  }
  return regions;
}
