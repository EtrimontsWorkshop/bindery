import { unionRect, type Rect } from '../../geometry.js';
import type { PageTextElement } from '../extract/types.js';
import type { StatblockProfile } from '../profile/schema.js';
import { computeCandidateConfidence } from './computeCandidateConfidence.js';
import { findCandidateEnd } from './findCandidateEnd.js';
import { lineMatchesAnchor } from './matchAnchor.js';
import { buildStatblockReadingOrder, isSameColumn, type ReadingOrderEntry } from './readingOrder.js';
import type { DetectionCandidate, DetectionRegion, PageForDetection } from './types.js';

function maxFontSizePerPage(pages: readonly PageForDetection[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const page of pages) {
    let max = 0;
    for (const el of page.elements) max = Math.max(max, el.fontSize);
    result.set(page.pageNumber, max);
  }
  return result;
}

function findAnchorIndices(readingOrder: readonly ReadingOrderEntry[], anchor: StatblockProfile['detection']['anchor'], maxFontSizeByPage: ReadonlyMap<number, number>): number[] {
  const indices: number[] = [];
  readingOrder.forEach((entry, index) => {
    if (lineMatchesAnchor(entry.line, anchor, maxFontSizeByPage.get(entry.pageNumber) ?? 0)) indices.push(index);
  });
  return indices;
}

/** Splits a contiguous reading-order span [startIndex, endIndexExclusive) into per-(page,column) regions, unioning each region's lines' bboxes, and collects every element in the span in reading order. */
function buildRegionsAndElements(readingOrder: readonly ReadingOrderEntry[], startIndex: number, endIndexExclusive: number): { regions: DetectionRegion[]; elements: PageTextElement[] } {
  const regions: DetectionRegion[] = [];
  const elements: PageTextElement[] = [];
  let current: { pageNumber: number; columnIndex: number; bbox: Rect } | null = null;

  for (let i = startIndex; i < endIndexExclusive; i++) {
    const entry = readingOrder[i]!;
    elements.push(...entry.line.elements);
    if (current && isSameColumn(current, entry)) {
      current.bbox = unionRect(current.bbox, entry.line.bbox);
    } else {
      if (current) regions.push({ pageNumber: current.pageNumber, bbox: current.bbox });
      current = { pageNumber: entry.pageNumber, columnIndex: entry.columnIndex, bbox: entry.line.bbox };
    }
  }
  if (current) regions.push({ pageNumber: current.pageNumber, bbox: current.bbox });
  return { regions, elements };
}

/**
 * The pure detector: given every page's already-extracted text
 * (`PageForDetection[]` — hand-built in a test, or produced by
 * `buildPagesForDetection.ts`'s pdf.js integration for a real document)
 * and a profile, returns one `DetectionCandidate` per anchor match,
 * REGARDLESS of confidence (never silently drop a candidate — see
 * `DetectionCandidate`'s own doc comment). No Foundry, no DOM, no I/O —
 * synchronous and Node-testable end to end on plain data.
 */
export function detectStatblocks(pages: readonly PageForDetection[], profile: StatblockProfile): DetectionCandidate[] {
  const readingOrder = buildStatblockReadingOrder(pages);
  const maxFontSizeByPage = maxFontSizePerPage(pages);
  const anchorIndices = findAnchorIndices(readingOrder, profile.detection.anchor, maxFontSizeByPage);

  return anchorIndices.map((startIndex, i) => {
    const nextAnchorIndex = anchorIndices[i + 1] ?? null;
    const endIndexExclusive = findCandidateEnd(readingOrder, startIndex, nextAnchorIndex, profile.detection.boundary);
    const { regions, elements } = buildRegionsAndElements(readingOrder, startIndex, endIndexExclusive);
    const confidenceResult = computeCandidateConfidence(elements, regions[0]?.bbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, profile.detection.requiredLabels, profile.fields);
    return {
      id: `candidate-${i}`,
      regions,
      elements,
      confidence: confidenceResult.confidence,
      foundRequiredLabels: confidenceResult.foundRequiredLabels,
      missingRequiredLabels: confidenceResult.missingRequiredLabels,
    };
  });
}
