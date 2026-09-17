import type { Rect } from '../geometry.js';

/**
 * [Step 24 Z1, "biggest payoff" per the brief] Pattern inference from a mouse
 * SELECTION — instead of the profile author typing labels FROM MEMORY (step 23
 * showed where that leads: omitting two genuine labels lying BETWEEN
 * two remembered ones gave `derived: 0 hits` across the whole book, caught
 * only by diagnostics AFTER the fact), the author DRAWS AROUND an area, and Studio
 * PROPOSES — the author only confirms/corrects what the tool found.
 *
 * The input is ALREADY-filtered tokens (those whose bbox center lies
 * inside the selected rectangle on the page — the caller does the geometric
 * filtering, `ProfileStudio.ts`, since it requires `screenRectToPdf`/the geometry
 * of a specific page, outside the scope of this purely textual file), in
 * STREAM ORDER (as everywhere in this directory — S3).
 */

export interface SelectionToken {
  text: string;
  bbox: Rect;
  /** [Step 29 Z3] Carrier font key (see `ProfileToken.fontKey`, `types.ts`) — input for learning `fontRoleCandidate.requireFontKeys` from a click in Profile Studio. */
  fontKey?: string;
}

/**
 * [Step 28 Z2/Z3, bug measured live, NARROWED after a regression] pdf.js sometimes
 * splits ONE printed word into several `TextItem`s, when in its middle
 * the font/glyph encoding changes (typically: a diacritic character outside
 * the base set, e.g. a personal name -> a bare ASCII initial + the
 * accented remainder as TWO touching
 * tokens). Measured live (p. 23, "Zew Cthulhu 7ed. Wrak.pdf"): clicking
 * on what visually is one such name produced
 * `terminateSectionBefore: "^J$"` — matches EVERY lone "J" in the whole
 * book, an accidental boundary.
 *
 * [Regression, measured live IMMEDIATELY after the first version] The first
 * version merged EVERY pair of touching tokens, regardless of their
 * length — on a different page of the same book (a short section heading)
 * this suddenly made it UNCLICKABLE: the genuine heading merged with the neighboring
 * word (the inter-word spacing in this PDF, encoded as a number adjustment
 * in the `TJ` operator, not as a separate space glyph, can be GEOMETRICALLY equal
 * to zero even though it's VISUALLY two words) and exceeded `PICKABLE_MAX_LENGTH`
 * (40 characters) in `ProfileStudio.ts`, so it stopped getting a clickable
 * rectangle at all. Fix: merge ONLY when AT LEAST ONE
 * side of the join is a SHORT fragment (<= `SHORT_FRAGMENT_MAX_LENGTH`
 * characters) — exactly the signature of a genuine diacritic split (one
 * isolated character/a few characters), never two full, normal-length
 * words that simply happen to sit tightly next to each other in this particular
 * typeset. A false negative (the rare case of a word split exactly
 * in half into two longer parts) costs a return to the old symptom — the same
 * class of problem as before this step, not a new failure. A false positive
 * (merging two genuine words) costs a complete loss of clickability —
 * hence the threshold's asymmetry toward caution.
 */
const TOUCHING_GAP_PT = 1.5;
const SHORT_FRAGMENT_MAX_LENGTH = 2;

export function mergeTouchingTokens(tokens: readonly SelectionToken[]): SelectionToken[] {
  const merged: SelectionToken[] = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (prev) {
      const gap = t.bbox.minX - prev.bbox.maxX;
      const sameLine = Math.min(prev.bbox.maxY, t.bbox.maxY) - Math.max(prev.bbox.minY, t.bbox.minY) > 0;
      const looksLikeGlyphSplit = prev.text.length <= SHORT_FRAGMENT_MAX_LENGTH || t.text.length <= SHORT_FRAGMENT_MAX_LENGTH;
      if (sameLine && gap <= TOUCHING_GAP_PT && looksLikeGlyphSplit) {
        merged[merged.length - 1] = {
          text: prev.text + t.text,
          bbox: { minX: prev.bbox.minX, maxX: t.bbox.maxX, minY: Math.min(prev.bbox.minY, t.bbox.minY), maxY: Math.max(prev.bbox.maxY, t.bbox.maxY) },
          fontKey: prev.fontKey ?? t.fontKey,
        };
        continue;
      }
    }
    merged.push({ text: t.text, bbox: t.bbox, fontKey: t.fontKey });
  }
  return merged;
}

export type LabelledPairConfidence = 'high' | 'low';

export interface LabelledPairSuggestion {
  label: string;
  value: string;
  /** Label index WITHIN the passed `tokens` array (not in the whole-page stream) — for highlighting/unchecking in the UI. */
  index: number;
  bbox: Rect;
  /**
   * [Step 25 Z1] `'high'` — the value looks like a number/–/— (the old, only
   * rule from step 24). `'low'` — the value is ANYTHING ELSE that itself doesn't
   * look like prose (isn't a sentence, isn't too long) — loosened after a
   * gap measured directly: p. 57, a "damage modifier"-style label whose
   * value is dice notation (e.g. a signed number plus a die-size code)
   * wasn't proposed at all in step 24, even though THAT step's brief
   * explicitly asked for the opposite tradeoff ("prefer an excess of proposals over
   * their absence — a false positive costs one click, a false negative
   * costs a bug in the profile"). ONLY for display in the UI (unchecking
   * still works identically for both confidence levels) — never for filtering.
   */
  confidence: LabelledPairConfidence;
}

/**
 * [Heuristic from the step-24 brief, LOOSENED in step 25 Z1] Label: a short
 * token with a letter (unchanged since step 24 — LABEL_MAX_LENGTH deliberately generous,
 * longer than the longest real label measured in the project, a two-word
 * "damage modifier"-style label, 20 characters). Value: the step-24 brief said "a number or –/—" —
 * measured directly as TOO NARROW (p. 57, `scratch-z1-verify.ts` from step
 * 24): that same label's dice-notation value is not a number, so this whole line
 * of the derived-stats block never made it onto the checklist. This step (brief, verbatim:
 * "the value pattern is anything that itself does NOT look like a label")
 * replaces that with two-tier acceptance: `'high'` for the old, strict
 * numeric pattern, `'low'` for EVERYTHING ELSE that isn't prose (doesn't end with
 * a period/exclamation mark/question mark — the same "this isn't a single
 * value, it's a sentence" signal as `entityName.ts`'s name-candidate filter — and
 * isn't too long). A false positive costs one uncheck (the checkbox
 * works identically for both confidence levels), a false negative cost a
 * WHOLE skipped line — the step-25 brief explicitly prefers the former.
 */
const NUMERIC_OR_DASH_VALUE = /^[-–—]$|^[+-]?\d{1,4}([./]\d{1,4})?\*?$/;
const LABEL_MAX_LENGTH = 30;
const LABEL_HAS_LETTER = /\p{L}/u;
const VALUE_MAX_LENGTH = 40;
/**
 * [Step 43, bug measured live, p. 91, one of the sample adventures: an
 * armor field whose value was a short conventional "none"-style answer
 * ending in a period]
 * A trailing exclamation/question mark is STILL a hard signal of prose (statistics
 * never end that way) — but a bare PERIOD also ends short,
 * one-word conventional answers in this game (a "None."-style answer, the
 * same meaning as "0"/"—"), not just sentences. The original version (Step 25 Z1)
 * rejected EVERY period as "this is a sentence" — on this PDF it therefore rejected
 * that short answer for the armor field, and the engine kept searching and substituted the NEXT label
 * (the following field's label) as the value. The distinction: a genuine sentence has MORE THAN
 * `SHORT_ANSWER_MAX_WORDS` real words (counted the same way as everywhere in this
 * project — see `MAX_TRAILING_WORDS` in `patterns.ts` — because pdf.js sometimes
 * merges a whole line into one token), a short answer does not.
 */
const HARD_SENTENCE_ENDING = /[!?]$/;
const SHORT_ANSWER_MAX_WORDS = 2;
// [Step 34, bug measured live, "Wrak.pdf" p. 24, an armor field] A token
// ENDING with a colon is (in this and every other book measured in this
// project) the label of the NEXT pair, never a genuine value — measured
// directly: when the author's selection didn't cover the genuine value of
// the armor label
// (a long, wrapped token combining a number with a clause describing an
// unusual defensive trait, rejected above as
// too long for a LABEL in the NEXT iteration), the loosened "low"
// classification (Step 25 Z1, for notation like a dice-notation value) accepted the next token IN THE SELECTION
// — which happened to be an unrelated field's label — as the "value" for
// the armor label,
// showing the author a misleading proposal linking the armor label directly
// to that unrelated label. This exclusion
// costs one rare, genuine case (a value that itself ends with a
// colon — never measured in any book in this project), and fixes a
// much more common one: an incomplete author selection never substitutes
// someone else's label as anyone's value.
const LOOKS_LIKE_LABEL = /:$/;

export function classifyValue(text: string): LabelledPairConfidence | null {
  if (text.length === 0) return null;
  if (NUMERIC_OR_DASH_VALUE.test(text)) return 'high';
  if (text.length > VALUE_MAX_LENGTH || HARD_SENTENCE_ENDING.test(text) || LOOKS_LIKE_LABEL.test(text)) return null;
  if (/\.$/.test(text)) {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > SHORT_ANSWER_MAX_WORDS) return null;
  }
  return 'low';
}

/**
 * [Step 42, bug measured live, a different sample PDF, p.
 * 15] The same mechanism as `mergeDiacriticSplitTokens` in `tokenizePage.ts`
 * (CLAUDE.md: "getTextContent() merges adjacent glyphs into one TextItem
 * purely by position"), but in the OPPOSITE direction: on this PDF (a different
 * generator/typesetting than "Wrak.pdf") the attribute grid is printed
 * tightly enough (a short all-caps attribute abbreviation immediately
 * followed by its numeric value, no colon, no wide space between the label and
 * the value) that pdf.js's OWN glyph-merging combines the label and value into
 * ONE TextItem, BEFORE anything in this project even sees a token —
 * measured directly (a spike: `getPageTextTokens` with no further processing
 * already returns such a merged label-and-value string as a single token). The entire `labelledPairs`
 * engine (`matchLabelledPairs`, `inferLabelledPairsFromTokens`,
 * `findValueCandidatesNearLabel`) assumes TWO separate tokens (label,
 * value) — without splitting it back apart, it gets 0 matches across the whole
 * document, even though the layout VISUALLY looks identical to the working
 * "Wrak.pdf".
 *
 * Splits ONLY the shape "<short-word><space><number or
 * dash>", matched against the ENTIRE token text (not in the middle of a longer
 * sentence — a `$` at the end of the pattern) — the same value shape as
 * `NUMERIC_OR_DASH_VALUE` above, so the PRODUCTION engine and the preview in
 * Studio see THE SAME split (A10 — one mechanism, not two
 * diverging copies; called both from `tokenizePage.ts` and from
 * `ProfileStudio.ts`'s `#getBuildTokens`). The X boundary between the halves is
 * APPROXIMATE (proportional to character count, not to the true
 * glyph geometry, which `getTextContent()` doesn't expose) — accurate
 * enough for clicking/highlighting, the same tradeoff as
 * `descriptionText` in `patterns.ts` (Step 34), where nobody reconstructs
 * the exact geometry of a split token either.
 */
const MERGED_LABEL_VALUE = /^(\p{L}[\p{L}]{0,11})\s+([-–—]|[+-]?\d{1,4}(?:[./]\d{1,4})?\*?)$/u;

export function splitMergedLabelValueTokens<T extends { text: string; bbox: Rect }>(tokens: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of tokens) {
    const trimmed = t.text.trim();
    const m = MERGED_LABEL_VALUE.exec(trimmed);
    if (!m) {
      out.push(t);
      continue;
    }
    const labelText = m[1]!;
    const valueText = m[2]!;
    const frac = labelText.length / trimmed.length;
    const splitX = t.bbox.minX + (t.bbox.maxX - t.bbox.minX) * frac;
    out.push({ ...t, text: labelText, bbox: { ...t.bbox, maxX: splitX } });
    out.push({ ...t, text: valueText, bbox: { ...t.bbox, minX: splitX } });
  }
  return out;
}

/**
 * [Step 43, bug measured live, p. 91, one of the sample adventures: two
 * adjacent bold mini-labels in a statblock, one for armor and one for
 * carried gear]
 * When a label is set in a DIFFERENT typeface/boldness than its value
 * (a typical rendering of bold mini-labels in statblocks: a bold label
 * followed by a plain-text "None." answer), pdf.js sometimes puts the boundary between two TextItems RIGHT BEFORE
 * the colon instead of AFTER it — the label ends up WITHOUT a colon, and
 * the colon (plus space) lands at the START of the NEXT token,
 * instead of at the end of the label as usual in this project (see
 * `LOOKS_LIKE_LABEL` above, which checks ONLY the end of the label, not
 * the start of the value). Measured directly: without removing this colon,
 * the short "None."-style answer (with a leading colon+space) would still get rejected as a
 * short answer, and the engine would keep searching and substitute the NEXT label
 * (the following mini-label) as the value for the armor label.
 *
 * Removes such a stray colon FROM THE START of every token — globally,
 * at the same layer as `splitMergedLabelValueTokens` above
 * (`tokenizePage.ts` AND `ProfileStudio.ts`'s `#getBuildTokens`), so the
 * production engine and the preview in Studio see the same, cleaned-up
 * stream (A10 — one mechanism). Safe globally: genuine text
 * (prose, headers, names) in no book measured in this project
 * starts with a colon.
 */
const STRAY_LEADING_COLON = /^:\s*/;

export function stripStrayLeadingColonTokens<T extends { text: string }>(tokens: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of tokens) {
    if (!t.text.startsWith(':')) {
      out.push(t);
      continue;
    }
    const stripped = t.text.replace(STRAY_LEADING_COLON, '');
    if (stripped.length === 0) continue;
    out.push({ ...t, text: stripped });
  }
  return out;
}

export function inferLabelledPairsFromTokens(tokens: readonly SelectionToken[]): LabelledPairSuggestion[] {
  const out: LabelledPairSuggestion[] = [];
  let i = 0;
  while (i < tokens.length - 1) {
    const label = tokens[i]!;
    const value = tokens[i + 1]!;
    const labelText = label.text.trim();
    const valueText = value.text.trim();
    if (labelText.length === 0 || labelText.length > LABEL_MAX_LENGTH || !LABEL_HAS_LETTER.test(labelText)) {
      i++;
      continue;
    }
    const confidence = classifyValue(valueText);
    if (!confidence) {
      i++;
      continue;
    }
    // [Step 25 Z1, bug measured directly in its own fix] The loosened value
    // classification accepts ALMOST ANY short token — including a token JUST
    // consumed as the VALUE of the previous pair, if it itself contains a letter
    // (e.g. a dice-notation value like "+1D4" has a letter in the die-size
    // code, so without this skip it would itself become
    // the "label" for the NEXT token, the following field's label -> a
    // false pair linking the dice-notation value to that next label). After matching a pair we skip BOTH of its tokens, instead of
    // advancing by one — the same "pairs split the stream without
    // overlap" model as the real engine's inner loop (`matchLabelledPairs`).
    out.push({ label: labelText, value: valueText, index: i, bbox: label.bbox, confidence });
    i += 2;
  }
  return out;
}

export interface SectionListSuggestion {
  header: string;
  /** The remaining selection tokens (AFTER the header) as text to review — ONLY a preview (brief: "don't generate regexes for itemPattern", entry structure too variable). */
  itemsPreview: string;
  headerBbox: Rect;
}

/** [Brief, verbatim] "For sectionList — the first token as the header candidate, the rest as entries." `null` when the selection is empty. */
export function inferSectionListFromTokens(tokens: readonly SelectionToken[]): SectionListSuggestion | null {
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  return { header: first!.text.trim(), itemsPreview: rest.map((t) => t.text).join(' '), headerBbox: first!.bbox };
}

/**
 * [Step 28 Z2] Building a label-value pair by a POINT, not an area
 * selection — clicking a label in the PDF should read off the adjacent
 * value by itself. The input is ALL tokens of the page (not an already-filtered
 * selection as above), with the index in the stream (for building the
 * label→value link and for `findTerminateTokenAtY` below).
 */
export interface IndexedSelectionToken extends SelectionToken {
  /** Token index in the FULL page stream (not in the passed array). */
  tokenIndex: number;
}

export interface ValueCandidate {
  text: string;
  bbox: Rect;
  tokenIndex: number;
  confidence: LabelledPairConfidence;
}

function verticalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
}

function horizontalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
}

/**
 * [Step 28 Z2, "use gapStatistics, not a constant"] `gapStatistics.ts` operates
 * on RAW pdf.js TextItem metrics (transform/fontKey/width) — Profile
 * Studio deliberately does NOT have access to them at this stage (`getPageTextTokens`,
 * Step 23, intentionally LIGHTER than a full inventory pass, so that clicking
 * a single token doesn't cost as much as analyzing the whole page). Instead of
 * a full per-font histogram classification, the median of observed gaps
 * BETWEEN NEIGHBORING TOKENS ON THE SAME LINE on THIS page —
 * DERIVED from the document, not a constant, but computable from the bboxes we
 * already have. The `DEFAULT_ROW_GAP_PT` constant is ONLY a fallback for when a page
 * has no measurable pair at all (e.g. a single column of text with no two
 * tokens next to each other).
 */
const DEFAULT_ROW_GAP_PT = 20;
const MAX_MEASURABLE_GAP_PT = 200;

export function estimateTypicalRowGapPt(tokens: readonly SelectionToken[]): number {
  const gaps: number[] = [];
  const sorted = [...tokens].sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (verticalOverlap(a.bbox, b.bbox) <= 0) continue;
    const gap = b.bbox.minX - a.bbox.maxX;
    if (gap > 0 && gap < MAX_MEASURABLE_GAP_PT) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_ROW_GAP_PT;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

const ROW_GAP_CUTOFF_MULTIPLIER = 4;
const MAX_VALUE_CANDIDATES = 3;

/**
 * Candidates for a value AFTER clicking a label: first the same line, within
 * range of `typicalRowGapPt * ROW_GAP_CUTOFF_MULTIPLIER` to the right (brief:
 * "a candidate to the right... within a range matching the typical gap") —
 * a generous multiplier, because a false candidate costs one click on another
 * one (A10), while having none costs a silent failure. If nothing is on the row, check
 * the COLUMN below (a vertical layout). Returns up to three candidates in
 * order of distance — if there's exactly one, the caller can
 * apply it automatically; more than one = show them for clicking, don't guess.
 */
/**
 * [Step 28, bug measured on a real sample page in its own first
 * version] Without this threshold: since `classifyValue` deliberately accepts ALMOST
 * ANY short token as a low-confidence value (to avoid rejecting
 * dice notation/descriptions — see `classifyValue` above), scanning the WHOLE
 * row up to `cutoff` would also return the NEXT LABEL as an "extra
 * candidate" (e.g. clicking one attribute abbreviation on a densely-packed
 * attribute row returned the next abbreviation and its value too, instead
 * of a clean single value) — because that next abbreviation itself also passes
 * the loose "anything that isn't prose" classification. Fix: the FIRST
 * qualifying token ALWAYS ends the scan in that direction; the next one
 * joins as a GENUINE alternative candidate ONLY if it lies almost
 * as close (in practice: two value columns side by side), not
 * "anywhere within the cutoff range".
 */
const CLOSE_ENOUGH_DISTANCE_MULTIPLIER = 1.5;

export function findValueCandidatesNearLabel(tokens: readonly IndexedSelectionToken[], labelBbox: Rect, typicalRowGapPt: number): ValueCandidate[] {
  const cutoff = typicalRowGapPt * ROW_GAP_CUTOFF_MULTIPLIER;
  const takeCandidates = (list: readonly { token: IndexedSelectionToken; distance: number }[]): ValueCandidate[] => {
    const out: ValueCandidate[] = [];
    let firstDistance: number | null = null;
    for (const { token: t, distance } of list) {
      const confidence = classifyValue(t.text.trim());
      if (!confidence) continue;
      if (firstDistance !== null && distance > firstDistance * CLOSE_ENOUGH_DISTANCE_MULTIPLIER) break;
      firstDistance ??= distance;
      out.push({ text: t.text.trim(), bbox: t.bbox, tokenIndex: t.tokenIndex, confidence });
      if (out.length >= MAX_VALUE_CANDIDATES) break;
    }
    return out;
  };

  const sameRow = tokens
    .filter((t) => t.bbox.minX >= labelBbox.maxX && t.bbox.minX - labelBbox.maxX <= cutoff && verticalOverlap(t.bbox, labelBbox) > 0)
    .map((t) => ({ token: t, distance: t.bbox.minX - labelBbox.maxX }))
    .sort((a, b) => a.distance - b.distance);
  const rowCandidates = takeCandidates(sameRow);
  if (rowCandidates.length > 0) return rowCandidates;

  // [Bug measured live] `Rect` in this module (and across `@bindery/core` —
  // see `entityAssembly.ts`'s `directionalDistance`: a "below" candidate has a
  // SMALLER `Y` than the anchor) lives in PDF space, where Y INCREASES UPWARD on the
  // page, NOT downward as on a screen. "Below" (a column) therefore means a
  // SMALLER `maxY` than `labelBbox.minY`, not a larger one — the first version confused
  // this with screen convention, which gave correct results ONLY for values on the
  // same row (where the Y direction doesn't come into play at all) and a silent
  // reversed bug for column layouts (never measured on a real
  // page, because the sample pages checked so far have all their values in rows).
  const sameColumn = tokens
    .filter((t) => t.bbox.maxY <= labelBbox.minY && horizontalOverlap(t.bbox, labelBbox) > 0)
    .map((t) => ({ token: t, distance: labelBbox.minY - t.bbox.maxY }))
    .sort((a, b) => a.distance - b.distance);
  return takeCandidates(sameColumn);
}

export interface TerminateTokenCandidate {
  text: string;
  bbox: Rect;
  tokenIndex: number;
}

/**
 * [Step 28 Z3, fixed direction bug measured live] The token that
 * `terminateSectionBefore` should use, derived from GEOMETRY: the nearest
 * token OCCURRING AFTER `afterTokenIndex` in the stream (the section header), whose
 * top edge (`maxY`) lies AT or BELOW `y` — in PDF space (Y increases
 * upward on the page, see the comment at `findValueCandidatesNearLabel`'s
 * `sameColumn`) "below" means a SMALLER or equal `Y`, not a larger one.
 * The first version of this function (and its own tests, written under the same
 * wrong assumption) used the opposite direction — measured live on p.
 * 23 "Zew Cthulhu 7ed. Wrak.pdf": the section area was drawn ABOVE the clicked
 * header instead of below it. `null` if nothing lies below `y` (e.g.
 * the user dragged the boundary all the way to the bottom of the page) — the section ends
 * at the end of the stream, a valid answer, not an error.
 */
export function findTerminateTokenAtY(tokens: readonly IndexedSelectionToken[], afterTokenIndex: number, y: number): TerminateTokenCandidate | null {
  let best: IndexedSelectionToken | null = null;
  for (const t of tokens) {
    if (t.tokenIndex <= afterTokenIndex) continue;
    if (t.bbox.maxY > y) continue;
    if (!best || t.bbox.maxY > best.bbox.maxY || (t.bbox.maxY === best.bbox.maxY && t.tokenIndex < best.tokenIndex)) best = t;
  }
  if (!best) return null;
  return { text: best.text.trim(), bbox: best.bbox, tokenIndex: best.tokenIndex };
}
