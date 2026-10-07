import type { Rect } from '../../geometry.js';
import type { PageTextElement } from '../extract/types.js';

/**
 * One page's worth of already-extracted text, ready for
 * detection — the boundary between the pure detector below and whatever
 * populates this (a hand-built test fixture, or the real pdf.js
 * integration in `buildPagesForDetection.ts`). Deliberately reuses
 * `PageTextElement` from `extract/` (same primitive, one definition) rather than inventing a page-scoped variant.
 */
export interface PageForDetection {
  pageNumber: number;
  elements: readonly PageTextElement[];
  /** This page's own content box — the "end of page" half of the `endOfColumnOrPage` boundary, and the fallback single "column" when `columns` is absent. */
  pageBox: Rect;
  /** Column x-ranges on this page, LEFT TO RIGHT, if the page has more than one — the "end of column" half of `endOfColumnOrPage`, and what keeps reading order sane on a multi-column layout (column 1 top-to-bottom, then column 2, ...). Absent/empty = single column spanning the whole `pageBox` width. */
  columns?: readonly Rect[];
  /** Rectangular frame regions detected on this page (from vector graphics, e.g. `inventory/vectorRegistry.ts`'s `VectorRegion`) — an optional signal a profile's anchor/boundary can key off of for framed statblocks. */
  vectorFrames?: readonly Rect[];
}

/** One page/column span of a candidate — a candidate that crosses a column or page boundary has more than one of these, each with its own bbox in that page's own coordinate space. */
export interface DetectionRegion {
  pageNumber: number;
  bbox: Rect;
}

/**
 * The detector's output: page number, bounding box(es), the block's text elements and confidence. Every anchor match that survives `detection`
 * produces ONE candidate here, REGARDLESS of confidence — a false-
 * positive anchor match still shows up, just with a low `confidence`,
 * rather than being silently dropped (the same "never disappear silently"
 * convention as the rest of this project; filtering by confidence is a
 * caller/UI decision, not this module's).
 */
export interface DetectionCandidate {
  id: string;
  regions: readonly DetectionRegion[];
  elements: readonly PageTextElement[];
  confidence: number;
  foundRequiredLabels: readonly string[];
  missingRequiredLabels: readonly string[];
}

/** Progress callback shape for the batched integration layer — reported through a non-blocking callback. */
export interface DetectionProgress {
  pagesProcessed: number;
  totalPages: number;
}
