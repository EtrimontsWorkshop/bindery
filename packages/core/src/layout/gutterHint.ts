/**
 * Gutter hint (Step 6, discovery on `samples/`) — a lightweight density
 * histogram on the X axis, the same methodology as `detectColumns` (Z3), but
 * WITHOUT full vertical validation and WITHOUT the `ColumnRegion[]` shape:
 * this is just a HINT for line clustering (Z5, `lineCluster.ts`), not the
 * authoritative answer about columns (that still belongs solely to Z3, on
 * already correctly split lines).
 *
 * Why this is needed at all: on real files (not synthetic fixtures) the
 * gutter between columns can be narrow (~1.2x font size, measured on
 * Cienie_posrod_mgie.pdf p. 46) — indistinguishable from an ordinary, wide
 * inter-word space by distance alone, nor by the presence of a pdf.js
 * boundary (`WordBoundary`): both signals fail in exactly the same value
 * range. The only reliable signal is the CONSISTENCY of X positions across
 * multiple ROWS (rowId) at once — exactly what the histogram below computes,
 * but this MUST happen BEFORE line clustering (Z5), otherwise two columns on
 * the same row are already merged into one line before Z3 even gets a chance
 * to see it.
 *
 * [Step 6, second fix — the first version counted density by TOKEN, not
 * ROW: on a single line with 2-5 words (e.g. fixture text-empty-items) every
 * gap between words looked like a "100% empty valley" relative to the
 * handful of tokens on that one line, falsely recognized as a gutter.
 * Density must count DISTINCT rows covering a given bin, not the raw token
 * count — and require a minimum number of rows before anything is trusted
 * (below the threshold: no meaningful data, return empty).
 */

export interface GutterHint {
  minX: number;
  maxX: number;
}

export interface SpanWithRow {
  minX: number;
  maxX: number;
  /** Row identifier (e.g. rounded cross-axis position) — the gutter is computed per ROW, not per token. */
  rowId: string | number;
}

const HISTOGRAM_BIN_WIDTH_PT = 2;
const MAX_VALLEY_ROW_RATIO = 0.05;
/**
 * [Step 6, discovery] A lower threshold than in `detectColumns` (10pt there) —
 * this hint operates on RAW TOKENS (noisier than Z3's finished lines), and
 * its error in one direction is cheap (worst case, it unnecessarily splits a
 * line with an unusually wide gap), while in the other direction it's costly
 * (a silent bug merging columns into text). Measured on
 * Cienie_posrod_mgie.pdf p. 20: the true ~10pt gutter on raw tokens
 * sometimes measures a bit narrower than on the final lines (a wider token
 * overlaps the edge of the gutter), so at threshold=10pt the whole candidate
 * was rejected and the merge came back.
 */
const MIN_VALLEY_WIDTH_PT = 6;
/** Below this many DISTINCT rows the histogram has no statistical power at all — return no hint. */
const MIN_ROWS_FOR_GUTTER_HINT = 3;

export function findLikelyGutters(spans: readonly SpanWithRow[]): GutterHint[] {
  const rowIds = new Set(spans.map((s) => s.rowId));
  if (rowIds.size < MIN_ROWS_FOR_GUTTER_HINT) return [];

  const blockMinX = Math.min(...spans.map((s) => s.minX));
  const blockMaxX = Math.max(...spans.map((s) => s.maxX));
  const width = blockMaxX - blockMinX;
  if (width <= 0) return [];

  const binCount = Math.max(1, Math.ceil(width / HISTOGRAM_BIN_WIDTH_PT));
  const rowsByBin: Set<string | number>[] = Array.from({ length: binCount }, () => new Set());
  for (const s of spans) {
    const startBin = Math.floor((s.minX - blockMinX) / HISTOGRAM_BIN_WIDTH_PT);
    const endBin = Math.floor((s.maxX - blockMinX) / HISTOGRAM_BIN_WIDTH_PT);
    for (let b = Math.max(0, startBin); b <= Math.min(binCount - 1, endBin); b++) rowsByBin[b]!.add(s.rowId);
  }

  const totalRows = rowIds.size;
  const valleyThreshold = Math.max(0, Math.floor(totalRows * MAX_VALLEY_ROW_RATIO));
  const minValleyBins = Math.ceil(MIN_VALLEY_WIDTH_PT / HISTOGRAM_BIN_WIDTH_PT);

  const gutters: GutterHint[] = [];
  let runStart: number | null = null;
  for (let b = 0; b < binCount; b++) {
    const isLow = rowsByBin[b]!.size <= valleyThreshold;
    if (isLow && runStart === null) runStart = b;
    if (!isLow && runStart !== null) {
      if (runStart > 0 && b - runStart >= minValleyBins) {
        gutters.push({ minX: blockMinX + runStart * HISTOGRAM_BIN_WIDTH_PT, maxX: blockMinX + b * HISTOGRAM_BIN_WIDTH_PT });
      }
      runStart = null;
    }
  }
  // A gutter open all the way to the right edge of the block is margin, not an inter-column gutter (as in detectColumns) — skipped.

  return gutters;
}
