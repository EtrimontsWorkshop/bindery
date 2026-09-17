import { groupByQuantizedPosition } from '../collections.js';
import { hasBoundaryBetween } from '../text/hygiene.js';
import type { CleanItem, WordBoundary } from '../text/types.js';
import { effectiveGapProfileForPage, type HierarchicalGapProfile } from '../text/gapStatistics.js';
import { axisPositions, baselineTolerance, fontSizeFromTransform, type StreamAngle } from './textGeometry.js';

/**
 * Merges fragments into tokens with a high probability of cohesion (Step 5
 * Z4). Merges TWO adjacent items only when ALL conditions from the brief are
 * met — missing even one means no merge. The result is NOT a "word" in the
 * linguistic sense (no dictionary validation, no language detection).
 *
 * P1 (Polish single-letter words: w, z, i, o, a, u, e): we NEVER use token
 * length alone as grounds for merging — the conditions below never refer to
 * `str` length at all.
 */

export interface MergeCandidateItem extends CleanItem {
  fontKey: string;
}

export interface MergedToken {
  str: string;
  /** Transform of the FIRST source item — the token's position anchor. */
  transform: readonly number[];
  /** Span along the reading axis from the anchor to the end of the LAST source item. */
  width: number;
  height: number;
  fontKey: string;
  fontName: string;
  syntheticBold: boolean;
  /** [F0] Merge trail — original indices + reason, for the review screen (phase 9). */
  sourceIndices: number[];
  mergeReason: 'no-merge' | 'gap-below-threshold';
}

const MERGE_REASON_NONE: MergedToken['mergeReason'] = 'no-merge';
const MERGE_REASON_GAP: MergedToken['mergeReason'] = 'gap-below-threshold';

function toToken(item: MergeCandidateItem): MergedToken {
  return {
    str: item.str,
    transform: item.transform,
    width: item.width,
    height: item.height,
    fontKey: item.fontKey,
    fontName: item.fontName,
    syntheticBold: item.syntheticBold,
    sourceIndices: [item.index],
    mergeReason: MERGE_REASON_NONE,
  };
}

/**
 * The reason for the (non-)merge decision on a pair of adjacent items — used
 * both by `mergeWords` and by `tools/calibrate-merge.mjs` (Step 5, calibration
 * on files from `samples/`), so the diagnostic tool doesn't duplicate
 * production logic.
 */
export type MergeBlockReason =
  | 'merged'
  | 'different-font'
  | 'word-boundary'
  | 'different-baseline'
  | 'unreliable-profile'
  | 'gap-too-large'
  | 'overlapping';

/**
 * Classifies whether `next` should merge with `prev` — ALL conditions from
 * the brief's table (Z4) must be met, checked in the same order as the
 * table. `angle` is the stream angle, shared across the whole mergeWords call
 * (condition #3 satisfied by definition, since the caller already splits
 * items into angular streams before calling — see Z3).
 */
export function classifyMergeDecision(
  prev: MergeCandidateItem,
  next: MergeCandidateItem,
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  gapProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
  page: number,
): MergeBlockReason {
  // #1 Same font key.
  if (prev.fontKey !== next.fontKey) return 'different-font';

  // #4 [U2, HARD] No wordBoundaries boundary between them.
  if (hasBoundaryBetween(wordBoundaries, prev.index, next.index)) return 'word-boundary';

  // #2 Same baseline (tolerance shared with Z5, see textGeometry.ts).
  const prevAxis = axisPositions(prev.transform, angle);
  const nextAxis = axisPositions(next.transform, angle);
  const tolerance = baselineTolerance(fontSizeFromTransform(prev.transform));
  if (Math.abs(prevAxis.cross - nextAxis.cross) > tolerance) return 'different-baseline';

  // #6 The font profile must be reliable (separation above the confidence threshold) — Z2.
  // [Step 6 Z1a] Uses the more conservative of the document-level and page-level thresholds (see effectiveGapProfileForPage).
  const hierarchical = gapProfiles.get(prev.fontKey);
  if (!hierarchical) return 'unreliable-profile';
  const profile = effectiveGapProfileForPage(hierarchical, page);
  if (!profile.reliable) return 'unreliable-profile';

  // #5 Gap STRICTLY below the intra-word threshold for this font.
  const gap = nextAxis.along - (prevAxis.along + prev.width);
  // [Step 6, discovery] A NEGATIVE gap (items geometrically overlapping along
  // the reading axis) is NOT "close" — it's always separate, discontinuous
  // elements (e.g. two dense columns of a table/table-of-contents that happen
  // to share a baseline), never a genuine fragmentation of one word. Without
  // this lower bound, `gap < intraWordThreshold` let through EVERY negative
  // gap (always "smaller" than any positive threshold) — verified
  // empirically: this was the ACTUAL cause of merges on p. 3 of
  // Cienie_posrod_mgie.pdf (Z1a), not threshold calibration.
  if (gap < 0) return 'overlapping';
  if (!(gap < profile.intraWordThreshold)) return 'gap-too-large';

  return 'merged';
}

/**
 * Groups by APPROXIMATE baseline (cross-axis, rounded to the tolerance)
 * BEFORE sorting/merging along the reading axis — without this, merging
 * would compare fragments from DIFFERENT lines that happened to end up next
 * to each other in a global sort by the `along` axis alone (discovered
 * empirically via calibration on files from `samples/`, Step 5: on a
 * multi-line page, >90% of "adjacent" pairs after such a global sort were
 * from different lines — correctly blocked by condition #2, but wasting
 * work and, worse, potentially missing genuine merges if a fragment from
 * another line slots in between two fragments of the same line in the
 * sort). Same bucketing method as `collectGapSamples` (Z2).
 */
function bucketByBaseline(items: readonly MergeCandidateItem[], angle: StreamAngle): MergeCandidateItem[][] {
  const buckets = groupByQuantizedPosition(items, (item) => {
    const cross = axisPositions(item.transform, angle).cross;
    const tolerance = baselineTolerance(fontSizeFromTransform(item.transform));
    return String(Math.round(cross / tolerance));
  });
  return [...buckets.keys()]
    .sort((a, b) => Number(b) - Number(a))
    .map((key) => buckets.get(key)!);
}

/**
 * Merges adjacent items from ONE angular stream (already past hygiene, Z1)
 * into tokens. The caller (orchestrator) supplies items for one angle at a
 * time (Z3 precedes Z4); input order doesn't matter — the function groups by
 * baseline and sorts along the reading axis within each group itself.
 */
export function mergeWords(
  items: readonly MergeCandidateItem[],
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  gapProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
  page: number,
): MergedToken[] {
  const tokens: MergedToken[] = [];

  for (const bucket of bucketByBaseline(items, angle)) {
    const sorted = [...bucket].sort((a, b) => axisPositions(a.transform, angle).along - axisPositions(b.transform, angle).along);

    let lastPhysicalItem: MergeCandidateItem | undefined;
    let currentTokenAnchorAlong = 0;

    for (const item of sorted) {
      const last = tokens[tokens.length - 1];

      if (last && lastPhysicalItem && classifyMergeDecision(lastPhysicalItem, item, angle, wordBoundaries, gapProfiles, page) === 'merged') {
        last.str += item.str;
        last.sourceIndices.push(item.index);
        last.mergeReason = MERGE_REASON_GAP;
        last.syntheticBold = last.syntheticBold || item.syntheticBold;
        const itemEnd = axisPositions(item.transform, angle).along + item.width;
        last.width = itemEnd - currentTokenAnchorAlong;
      } else {
        tokens.push(toToken(item));
        currentTokenAnchorAlong = axisPositions(item.transform, angle).along;
      }

      lastPhysicalItem = item;
    }
  }

  return tokens;
}
