import { groupByQuantizedPosition } from '../collections.js';
import type { TextLine } from './lineCluster.js';

/**
 * Running headers/footers (Step 6 Z5) — detected by REPETITION across
 * pages (pattern A8: requires a whole-document view, like Z2/Z5-Step5).
 *
 * NEVER match on exact text — the page number changes, and that's the most
 * common running element. Matching is by CONJUNCTION: vertical band +
 * font key + SIMILAR (not identical) width/horizontal position + presence
 * on >= 60% of pages in the range.
 */

export interface RunningElementMatch {
  pageNumber: number;
  lineId: string;
  kind: 'header' | 'footer';
}

export interface PageForRunningElements {
  pageNumber: number;
  pageHeight: number;
  /** Lines of this page's PRIMARY stream (0°) — running headers/footers are horizontal. */
  primaryLines: readonly TextLine[];
}

export interface RunningElementOptions {
  /** Top band: y > this value * page height = header candidate. */
  headerBandFraction?: number;
  /** Bottom band: y < this value * page height = footer candidate. */
  footerBandFraction?: number;
  /** Minimum fraction of pages in the range on which the signature must appear. */
  minPageFraction?: number;
  /** Horizontal position tolerance (pt) — headers are usually aligned identically. */
  positionTolerancePt?: number;
  /** Width tolerance (pt) — LARGER than position: the page number changes digit count (e.g. "9" vs "10"). */
  widthTolerancePt?: number;
}

const DEFAULT_HEADER_BAND_FRACTION = 0.93;
const DEFAULT_FOOTER_BAND_FRACTION = 0.07;
const DEFAULT_MIN_PAGE_FRACTION = 0.6;
const DEFAULT_POSITION_TOLERANCE_PT = 3;
const DEFAULT_WIDTH_TOLERANCE_PT = 12;

interface Candidate {
  pageNumber: number;
  line: TextLine;
  kind: 'header' | 'footer';
}

function quantize(v: number, tolerance: number): number {
  return Math.round(v / tolerance);
}

/**
 * Detects running headers/footers across the WHOLE document (or a given
 * page range — per the brief: "within a range", not always the whole
 * document). Returns matches for TAGGING (`BlockKind: 'header'|'footer'`
 * in Z6) — never removes lines from the model.
 */
export function detectRunningElements(
  pages: readonly PageForRunningElements[],
  opts: RunningElementOptions = {},
): RunningElementMatch[] {
  const headerBandFraction = opts.headerBandFraction ?? DEFAULT_HEADER_BAND_FRACTION;
  const footerBandFraction = opts.footerBandFraction ?? DEFAULT_FOOTER_BAND_FRACTION;
  const minPageFraction = opts.minPageFraction ?? DEFAULT_MIN_PAGE_FRACTION;
  const positionTolerancePt = opts.positionTolerancePt ?? DEFAULT_POSITION_TOLERANCE_PT;
  const widthTolerancePt = opts.widthTolerancePt ?? DEFAULT_WIDTH_TOLERANCE_PT;

  const candidates: Candidate[] = [];
  for (const page of pages) {
    if (page.pageHeight <= 0) continue;
    for (const line of page.primaryLines) {
      const y = (line.bbox.minY + line.bbox.maxY) / 2;
      const relativeY = y / page.pageHeight;
      if (relativeY > headerBandFraction) {
        candidates.push({ pageNumber: page.pageNumber, line, kind: 'header' });
      } else if (relativeY < footerBandFraction) {
        candidates.push({ pageNumber: page.pageNumber, line, kind: 'footer' });
      }
    }
  }

  const groups = groupByQuantizedPosition(candidates, (c) => {
    const width = c.line.bbox.maxX - c.line.bbox.minX;
    return [
      c.kind,
      c.line.dominantFont.key,
      quantize(c.line.bbox.minX, positionTolerancePt),
      quantize(width, widthTolerancePt),
    ].join('|');
  });

  const totalPages = pages.length;
  const matches: RunningElementMatch[] = [];
  for (const group of groups.values()) {
    const distinctPages = new Set(group.map((c) => c.pageNumber));
    if (totalPages > 0 && distinctPages.size / totalPages >= minPageFraction) {
      for (const c of group) {
        matches.push({ pageNumber: c.pageNumber, lineId: c.line.id, kind: c.kind });
      }
    }
  }

  return matches;
}
