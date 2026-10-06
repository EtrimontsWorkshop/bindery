import { unionRect } from '../../geometry.js';
import { elementBBox, type PageTextElement, type ReconstructedLine } from './types.js';

/**
 * Reconstructs reading-order lines from a flat bag of
 * `PageTextElement`s — grouping by Y-overlap into rows (PDF-space,
 * Y-increases-upward: earlier rows have LARGER y), then splitting a row at
 * any unusually wide horizontal gap ("column handling" — the practical
 * case this exists for is two independent label/value pairs sitting side
 * by side on the same visual row, e.g. "HP: 12    AC: 15": without this
 * split, a naive single-space join would silently merge two unrelated
 * fields' text into one line).
 *
 * Deliberately simpler than `layout/lineCluster.ts` (whole-document,
 * gap-statistics-calibrated, font-role-aware) — this module only ever
 * sees a handful of elements within one already-located statblock
 * instance, where that machinery is overkill. Each `PageTextElement` is
 * assumed to already be a complete word/token (no character-level
 * fragment merging here — that belongs to whatever populates
 * `PageTextElement` from the real pipeline, a later task).
 */

/** A gap wider than this many times the row's own median inter-element gap is treated as a column break, not word spacing. */
const COLUMN_GAP_MEDIAN_MULTIPLIER = 4;
/** Fallback threshold (PDF points) when a row has too few gaps to compute a meaningful median (e.g. exactly two elements). */
const COLUMN_GAP_ABSOLUTE_MIN_PT = 24;

function verticalOverlap(a: PageTextElement, b: PageTextElement): number {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Groups elements into rows (top-to-bottom) by pairwise Y-overlap, each row sorted left-to-right. */
function groupIntoRows(elements: readonly PageTextElement[]): PageTextElement[][] {
  const sorted = [...elements].sort((a, b) => b.y + b.h - (a.y + a.h) || a.x - b.x);
  const rows: PageTextElement[][] = [];
  for (const el of sorted) {
    const row = rows.find((candidate) => candidate.some((other) => verticalOverlap(other, el) > 0));
    if (row) row.push(el);
    else rows.push([el]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  rows.sort((a, b) => Math.max(...b.map((e) => e.y + e.h)) - Math.max(...a.map((e) => e.y + e.h)));
  return rows;
}

/** Splits a left-to-right-sorted row at any gap wide enough to be a column break rather than word spacing. */
function splitRowByGaps(row: readonly PageTextElement[]): PageTextElement[][] {
  if (row.length <= 1) return [[...row]];
  const gaps: number[] = [];
  for (let i = 1; i < row.length; i++) gaps.push(Math.max(0, row[i]!.x - (row[i - 1]!.x + row[i - 1]!.w)));
  // With only ONE gap in the row (row.length === 2), that single gap IS its
  // own "median" — multiplying it by itself can never exceed the
  // threshold, so the multiplicative rule can never fire. Use the flat
  // absolute threshold alone until there are at least two gaps to compare
  // against each other.
  const positiveGaps = gaps.filter((g) => g > 0);
  const threshold = positiveGaps.length >= 2 ? Math.max(median(positiveGaps) * COLUMN_GAP_MEDIAN_MULTIPLIER, COLUMN_GAP_ABSOLUTE_MIN_PT) : COLUMN_GAP_ABSOLUTE_MIN_PT;

  const segments: PageTextElement[][] = [[row[0]!]];
  for (let i = 1; i < row.length; i++) {
    const gap = row[i]!.x - (row[i - 1]!.x + row[i - 1]!.w);
    if (gap > threshold) segments.push([]);
    segments[segments.length - 1]!.push(row[i]!);
  }
  return segments;
}

function buildReconstructedLine(elements: readonly PageTextElement[]): ReconstructedLine {
  const text = elements
    .map((e) => e.text)
    .join(' ')
    .trim();
  const bbox = elements.slice(1).reduce((acc, e) => unionRect(acc, elementBBox(e)), elementBBox(elements[0]!));
  return { text, elements, bbox };
}

export function reconstructLines(elements: readonly PageTextElement[]): ReconstructedLine[] {
  if (elements.length === 0) return [];
  const lines: ReconstructedLine[] = [];
  for (const row of groupIntoRows(elements)) {
    for (const segment of splitRowByGaps(row)) lines.push(buildReconstructedLine(segment));
  }
  return lines;
}
