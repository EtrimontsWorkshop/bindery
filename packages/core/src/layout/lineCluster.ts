import { textRunBBox, unionRect, type Rect } from '../geometry.js';
import { hasBoundaryBetween } from '../text/hygiene.js';
import type { FontFingerprint, WordBoundary } from '../text/types.js';
import { findLikelyGutters, type GutterHint } from './gutterHint.js';
import type { MergedToken } from './wordMerge.js';
import { axisPositions, baselineTolerance, fontSizeFromTransform, type StreamAngle } from './textGeometry.js';

/**
 * Clusters tokens (post-Z4) into lines of text (Step 5 Z5, MDD §5.1). Key idea:
 * grouping by `crossAxisPosition` — the axis PERPENDICULAR to the text
 * direction, not always Y — with a tolerance derived from font size (shared
 * with Z2/Z4, see textGeometry.ts). Superscripts/subscripts (smaller font,
 * small offset) must end up on the same line as their surroundings.
 */

export interface TextLine {
  id: string;
  text: string;
  bbox: Rect;
  /** Always -1 in step 5 — column assignment happens in step 6. */
  columnIndex: number;
  crossAxisPosition: number;
  fonts: FontFingerprint[];
  dominantFont: FontFingerprint;
  syntheticBold: boolean;
  /**
   * [Step 9 Z1b] Runs WITHIN the line in order along the reading axis —
   * contiguous groups of tokens sharing the same `fontKey`. Empty/absent =
   * a uniform line (the typical case). Exists SOLELY so `blockBuilder.ts` can
   * detect an inline heading label (a heading->body font-role transition
   * WITHIN ONE line, MDD §5.2) — `fonts`/`dominantFont` above flatten this
   * information down to a single key and carry no position. Optional (not
   * required), so as not to break existing test fixtures that build
   * `TextLine` by hand.
   */
  runs?: LineRun[];
  /**
   * [Step 10] Bbox+text of EVERY original token of this line (BEFORE
   * aggregation into `text`/`bbox`), sorted along the reading axis. Optional —
   * exists SOLELY for the `gutterRepair.ts` discriminator ("does any token
   * cross the area of a detected gutter"), with zero impact on existing
   * fixtures/tests that build `TextLine` by hand. Does not change
   * `sameLine`/clustering — purely additional output data from token bboxes
   * that are ALREADY computed.
   */
  tokens?: LineToken[];
}

/** A contiguous run of tokens of one font within a line (Step 9 Z1b) — see `TextLine.runs`. */
export interface LineRun {
  fontKey: string;
  text: string;
  bbox: Rect;
}

/** One original token of a line (Step 10) — see `TextLine.tokens`. */
export interface LineToken {
  text: string;
  bbox: Rect;
}

/** Typographic line-height ratio relative to font size — standard range is 1.2-1.5, this is the midpoint. */
const LINE_HEIGHT_RATIO = 1.35;
/** Below this size ratio a token is "smaller" — a superscript/subscript candidate. */
const SUBSCRIPT_SIZE_RATIO = 0.8;
/**
 * [Step 6, discovery] Two tokens on the SAME baseline (cross-axis) are not
 * automatically the same text LINE — a real two-column layout (and also a
 * sidebar next to a column) often has both columns' baselines aligned on the
 * same row. Without an extra condition, `sameLine` would merge adjacent
 * columns into one line spanning the whole block width (zero Z3 result: the
 * histogram never sees a valley).
 *
 * First attempt: a FIXED threshold "gap > Nx font size = different lines".
 * Rejected empirically — there is no single value N that correctly separates
 * both cases: fixture text-empill-items (group B, Step 3/5) has a
 * DELIBERATELY wide but GENUINE inter-word gap of ~2.9-3.1x font size
 * (calibrated to force a synthetic pdf.js space item), while
 * layout-2col-sidebar has a gutter of ~4x font size (narrower than between
 * the main columns) — the ranges OVERLAP, so no fixed multiplier
 * distinguishes them correctly.
 *
 * Second attempt: pdf.js's `WordBoundary` (step 5, U2) — if pdf.js itself
 * inserted an explicit whitespace item between tokens, that's evidence of a
 * genuine gap within a continuous run of text, regardless of width. ALSO
 * rejected empirically on a real file (Cienie_posrod_mgie.pdf p. 46): the
 * gutter between two columns was narrow (~12.7pt, ~1.2x font size) and pdf.js
 * INSERTED a synthetic whitespace character there (because its own "this is
 * just a gap" heuristic looks EXCLUSIVELY at geometric distance, just as
 * blind to "this is two columns" as our first attempt) — `sameLine` still
 * merged the columns into one line.
 *
 * No LOCAL signal (distance, pdf.js boundary) can resolve this reliably: a
 * narrow gutter and a wide inter-word gap look identical from the
 * perspective of a PAIR of tokens. The only reliable signal is the
 * CONSISTENCY of X positions across MANY rows at once — `findLikelyGutters`
 * (gutterHint.ts) computes exactly that, with the same histogram as Z3
 * (`detectColumns`), but BEFORE line clustering (on tokens, not lines) —
 * because Z3 proper only runs AFTER this step, on lines that are (hopefully)
 * already correctly split. The gutter hint takes PRECEDENCE over both
 * earlier attempts: a token on the other side of a detected (even if only
 * hinted) gutter is never the same line, even with a small gap or the
 * presence of a `WordBoundary`.
 */
const SAME_LINE_TRACKING_GAP_RATIO = 1;
const HYPHEN = '-';
const LOWERCASE_START_RE = /^\p{Ll}/u;

interface ClusterToken {
  token: MergedToken;
  size: number;
  along: number;
  cross: number;
}

/** Simple Union-Find — the number of tokens per page is small (tens to hundreds), not thousands. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
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

/** Gap along the reading axis between two tokens (from the end of the earlier one to the start of the later one) — can be negative when overlapping. */
function alongGap(a: ClusterToken, b: ClusterToken): number {
  const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
  return later.along - (earlier.along + earlier.token.width);
}

/** Whether some hinted gutter lies BETWEEN two tokens along the reading axis. */
function gutterBetween(a: ClusterToken, b: ClusterToken, gutters: readonly GutterHint[]): boolean {
  if (gutters.length === 0) return false;
  const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
  const gapStart = earlier.along + earlier.token.width;
  const gapEnd = later.along;
  return gutters.some((g) => g.minX < gapEnd && gapStart < g.maxX);
}

/** Whether two tokens belong to the same line — normal tolerance OR the superscript/subscript rule. */
function sameLine(a: ClusterToken, b: ClusterToken, wordBoundaries: readonly WordBoundary[], gutters: readonly GutterHint[]): boolean {
  const crossDelta = Math.abs(a.cross - b.cross);
  const biggerSize = Math.max(a.size, b.size);

  if (crossDelta <= baselineTolerance(biggerSize)) {
    // A hinted gutter takes PRECEDENCE — see the comment on SAME_LINE_TRACKING_GAP_RATIO.
    if (gutterBetween(a, b, gutters)) return false;
    // Sharing a baseline is NOT ENOUGH on its own — a small gap is always OK
    // (touching runs), a larger one requires an explicit pdf.js boundary (a
    // genuine, if wide, inter-word gap).
    const gap = alongGap(a, b);
    if (gap <= biggerSize * SAME_LINE_TRACKING_GAP_RATIO) return true;
    const [earlier, later] = a.along <= b.along ? [a, b] : [b, a];
    const earlierLastIndex = earlier.token.sourceIndices[earlier.token.sourceIndices.length - 1]!;
    const laterFirstIndex = later.token.sourceIndices[0]!;
    return hasBoundaryBetween(wordBoundaries, earlierLastIndex, laterFirstIndex);
  }

  // Superscript/subscript: one token CLEARLY smaller, offset smaller than the larger one's line height.
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size / larger.size <= SUBSCRIPT_SIZE_RATIO && crossDelta < larger.size * LINE_HEIGHT_RATIO) {
    return true;
  }
  return false;
}

function buildFontFingerprints(tokens: readonly ClusterToken[]): { fonts: FontFingerprint[]; dominantFont: FontFingerprint } {
  const byKey = new Map<string, { size: number; charCount: number }>();
  for (const t of tokens) {
    const acc = byKey.get(t.token.fontKey) ?? { size: t.size, charCount: 0 };
    acc.charCount += t.token.str.length;
    byKey.set(t.token.fontKey, acc);
  }
  const fonts: FontFingerprint[] = [...byKey.entries()]
    .map(([key, acc]) => ({ key, size: acc.size }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const dominantKey = [...byKey.entries()].reduce((best, curr) => (curr[1].charCount > best[1].charCount ? curr : best))[0];
  const dominantFont = fonts.find((f) => f.key === dominantKey)!;
  return { fonts, dominantFont };
}

/**
 * [Step 9 Z1b] Groups tokens ALREADY SORTED along the reading axis into
 * contiguous runs of the same `fontKey` — raw material for detecting a
 * font-role transition (e.g. heading->body) within a single line in
 * `blockBuilder.ts`.
 */
function buildLineRuns(sorted: readonly ClusterToken[], wordBoundaries: readonly WordBoundary[]): LineRun[] {
  const runs: LineRun[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i]!.token.fontKey === sorted[start]!.token.fontKey) continue;
    const chunk = sorted.slice(start, i);
    const bbox = chunk
      .map((t) => textRunBBox(t.token.transform as [number, number, number, number, number, number], t.token.width, t.token.height))
      .reduce((acc, r) => (acc ? unionRect(acc, r) : r), null as Rect | null)!;
    runs.push({ fontKey: chunk[0]!.token.fontKey, text: joinTokenText(chunk, wordBoundaries), bbox });
    start = i;
  }
  return runs;
}

/** Joins a line's tokens into text, inserting a space ONLY where there was a genuine word boundary between them (Z1/U2). */
function joinTokenText(sorted: readonly ClusterToken[], wordBoundaries: readonly WordBoundary[]): string {
  let text = '';
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i]!.token;
    if (i > 0) {
      const prev = sorted[i - 1]!.token;
      const prevLastIndex = prev.sourceIndices[prev.sourceIndices.length - 1]!;
      const currFirstIndex = curr.sourceIndices[0]!;
      if (hasBoundaryBetween(wordBoundaries, prevLastIndex, currFirstIndex)) text += ' ';
    }
    text += curr.str;
  }
  return text;
}

/**
 * Clusters tokens from ONE angular stream into lines. Assumes the tokens are
 * already past Z4 (word merging) for the same angle — the caller supplies
 * them per stream, just as Z4 does.
 */
export function clusterIntoLines(
  tokens: readonly MergedToken[],
  angle: StreamAngle,
  wordBoundaries: readonly WordBoundary[],
  pageNumber: number,
): TextLine[] {
  const clusterTokens: ClusterToken[] = tokens.map((token) => {
    const { along, cross } = axisPositions(token.transform, angle);
    return { token, size: fontSizeFromTransform(token.transform), along, cross };
  });

  // Gutter hint ONLY for the primary stream (0°) — that's where `along` = the
  // real page's X, and the concept of columns makes sense (see gutterHint.ts).
  // rowId = rounded cross-axis position (the same mechanism as
  // bucketByBaseline in wordMerge.ts) — the gutter hint must count DISTINCT
  // rows, not tokens.
  const gutters: GutterHint[] =
    angle === 0
      ? findLikelyGutters(
          clusterTokens.map((t) => ({
            minX: t.along,
            maxX: t.along + t.token.width,
            rowId: Math.round(t.cross / baselineTolerance(t.size)),
          })),
        )
      : [];

  const uf = new UnionFind(clusterTokens.length);
  for (let i = 0; i < clusterTokens.length; i++) {
    for (let j = i + 1; j < clusterTokens.length; j++) {
      if (sameLine(clusterTokens[i]!, clusterTokens[j]!, wordBoundaries, gutters)) uf.union(i, j);
    }
  }

  const groups = new Map<number, ClusterToken[]>();
  for (let i = 0; i < clusterTokens.length; i++) {
    const root = uf.find(i);
    const arr = groups.get(root) ?? [];
    arr.push(clusterTokens[i]!);
    groups.set(root, arr);
  }

  const lines: TextLine[] = [];
  for (const groupTokens of groups.values()) {
    const sorted = [...groupTokens].sort((a, b) => a.along - b.along);
    const { fonts, dominantFont } = buildFontFingerprints(sorted);
    const tokenBBoxes = sorted.map((t) =>
      textRunBBox(t.token.transform as [number, number, number, number, number, number], t.token.width, t.token.height),
    );
    const bbox = tokenBBoxes.reduce((acc, r) => (acc ? unionRect(acc, r) : r), null as Rect | null)!;

    // Cross-axis position representative of the line: from the dominant (most common) font, not an average (robust against superscripts/subscripts).
    const dominantTokens = sorted.filter((t) => t.token.fontKey === dominantFont.key);
    const crossAxisPosition = dominantTokens[0]?.cross ?? sorted[0]!.cross;

    lines.push({
      id: `p${pageNumber}-${angle}-${lines.length}`,
      text: joinTokenText(sorted, wordBoundaries),
      bbox,
      columnIndex: -1,
      crossAxisPosition,
      fonts,
      dominantFont,
      syntheticBold: sorted.some((t) => t.token.syntheticBold),
      runs: buildLineRuns(sorted, wordBoundaries),
      tokens: sorted.map((t, i) => ({ text: t.token.str, bbox: tokenBBoxes[i]! })),
    });
  }

  // Reading order: along the PERPENDICULAR axis (lines go "down" the stream); for 0°/90° cross increases downward/rightward
  // in PDF space (Y increases upward), so reading order means decreasing Y for 0°/180°, increasing X for 90°/270°.
  const readingOrderSign = angle === 0 || angle === 180 ? -1 : 1;
  lines.sort((a, b) => readingOrderSign * (a.crossAxisPosition - b.crossAxisPosition));
  lines.forEach((line, i) => {
    line.id = `p${pageNumber}-${angle}-${i}`;
  });

  return joinHyphenatedLineWraps(lines, gutters);
}

/** Whether some hinted gutter lies BETWEEN two bboxes along X (like `gutterBetween`, but on already-formed lines). */
function gutterBetweenBBoxes(a: Rect, b: Rect, gutters: readonly GutterHint[]): boolean {
  if (gutters.length === 0) return false;
  const [earlier, later] = a.minX <= b.minX ? [a, b] : [b, a];
  return gutters.some((g) => g.minX < later.minX && earlier.maxX < g.maxX);
}

/**
 * Joins a word hyphenated at the end of a line with the start of the next one —
 * AFTER lines have been formed (per the brief, Z5). Condition: the line ends
 * with a plain hyphen U+002D AND the next line starts with a lowercase letter
 * (a safeguard against merging a genuine dash in a title, e.g. "Chapter
 * One-Two").
 *
 * [Step 6, discovery] Without the gutter check, this used to merge the end of
 * a line from the RIGHT column with the start of a line from the LEFT column
 * of the next row in the global Y-sort (which knows nothing about columns) —
 * whenever the right column ended with a hyphen and the next line in the sort
 * (from any column at all) started with a lowercase letter. Measured on a
 * real file (Cienie_posrod_mgie.pdf p. 46): a hyphenated word fragment ending
 * the right column's line
 * merged with the start of an unrelated line from the LEFT column (a completely different piece of
 * text) into one fictitious, glued-together word.
 */
function joinHyphenatedLineWraps(lines: readonly TextLine[], gutters: readonly GutterHint[]): TextLine[] {
  const result: TextLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (result.length > 0) {
      const prev = result[result.length - 1]!;
      if (prev.text.endsWith(HYPHEN) && LOWERCASE_START_RE.test(line.text) && !gutterBetweenBBoxes(prev.bbox, line.bbox, gutters)) {
        const continuationMatch = /^\S+/.exec(line.text);
        const continuation = continuationMatch ? continuationMatch[0] : line.text;
        prev.text = prev.text.slice(0, -1) + continuation;
        prev.bbox = unionRect(prev.bbox, line.bbox);
        // Approximation: we append the WHOLE runs of the next line, without
        // splitting its first run into a "consumed by the continuation" part
        // and a "remainder" part — the rare coincidence (a hyphen break
        // EXACTLY at a font-role transition) didn't justify precise slicing
        // of the run's text.
        prev.runs = [...(prev.runs ?? []), ...(line.runs ?? [])];
        prev.tokens = [...(prev.tokens ?? []), ...(line.tokens ?? [])];
        const remainder = line.text.slice(continuation.length).replace(/^\s+/, '');
        if (remainder.length > 0) {
          result.push({ ...line, text: remainder });
        }
        continue;
      }
    }
    result.push({ ...line });
  }
  return result;
}
