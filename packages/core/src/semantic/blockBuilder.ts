import { rectsOverlap, unionRect, type Rect } from '../geometry.js';
import type { FontRole } from '../inventory/fontRegistry.js';
import type { VectorRegion } from '../inventory/vectorRegistry.js';
import type { ColumnRegion } from '../layout/columns.js';
import type { OrderedLine } from '../layout/readingOrder.js';
import type { TextLine } from '../layout/lineCluster.js';
import type { StreamAngle } from '../text/types.js';

/**
 * Merging lines into semantic blocks + `BlockKind` classification (Step 6
 * Z6, MDD §5.2). Closes phase 2. Block boundaries: line spacing above a
 * multiple TYPICAL for the given font (computed from this page's
 * distribution, not a constant), first-line indent, a change of the
 * dominant font key, a column/stream boundary, the edge of a vector region
 * (U3 — the first real use of vector regions, see RAPORT-KROK-5/6.md).
 */

export type BlockKind =
  | 'heading'
  | 'body'
  | 'statblock'
  | 'table'
  | 'sidebar'
  | 'caption'
  | 'header'
  | 'footer'
  | 'marginalia'
  | 'unknown';

export interface SemanticBlock {
  id: string;
  kind: BlockKind;
  confidence: number;
  pageNumber: number;
  bbox: Rect;
  angle: StreamAngle;
  lines: TextLine[];
  rawText: string;
  headingLevel?: number;
  /** Which rule caught this block — the MDD directly requires this for debuggability. */
  matchedRuleId?: string;
}

export interface ImageBBoxOnPage {
  bbox: Rect;
}

export interface BlockBuilderInput {
  pageNumber: number;
  /** The result of Z4 (buildReadingOrder) — already in correct reading order, with columnIndex set. */
  orderedLines: readonly OrderedLine[];
  fontRoles: ReadonlyMap<string, FontRole>;
  /** Vector regions of THIS page (from InventoryResult, step 4). */
  vectors: readonly VectorRegion[];
  /** Image bboxes of THIS page (from InventoryResult, simplified to just the bbox). */
  images: readonly ImageBBoxOnPage[];
  /** lineId -> 'header'|'footer' from Z5 — ONLY lines actually confirmed as running elements. */
  runningElementKindByLineId: ReadonlyMap<string, 'header' | 'footer'>;
  /** Columns of THIS page (Z3) — used by `sidebar` to check "off to the side of the column layout". */
  columns: readonly ColumnRegion[];
}

/** Line spacing ABOVE this multiple of the median splits a block (a P1-like rule: a threshold from the data, not a constant). */
const LINE_GAP_BREAK_MULTIPLIER = 1.8;
const MIN_GAP_SAMPLES_FOR_MEDIAN = 3;
/** First-line indent ABOVE this threshold (pt) treated as a signal of a new block/paragraph. */
const INDENT_BREAK_THRESHOLD_PT = 8;
/** 5+ dots or middle dots in a row — the signature of a dot-leader (tables of contents/tables). */
const DOT_LEADER_RE = /[.·]{5,}/;
const MAX_TABLE_LINE_LENGTH = 40;
/** [Step 9 Z1a] A gap ABOVE this multiple of the typical line spacing counts as vertical isolation (a heading). */
const ISOLATION_GAP_MULTIPLIER = 1.5;

interface LineWithContext {
  ordered: OrderedLine;
  fontKey: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Distance between two consecutive lines along the reading axis (approximated from crossAxisPosition — works for 0°/90°/180°/270°). */
function lineGap(a: TextLine, b: TextLine): number {
  return Math.abs(a.crossAxisPosition - b.crossAxisPosition);
}

function computeTypicalGap(lines: readonly OrderedLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const curr = lines[i]!;
    if (prev.line.columnIndex !== curr.line.columnIndex || prev.streamAngle !== curr.streamAngle) continue;
    gaps.push(lineGap(prev.line, curr.line));
  }
  if (gaps.length < MIN_GAP_SAMPLES_FOR_MEDIAN) return 0;
  return median(gaps);
}

/** The "across the reading axis" position (indent) — for 0°/180° this is X, approximated by the bbox's minX. */
function lineIndent(line: TextLine): number {
  return line.bbox.minX;
}

function shouldBreak(prev: LineWithContext, curr: LineWithContext, typicalGap: number): boolean {
  if (prev.ordered.line.columnIndex !== curr.ordered.line.columnIndex) return true; // column boundary
  if (prev.ordered.streamAngle !== curr.ordered.streamAngle) return true; // stream boundary
  if (prev.fontKey !== curr.fontKey) return true; // change of dominant font key
  if (typicalGap > 0) {
    const gap = lineGap(prev.ordered.line, curr.ordered.line);
    if (gap > typicalGap * LINE_GAP_BREAK_MULTIPLIER) return true; // line spacing above the typical multiple
  }
  if (Math.abs(lineIndent(curr.ordered.line) - lineIndent(prev.ordered.line)) > INDENT_BREAK_THRESHOLD_PT) return true; // indent
  return false;
}

function splitByVectorRegionEdges(group: OrderedLine[], vectors: readonly VectorRegion[]): OrderedLine[][] {
  if (vectors.length === 0 || group.length === 0) return [group];
  const regionOf = (line: TextLine): VectorRegion | null => {
    for (const v of vectors) {
      if (rectsOverlap(line.bbox, v.bbox)) return v;
    }
    return null;
  };
  const groups: OrderedLine[][] = [];
  let current: OrderedLine[] = [];
  let currentRegion: VectorRegion | null = null;
  for (const ol of group) {
    const region = regionOf(ol.line);
    if (current.length > 0 && region !== currentRegion) {
      groups.push(current);
      current = [];
    }
    currentRegion = region;
    current.push(ol);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function isDotLeader(text: string): boolean {
  return DOT_LEADER_RE.test(text);
}

function isNearImage(bbox: Rect, images: readonly ImageBBoxOnPage[]): boolean {
  return images.some((img) => rectsOverlap(bbox, img.bbox) || nearby(bbox, img.bbox));
}

/** "Proximity" looser than strict overlap — a caption is usually RIGHT next to an image, not on top of it. */
function nearby(a: Rect, b: Rect): boolean {
  const margin = 20;
  const expanded: Rect = { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin };
  return rectsOverlap(a, expanded);
}

function dominantFontKey(lines: readonly TextLine[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.dominantFont.key;
    counts.set(key, (counts.get(key) ?? 0) + line.text.length);
  }
  let best = lines[0]?.dominantFont.key ?? '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * [Step 9 Z1a] Whether a group (before classification) is single-line and
 * surrounded by a clear empty margin above AND below along the reading
 * axis (the typical shape of a heading) — the absence of a neighbor in the
 * same column/stream counts as isolation (top of the column/stream, MDD
 * §5.2 rule table for `accent`).
 */
function computeIsolationFlags(groups: readonly OrderedLine[][], typicalGap: number): boolean[] {
  function gapToNeighbor(from: number, step: 1 | -1, col: number, angle: StreamAngle, selfLine: TextLine): boolean {
    for (let j = from + step; j >= 0 && j < groups.length; j += step) {
      const neighbor = groups[j]!;
      if (neighbor.length === 0) continue;
      if (neighbor[0]!.line.columnIndex !== col || neighbor[0]!.streamAngle !== angle) continue;
      const neighborLine = step === 1 ? neighbor[0]!.line : neighbor[neighbor.length - 1]!.line;
      if (typicalGap <= 0) return true;
      return lineGap(selfLine, neighborLine) > typicalGap * ISOLATION_GAP_MULTIPLIER;
    }
    return true; // no neighbor in this column/stream = top/bottom of the column/stream, treated as isolation
  }

  return groups.map((group, i) => {
    if (group.length !== 1) return false;
    const { line, streamAngle } = group[0]!;
    const col = line.columnIndex;
    return gapToNeighbor(i, -1, col, streamAngle, line) && gapToNeighbor(i, 1, col, streamAngle, line);
  });
}

/**
 * [Step 6, discovery on `samples/`] "Off to the side of the column layout"
 * (brief, BlockKind table) — a block that does NOT overlap ANY DETECTED
 * column (Z3). Without this condition, every block inside any real column
 * that happened to overlap a large decorative fill (a full-height page
 * background, common in real RPG PDFs) also ended up as `sidebar` —
 * measured on several `samples/` files: `body` counted 0 blocks across an
 * entire ~160-page document, `sidebar` >5000, because "hasColumns" was
 * almost always true (see the comment at its computation) and EVERY block
 * overlapped some fill.
 */
function isOffToTheSideOfColumns(bbox: Rect, columns: readonly ColumnRegion[]): boolean {
  if (columns.length === 0) return false;
  return columns.every((c) => !rectsOverlap(bbox, c.bbox));
}

function classify(
  lines: readonly TextLine[],
  angle: StreamAngle,
  bbox: Rect,
  fontRoles: ReadonlyMap<string, FontRole>,
  vectors: readonly VectorRegion[],
  images: readonly ImageBBoxOnPage[],
  runningKind: 'header' | 'footer' | null,
  hasColumns: boolean,
  columns: readonly ColumnRegion[],
  isIsolated: boolean,
): { kind: BlockKind; confidence: number; matchedRuleId: string } {
  if (runningKind) {
    return { kind: runningKind, confidence: 0.95, matchedRuleId: 'Z5-running-element' };
  }
  if (angle !== 0) {
    return { kind: 'marginalia', confidence: 0.85, matchedRuleId: 'Z6-marginalia-angle' };
  }

  const fontKey = dominantFontKey(lines);
  const role = fontRoles.get(fontKey) ?? 'unknown';
  const text = lines.map((l) => l.text).join(' ');

  const overlappingFill = vectors.find((v) => v.kind === 'fill' && rectsOverlap(bbox, v.bbox));
  if (overlappingFill && hasColumns && isOffToTheSideOfColumns(bbox, columns)) {
    return { kind: 'sidebar', confidence: 0.7, matchedRuleId: 'Z6-sidebar-vector-fill' };
  }

  if (isDotLeader(text)) {
    return { kind: 'table', confidence: 0.6, matchedRuleId: 'Z6-dot-leader' };
  }

  const shortLines = lines.filter((l) => l.text.trim().length > 0 && l.text.trim().length <= MAX_TABLE_LINE_LENGTH).length;
  if (lines.length >= 4 && shortLines / lines.length >= 0.8) {
    return { kind: 'table', confidence: 0.4, matchedRuleId: 'Z6-short-regular-lines' };
  }

  // [Step 9 Z1a] `accent` lumps together titles, editorial footers,
  // illustrator credits, and in-text highlights (MDD §5.2, 459/648 `unknown`
  // blocks in CP-RED had this role) — the structural rules below give it a
  // chance to land somewhere other than `unknown` BEFORE checking
  // `heading`/`body` by role alone, so that e.g. a single-line, isolated
  // `accent` block at the top of a column becomes a heading before the
  // rest of the function even sees it.
  if ((role === 'caption' || role === 'accent') && isNearImage(bbox, images)) {
    return { kind: 'caption', confidence: role === 'caption' ? 0.65 : 0.55, matchedRuleId: 'Z9-caption-near-image' };
  }

  if (role === 'heading' && lines.length <= 2) {
    return { kind: 'heading', confidence: 0.75, matchedRuleId: 'Z6-heading-role' };
  }

  if (role === 'accent' && lines.length === 1 && isIsolated) {
    return { kind: 'heading', confidence: 0.55, matchedRuleId: 'Z9-accent-isolated-heading' };
  }

  if (role === 'accent' && lines.length >= 2 && !isOffToTheSideOfColumns(bbox, columns)) {
    return { kind: 'body', confidence: 0.5, matchedRuleId: 'Z9-accent-multiline-in-column-body' };
  }

  // [Step 6, discovery on `samples/`] The brief says "body role, multiple
  // lines", but empirically MOST body-role blocks have EXACTLY 1 line
  // (short paragraphs/dialogue lines, block boundaries from
  // indent/line-spacing often cut down to single lines) — requiring >=2
  // lines dumped them into `unknown` (on Cienie_posrod_mgie.pdf: 2825 out
  // of 4562 `unknown` blocks, i.e. 62%, had the body role and exactly 1
  // line). The role already distinguishes body from heading (Step 4:
  // separate rankings), the line count is not needed for that.
  if (role === 'body') {
    return { kind: 'body', confidence: 0.8, matchedRuleId: 'Z6-body-role' };
  }

  return { kind: 'unknown', confidence: 0.3, matchedRuleId: 'Z6-unknown-fallback' };
}

/**
 * Builds `SemanticBlock[]` from the lines of ONE page already in reading
 * order (Z4). Order of steps: (1) group by column/stream/font/line-spacing
 * /indent boundaries, (2) additionally split along vector-region edges
 * (U3), (3) classify each group.
 */
export function buildSemanticBlocks(input: BlockBuilderInput): SemanticBlock[] {
  const { pageNumber, fontRoles, vectors, images, runningElementKindByLineId, columns } = input;
  if (input.orderedLines.length === 0) return [];

  // [Step 11] A mid-paragraph heading prefix is already split EARLIER, in
  // `buildPageLayout.ts` (before `splitSpanningLines`/`gutterRepair.ts`) —
  // see `layout/lineEdgeSplit.ts`. Here `orderedLines` arrives already prepared.
  const orderedLines: readonly OrderedLine[] = input.orderedLines;

  const typicalGap = computeTypicalGap(orderedLines);
  const withContext: LineWithContext[] = orderedLines.map((ol) => ({
    ordered: ol,
    fontKey: ol.line.dominantFont.key,
  }));

  const rawGroups: OrderedLine[][] = [];
  let current: OrderedLine[] = [];
  for (let i = 0; i < withContext.length; i++) {
    const ctx = withContext[i]!;
    if (current.length > 0 && shouldBreak(withContext[i - 1]!, ctx, typicalGap)) {
      rawGroups.push(current);
      current = [];
    }
    current.push(ctx.ordered);
  }
  if (current.length > 0) rawGroups.push(current);

  const groups = rawGroups.flatMap((g) => splitByVectorRegionEdges(g, vectors));
  // [Step 6, discovery] columnIndex=-1 means "spanning line/marginalia/outside
  // any detected column" (Z2/Z4), NOT "a second column" — it must be
  // filtered out, otherwise EVERY page with even one heading/spanning line
  // over single-column text (very common) would falsely count as "has
  // columns" (measured on `samples/`: without this filter, `sidebar`
  // dominated at the expense of `body` on several files).
  const hasColumns = new Set(orderedLines.map((ol) => ol.line.columnIndex).filter((idx) => idx >= 0)).size > 1;
  const isolationFlags = computeIsolationFlags(groups, typicalGap);

  const blocks: SemanticBlock[] = [];
  let blockIndex = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    if (group.length === 0) continue;
    const lines = group.map((ol) => ol.line);
    const bbox = lines.reduce<Rect | null>((acc, l) => (acc ? unionRect(acc, l.bbox) : l.bbox), null)!;
    const angle = group[0]!.streamAngle;

    const runningKinds = new Set(lines.map((l) => runningElementKindByLineId.get(l.id)).filter((k): k is 'header' | 'footer' => !!k));
    const runningKind = runningKinds.size === 1 ? [...runningKinds][0]! : null;

    const { kind, confidence, matchedRuleId } = classify(
      lines,
      angle,
      bbox,
      fontRoles,
      vectors,
      images,
      runningKind,
      hasColumns,
      columns,
      isolationFlags[g]!,
    );

    blocks.push({
      id: `p${pageNumber}-block${blockIndex++}`,
      kind,
      confidence,
      pageNumber,
      bbox,
      angle,
      lines,
      rawText: lines.map((l) => l.text).join('\n'),
      matchedRuleId,
    });
  }

  return blocks;
}
