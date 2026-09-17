import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { LabelledPairsPattern, SectionListPattern } from './schema.js';

/**
 * [Step 18 Z2] The pattern engine over the raw token stream — an implementation of
 * `Bindery-MDD-v2.1.md` §5.5. Two kinds of patterns implemented here:
 * `labelledPairs` (attribute grid / derived-stats block) and `sectionList` (ATTACKS).
 * `fontRoleCandidate` (entity-name candidate) and geometric pairing
 * (`entityAssembly`) are Step 18 Z3 — deliberately kept out of this file.
 *
 * `labelledPairs` generalizes `collectGrids` from the step-13 spike
 * (`spike/statblocks2/parse2.mjs`, H1) — the SAME logic (a set of labels,
 * any order, closing on a repeated label), but driven by profile
 * configuration instead of the hardcoded `CHAR_LABELS` list.
 */

/**
 * [Step 21 Z3, problem measured live] The DriveThruRPG watermark
 * (a buyer's full name followed by an order number in parentheses,
 * e.g. an "(Order #...)" suffix) — verified across ALL 6
 * `samples/` files (identical format on every checked page of
 * every file). This is a feature of the DISTRIBUTOR, not of a specific publication or
 * language — it lives in the engine (applied ALWAYS, regardless of what a
 * profile author put in their OWN `terminateSectionBefore`/`trailingWordsStopBefore`), not in each profile
 * individually, so nobody has to remember it for every new profile.
 * Applies to EVERY file bought on DriveThruRPG — most of users'
 * material (step 21, discovery #3 from RAPORT-KROK-20.md).
 */
export const VENDOR_WATERMARK_PATTERN = /\(Order #\d+\)/;

/**
 * [Step 19 Z0, refined in Z4] Upper bound for `allowTrailingWords` —
 * see the comment at its use site in `matchLabelledPairs`. Counted in
 * REAL WORDS (split on whitespace INSIDE each
 * token), NOT in tokens — measured directly as insufficient when
 * tokens were counted: pdf.js sometimes merges an entire footnote line into ONE TextItem
 * (e.g. a multi-clause footnote sentence explaining a temporary stat
 * reduction after an earlier event is
 * ONE token, 10 real words) — the "6 tokens" limit then allowed
 * swallowing ~20 words of unrelated prose in ONE OR TWO iterations.
 */
const MAX_TRAILING_WORDS = 4;

export interface LabelledPairMatchEntry {
  /** The label from the PDF (a key of `pattern.labels`). */
  label: string;
  /** The canonical key (the value of `pattern.labels[label]`). */
  canonicalKey: string;
  value: string;
  tokenIndex: number;
  /**
   * [Step 33 Z1, gap measured live, p. 24] A value ending in a
   * bare asterisk (e.g. a movement field like "7/9*") is sometimes a footnote that stands NOT right after the value
   * (which `allowTrailingWords` already handles), but on ITS OWN LINE after the
   * WHOLE BLOCK of pairs (e.g. a row combining a damage-bonus field, a
   * build field, a movement field with two alternative speeds ending in
   * the asterisk, and a magic-points field, all on one line, followed by a
   * starred footnote label on the next line). Filled in ONLY when exactly ONE pair in
   * this match has a value ending in a bare asterisk — with multiple
   * candidates there's no way to unambiguously assign which footnote
   * corresponds to which asterisk (A10, don't guess).
   */
  footnoteText?: string;
  /**
   * [Step 34 Z1, gap measured live, p. 24, "Wrak.pdf"] A value
   * sometimes ends up as ONE pdf.js token carrying BOTH a number AND further description on the
   * same line (e.g. an armor field whose value is a number, then a clause
   * describing an unusual defensive trait, then a further reminder
   * sentence — everything
   * after the colon is ONE token) — without splitting, this would land DIRECTLY in
   * the adapter's numeric field (e.g. `armor.value`), which doesn't parse such
   * a string as a number, so the field would end up empty (A13, the same mechanism as
   * the Move 8/7 bug from step 30/33: the adapter disables the system's automation ONLY
   * when the value was successfully parsed). Filled in ONLY when `value` starts
   * with a number (optionally with a bare asterisk) followed by a separator
   * (comma/semicolon/colon) OR whitespace and something further —
   * `value` is then TRIMMED down to just the number, with the rest landing here
   * (A3 — nothing disappears silently). A PURELY descriptive value with no leading number
   * (e.g. a bare "none"-style answer, or a short phrase describing a trait
   * with no number at all) is NOT split — it lands in `value`
   * in full, as before (step 34's second criterion: a description must not
   * disappear just because there's no number to extract).
   */
  descriptionText?: string;
}

export interface LabelledPairsMatch {
  pairs: LabelledPairMatchEntry[];
  /** Index of the FIRST label token in the input stream. */
  startIndex: number;
  /** Index of the FIRST token AFTER the last one consumed (exclusive). */
  endIndex: number;
  bbox: Rect;
}

/** Whether a token looks like another label from `pattern.labels` (used by `allowTrailingWords`, to avoid swallowing the next pair). */
function looksLikeLabel(text: string, labels: Readonly<Record<string, string>>): boolean {
  return Object.prototype.hasOwnProperty.call(labels, text);
}

/**
 * Collects ALL `labelledPairs` matches in the token stream. A set of
 * labels, in ANY order and count (S2, H1 from step 12/13) — it doesn't assume
 * which label comes first or how many there will be (between `minPairs` and
 * `maxPairs`).
 */
export function matchLabelledPairs(tokens: readonly ProfileToken[], pattern: LabelledPairsPattern): LabelledPairsMatch[] {
  const valueRe = new RegExp(pattern.valuePattern);
  const maxGapPt = pattern.terminate.maxGapPt;
  const matches: LabelledPairsMatch[] = [];

  let i = 0;
  while (i < tokens.length) {
    const startToken = tokens[i]!;
    if (!looksLikeLabel(startToken.text, pattern.labels) || !valueRe.test(tokens[i + 1]?.text ?? '')) {
      i++;
      continue;
    }

    const pairs: LabelledPairMatchEntry[] = [];
    const seen = new Set<string>();
    let j = i;
    let lastValueBbox: Rect | null = null;

    while (j < tokens.length) {
      const labelTok = tokens[j]!;
      const valueTok = tokens[j + 1];
      if (!valueTok || !looksLikeLabel(labelTok.text, pattern.labels) || !valueRe.test(valueTok.text)) break;
      if (pattern.terminate.onRepeatedLabel && seen.has(labelTok.text)) break;
      if (maxGapPt !== undefined && lastValueBbox && rectGapDistance(lastValueBbox, labelTok.bbox) > maxGapPt) break;
      if (pattern.maxPairs !== undefined && pairs.length >= pattern.maxPairs) break;

      let valueText = valueTok.text;
      let consumedThrough = j + 2;
      // [S1] a speed value followed by a short descriptive qualifier (e.g.
      // a movement rate followed by a word describing the mode of travel)
      // — absorb descriptive tokens AFTER the value, until
      // we hit the next label (or the end of the stream).
      if (pattern.allowTrailingWords) {
        const stopRe = pattern.trailingWordsStopBefore ? new RegExp(pattern.trailingWordsStopBefore, 'u') : null;
        let k = j + 2;
        let absorbedWords = 0;
        // [Step 19 Z0, fix for a measured bug; Z4, refined] Without an
        // upper bound: when a block's last pair no longer has ANY label
        // AFTER it on the page (e.g. the last derived-stats block before prose
        // ending the page), the "trailing word" would swallow LITERALLY the rest of the page
        // to the end of the tokens — measured directly on p. 30 (a
        // derived-stat label's value absorbed >1000 characters of further
        // prose). The limit counts REAL WORDS
        // (not tokens — pdf.js sometimes merges a whole footnote line into ONE
        // token, see the comment at `MAX_TRAILING_WORDS`), and the WHOLE candidate
        // token is rejected (not partially trimmed) if it would exceed the
        // limit — this prevents swallowing half a sentence. The MDD's use
        // case is ONE descriptive word (a speed value followed by a
        // single movement-style qualifier).
        while (k < tokens.length && !looksLikeLabel(tokens[k]!.text, pattern.labels) && !(stopRe && stopRe.test(tokens[k]!.text)) && !VENDOR_WATERMARK_PATTERN.test(tokens[k]!.text)) {
          const candidateWords = tokens[k]!.text.trim().split(/\s+/).filter(Boolean).length;
          if (absorbedWords + candidateWords > MAX_TRAILING_WORDS) break;
          valueText += ` ${tokens[k]!.text}`;
          consumedThrough = k + 1;
          absorbedWords += candidateWords;
          if (/[.!?]$/.test(tokens[k]!.text.trim())) break;
          k++;
        }
      }

      // [Step 34 Z1] Splitting a value like "5, further description" ->
      // value="5" + descriptionText="further description"
      // -- AFTER absorbing descriptive words above, so it works independently of
      // `allowTrailingWords` (it also works when the WHOLE text was ALREADY one
      // token merged by pdf.js -- exactly this kind of case).
      //
      // A number (optionally with a bare asterisk as with `footnoteText`) AT THE
      // START of the value, followed by a separator (comma/semicolon/
      // colon, with arbitrary whitespace around it), and AFTER THAT some further
      // text. Deliberately does NOT catch a bare number ("45"), a number glued WITHOUT
      // a separator to further text (e.g. a hyphenated descriptive value like
      // "2-point" describing a trait — meant to stay WHOLE as a
      // descriptive value), an N/M notation (e.g. a movement value like
      // "7/9*", `/` is not a separator
      // on the list) — nor [a regression caught by the test: a speed value
      // followed by a movement qualifier being mis-split into a bare number
      // plus an unrelated descriptive phrase] a number separated from further text by
      // A BARE SPACE with no punctuation mark at all: that is exactly the
      // shape that `allowTrailingWords` already deliberately appends as PART of
      // the descriptive value (e.g. a speed value plus a one-word movement
      // qualifier — the whole thing IS the value, not a
      // number+description to be split). Requiring a punctuation mark distinguishes
      // "a description glued to the label in the same token" (e.g. an armor
      // field, where
      // the comma is genuinely present in the source) from "a description glued on BY THE ENGINE"
      // (allowTrailingWords, where there is never a separator).
      //
      // [Step 34, workaround for a check:boundary false positive] This constant WAS
      // module-scope (`const VALUE_WITH_DESCRIPTION` at the top of the file) — esbuild
      // mapped it to the short name "ui" (exactly the same false positive, already documented
      // in `scripts/check-boundary.mjs`, as `isReferenceReportGreen`
      // from step 17: the minifier assigns short names by position/frequency within
      // its SCOPE, not by the source name's content), and `ui.test(...)` matched the
      // "restricted-word + dot" pattern. Declared LOCALLY (a different minification-name
      // budget than module scope) instead of changing the engine's logic.
      const valueWithDescriptionPattern = /^(\d+\*?)\s*[,;:]\s*(\S[\s\S]*)$/u;
      const splitMatch = valueWithDescriptionPattern.exec(valueText.trim());
      let descriptionText = splitMatch?.[2]?.trim();
      if (splitMatch) valueText = splitMatch[1]!;

      // [user report, an in-game field read as incomplete] `descriptionText`
      // above catches ONLY text from the value's OWN token — but a descriptive
      // sentence sometimes gets BROKEN onto the next physical PDF line (a separate pdf.js
      // token, different Y), measured directly on p. 24: an armor field's
      // number, trait description, and the start of a further rule-reminder
      // sentence (one token) + the remainder of that reminder sentence (the
      // NEXT token, 5 real
      // words — too long for `allowTrailingWords`/`MAX_TRAILING_WORDS` above,
      // which DELIBERATELY rejects whole tokens like this, to guard against the earlier
      // derived-stat-value-absorbing-a-huge-block-of-prose bug). The continuation HERE
      // is narrow and safe: it only kicks in when `descriptionText`
      // already exists (so the sentence was GENUINELY in progress) and does NOT
      // yet end with a period/exclamation mark/question mark, stops at the
      // FIRST such token (end of sentence), at the next label of this
      // pattern, or at the distributor watermark — with a hard upper bound
      // (`guard`) in case of a sentence with no terminating punctuation at all.
      if (descriptionText && !/[.!?]$/.test(descriptionText)) {
        let k = consumedThrough;
        let guard = 0;
        while (k < tokens.length && guard < 5 && !looksLikeLabel(tokens[k]!.text, pattern.labels) && !VENDOR_WATERMARK_PATTERN.test(tokens[k]!.text)) {
          descriptionText += ` ${tokens[k]!.text}`;
          consumedThrough = k + 1;
          guard++;
          const shouldStop = /[.!?]$/.test(tokens[k]!.text.trim());
          k++;
          if (shouldStop) break;
        }
      }

      pairs.push({ label: labelTok.text, canonicalKey: pattern.labels[labelTok.text]!, value: valueText, tokenIndex: j, ...(descriptionText ? { descriptionText } : {}) });
      seen.add(labelTok.text);
      lastValueBbox = tokens[consumedThrough - 1]?.bbox ?? valueTok.bbox;
      j = consumedThrough;
    }

    // [Step 33 Z1] A footnote standing on ITS OWN LINE right AFTER the whole block of pairs
    // (see the `footnoteText` comment on `LabelledPairMatchEntry`) — the token
    // is NO LONGER a label+value (which is exactly why the loop above
    // stopped), so it is checked SEPARATELY, AFTER building all the pairs.
    const footnoteToken = tokens[j];
    if (footnoteToken && /^\*\S/.test(footnoteToken.text.trim())) {
      const starredPairs = pairs.filter((p) => /\*$/.test(p.value.trim()));
      if (starredPairs.length === 1) {
        starredPairs[0]!.footnoteText = footnoteToken.text.trim();
        j++;
      }
    }

    if (pairs.length >= pattern.minPairs) {
      const bbox = pairs.reduce<Rect | null>((acc, p) => {
        const tokBbox = tokens[p.tokenIndex]!.bbox;
        return acc ? unionRect(acc, tokBbox) : tokBbox;
      }, null)!;
      matches.push({ pairs, startIndex: i, endIndex: j, bbox });
      i = j;
    } else {
      i++;
    }
  }

  return matches;
}

export interface SectionListItemMatch {
  /** Named groups from `itemPattern` (e.g. `name`, `toHit`) — empty if the pattern doesn't define any. */
  groups: Record<string, string>;
  raw: string;
  startTokenIndex: number;
  endTokenIndex: number;
  bbox: Rect;
  /** [Step 40] `true` when the `name` group contains (case-insensitive) any of `pattern.rangedKeywords`. */
  ranged: boolean;
}

export interface SectionListMatch {
  headerTokenIndex: number;
  items: SectionListItemMatch[];
  /** Index of the FIRST token AFTER the last one belonging to this section (the next section's header, or the end of the stream). */
  endIndex: number;
}

/**
 * Collects `sectionList` matches (e.g. the ATTACKS block). Joins the section's tokens into
 * one text buffer (tracking which token supplied each character), then
 * matches `itemPattern` against the buffer globally — resilient to a
 * single attack entry being split across many pdf.js tokens, without
 * assuming any lines/columns (S1).
 *
 * @param hardStopTokenIndices [Step 20 Z2, bug measured live] Token
 * indices of the starts of OTHER entities on the page (typically the
 * `LabelledPairsMatch.startIndex` of `entityAssembly.anchor`, see `assembleStatblocks.ts`)
 * — the section buffer NEVER goes past the nearest one. Without this: when two
 * characters stand side by side in the token stream WITHOUT a section-dividing
 * heading (`terminateSectionBefore`) between the end of one's ATTACKS and the start of the
 * other's attribute grid — which really happens (p. 55, one of the sample
 * adventures: three sample characters in a row, each with its own
 * grid+ATTACKS, with no
 * headers between them) — the buffer would run ALL THE WAY to the NEXT occurrence of `ATTACKS`
 * (i.e. the SECOND character's OWN header), swallowing that character's name,
 * attribute grid, and derived stats whole as the "damage description" of the FIRST
 * character's LAST attack entry (measured: a dodge-skill percentage value
 * would get >100 characters
 * of someone else's grid in `damage`). Optional — without it, behavior is identical to before.
 */
export function matchSectionList(tokens: readonly ProfileToken[], pattern: SectionListPattern, hardStopTokenIndices?: readonly number[]): SectionListMatch[] {
  const headerRe = new RegExp(pattern.sectionHeader);
  // [Step 18 Z2, fixed bug] The `u` flag is required: `\p{L}` (letters of
  // any language) in `itemPattern` — as in the PL profile from this step — without
  // it is NOT interpreted as a unicode property escape (JS then reads it
  // as the literal character `p` + `{L}`), so the match simply never
  // succeeds, with no error/exception signaling the cause.
  const itemRe = new RegExp(pattern.itemPattern, 'gu');
  const matches: SectionListMatch[] = [];
  const sortedHardStops = hardStopTokenIndices ? [...hardStopTokenIndices].sort((a, b) => a - b) : undefined;

  let i = 0;
  while (i < tokens.length) {
    if (!headerRe.test(tokens[i]!.text)) {
      i++;
      continue;
    }
    const headerTokenIndex = i;
    const hardStop = sortedHardStops?.find((idx) => idx > headerTokenIndex);

    let buffer = '';
    // charToToken[c] = index of the token that supplied character `buffer[c]`.
    const charToToken: number[] = [];
    let j = headerTokenIndex + 1;

    // [Step 19 Z1, fixed bug #2] Skip the table COLUMN header (e.g. a
    // percent sign and a "damage" column label as separate tokens) between the section header and the first
    // real entry. The first version assumed the column header comes
    // DIRECTLY after the section header — measured directly as false: in this
    // book there is a variable-length preamble between them (an "attacks
    // per round" label plus a number, sometimes with a parenthetical note), so the loop "keep going
    // only while the next token matches" stopped immediately at that
    // preamble label and never reached the percent-sign/damage column header. Fix: search for the
    // LAST token matching the pattern within a bounded window (it doesn't have to
    // be adjacent to the section header), then skip everything UP TO AND
    // INCLUDING it. No match in the window -> skip nothing (a page without this
    // preamble, as in isolated unit tests).
    if (pattern.skipAfterHeader) {
      const skipRe = new RegExp(pattern.skipAfterHeader, 'u');
      const SKIP_SEARCH_LIMIT = 10;
      let lastMatch = -1;
      for (let k = j; k < Math.min(tokens.length, j + SKIP_SEARCH_LIMIT) && !headerRe.test(tokens[k]!.text); k++) {
        if (skipRe.test(tokens[k]!.text)) lastMatch = k;
      }
      if (lastMatch >= 0) j = lastMatch + 1;
    }

    const stopRe = pattern.terminateSectionBefore ? new RegExp(pattern.terminateSectionBefore, 'u') : null;
    let pendingHyphen = false;
    while (
      j < tokens.length &&
      !headerRe.test(tokens[j]!.text) &&
      !(stopRe && stopRe.test(tokens[j]!.text)) &&
      !VENDOR_WATERMARK_PATTERN.test(tokens[j]!.text) &&
      (hardStop === undefined || j < hardStop)
    ) {
      const text = tokens[j]!.text;
      const isHyphenToken = pattern.rejoinHyphenated && /^[-–]$/.test(text);
      if (isHyphenToken && buffer.length > 0) {
        pendingHyphen = true;
        j++;
        continue;
      }
      const prefix = buffer.length === 0 || pendingHyphen ? '' : ' ';
      if (prefix) charToToken.push(-1); // separator - does not belong to any token
      for (let c = 0; c < text.length; c++) charToToken.push(j);
      buffer += prefix + text;
      pendingHyphen = false;
      j++;
    }
    const sectionEndIndex = j;

    const items: SectionListItemMatch[] = [];
    for (const m of buffer.matchAll(itemRe)) {
      // [Step 34, bug measured live] An empty `itemPattern` (or any other pattern
      // that can match zero characters) matches at EVERY position of the
      // buffer — hundreds of entries with no content/groups, which further down the pipeline
      // (`skillsFrom`/`attacksFrom`) turn into empty names. The schema
      // (`schema.ts`) already rejects an empty `itemPattern` when a profile loads —
      // this is an additional, engine-level safety net for a draft CURRENTLY BEING
      // edited in Profile Studio (not yet validated), so the live preview
      // never gets flooded with the same junk.
      if (m[0].length === 0) continue;
      const start = m.index!;
      const end = start + m[0].length - 1;
      const startTokenIndex = charToToken.slice(start, end + 1).find((t) => t >= 0) ?? headerTokenIndex;
      let endTokenIndex = startTokenIndex;
      for (let c = start; c <= end; c++) {
        const t = charToToken[c]!;
        if (t >= 0) endTokenIndex = t;
      }
      const bbox = Array.from({ length: endTokenIndex - startTokenIndex + 1 }, (_, k) => tokens[startTokenIndex + k]!.bbox).reduce<Rect | null>(
        (acc, b) => (acc ? unionRect(acc, b) : b),
        null,
      )!;
      const groups = { ...(m.groups ?? {}) };
      const nameForRangeCheck = (groups['name'] ?? m[0]).toLowerCase();
      const rangedKeywords = pattern.rangedKeywords ?? [];
      const ranged = rangedKeywords.length > 0 && rangedKeywords.some((kw) => nameForRangeCheck.includes(kw.toLowerCase()));
      items.push({ groups, raw: m[0], startTokenIndex, endTokenIndex, bbox, ranged });
    }

    matches.push({ headerTokenIndex, items, endIndex: sectionEndIndex });
    i = sectionEndIndex;
  }

  return matches;
}
