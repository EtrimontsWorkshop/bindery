import { unionRect, type Rect } from '../geometry.js';
import type { ColumnRegion } from './columns.js';
import type { LineToken, TextLine } from './lineCluster.js';
import type { SpanningSplit } from './spanning.js';

/**
 * Repair pass AFTER column detection (Step 10) — fixes lines that
 * `lineCluster.ts` falsely merged across two (or more) columns at the same
 * height, when the weak gutter hint (`gutterHint.ts`, runs BEFORE
 * clustering, on the raw histogram) wasn't enough.
 *
 * [architectural decision, per the brief] `gutterHint` runs BEFORE line
 * clustering and only has a coarse histogram available — strengthening it
 * there would mean fighting at the worst available information level, inside
 * the heavily tested core (`lineCluster.ts`/`sameLine`), with real regression
 * risk. Instead: AFTER column detection (Z3, `detectColumns`) we have CERTAIN
 * knowledge of column boundaries — this module uses that knowledge
 * RETROACTIVELY, as a separate pass, without touching `lineCluster.ts`'s
 * decision logic.
 *
 * The discriminator (the crux of the task): a line whose bbox crosses a
 * detected gutter can be either (a) a TRUE spanning line — it has token(s)
 * INSIDE the gutter area, text genuinely runs through there — DO NOT touch
 * it; or (b) a FALSE merge — ZERO tokens in the gutter, two clusters with a
 * gap — SPLIT it. Safeguard: only runs when column detection confidence >=
 * threshold (uncertain column detection = we don't know where the columns
 * ARE, better to leave an existing bug than introduce a new one).
 */

/** Same threshold as `LOW_CONFIDENCE_THRESHOLD` in `tools/calibrate-layout.ts` — consistent with the existing convention "below this, columns are uncertain". */
const GUTTER_REPAIR_CONFIDENCE_THRESHOLD = 0.85;

export interface GutterRepairResult {
  split: SpanningSplit;
  /** Number of lines actually split — for calibration/reporting. */
  splitCount: number;
}

interface Gutter {
  minX: number;
  maxX: number;
}

/** Gutters between CONSECUTIVE (X-sorted) columns — N columns give N-1 gutters. */
function computeGutters(columns: readonly ColumnRegion[]): Gutter[] {
  const sorted = [...columns].sort((a, b) => a.bbox.minX - b.bbox.minX);
  const gutters: Gutter[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    gutters.push({ minX: sorted[i]!.bbox.maxX, maxX: sorted[i + 1]!.bbox.minX });
  }
  return gutters;
}

/** Which gutters a line's bbox ACTUALLY crosses (can be more than one with 3+ columns). */
function crossedGutters(line: TextLine, gutters: readonly Gutter[]): Gutter[] {
  return gutters.filter((g) => line.bbox.minX < g.minX && line.bbox.maxX > g.maxX);
}

function tokenIntersectsGutter(token: LineToken, gutter: Gutter): boolean {
  return token.bbox.maxX > gutter.minX && token.bbox.minX < gutter.maxX;
}

function buildFragmentBBox(tokens: readonly LineToken[]): Rect {
  return tokens.map((t) => t.bbox).reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
}

/** A line fragment after splitting — a new `TextLine` with a subset of tokens, text/bbox recomputed ONLY from them. `id` carries the link to the source line (provenance, per the brief). */
function buildFragment(line: TextLine, tokens: readonly LineToken[], fragmentIndex: number): TextLine {
  return {
    ...line,
    id: `${line.id}-gutter${fragmentIndex}`,
    text: tokens.map((t) => t.text).join(' '),
    bbox: buildFragmentBBox(tokens),
    tokens: [...tokens],
    // `runs` (Step 9 Z1b) inherited from the source line are no longer valid
    // for the fragment (they may reference tokens from the OTHER side of the
    // gutter) — cleared instead of introducing a silent bug further down the Z1b pipeline.
    runs: undefined,
  };
}

/**
 * Splits lines from `split.spanning` that falsely merge two (or more)
 * columns at the same height. Safe by design: when token data is missing
 * (`TextLine.tokens` unpopulated — e.g. hand-built fixtures without that
 * field) or column detection is uncertain, it splits NOTHING.
 */
export function repairGutterCrossingLines(split: SpanningSplit, columns: readonly ColumnRegion[], columnConfidence: number): GutterRepairResult {
  if (columnConfidence < GUTTER_REPAIR_CONFIDENCE_THRESHOLD || columns.length < 2) {
    return { split, splitCount: 0 };
  }
  const gutters = computeGutters(columns);
  if (gutters.length === 0) return { split, splitCount: 0 };

  const remainingSpanning: TextLine[] = [];
  const newColumnar: TextLine[] = [];
  let splitCount = 0;

  for (const line of split.spanning) {
    const crossed = crossedGutters(line, gutters);
    if (crossed.length === 0) {
      remainingSpanning.push(line);
      continue;
    }

    const tokens = line.tokens;
    if (!tokens || tokens.length === 0) {
      // Safeguard: no token data — don't cut without certainty (A7-like rule: degrade, don't guess).
      remainingSpanning.push(line);
      continue;
    }

    const hasTokenInAnyCrossedGutter = crossed.some((g) => tokens.some((t) => tokenIntersectsGutter(t, g)));
    if (hasTokenInAnyCrossedGutter) {
      // A true spanning line — text genuinely runs through the gutter. DO NOT touch it.
      remainingSpanning.push(line);
      continue;
    }

    // Split into fragments between consecutive crossed gutters.
    const sortedGutters = [...crossed].sort((a, b) => a.minX - b.minX);
    const regionBounds: { min: number; max: number }[] = [];
    let prevMax = Number.NEGATIVE_INFINITY;
    for (const g of sortedGutters) {
      regionBounds.push({ min: prevMax, max: g.minX });
      prevMax = g.maxX;
    }
    regionBounds.push({ min: prevMax, max: Number.POSITIVE_INFINITY });

    const fragmentsTokens: LineToken[][] = regionBounds.map(() => []);
    let allTokensAssigned = true;
    for (const t of tokens) {
      const regionIndex = regionBounds.findIndex((r) => t.bbox.minX >= r.min && t.bbox.maxX <= r.max);
      if (regionIndex === -1) {
        // Token doesn't fit cleanly into any region (e.g. it itself overlaps the gutter boundary) — safeguard, don't cut.
        allTokensAssigned = false;
        break;
      }
      fragmentsTokens[regionIndex]!.push(t);
    }

    if (!allTokensAssigned || fragmentsTokens.some((f) => f.length === 0)) {
      // One side would end up empty (or a token is ambiguous) — there aren't two real sides to separate.
      remainingSpanning.push(line);
      continue;
    }

    fragmentsTokens.forEach((frag, i) => newColumnar.push(buildFragment(line, frag, i)));
    splitCount++;
  }

  return {
    split: { spanning: remainingSpanning, columnar: [...split.columnar, ...newColumnar], textBlockWidth: split.textBlockWidth },
    splitCount,
  };
}
