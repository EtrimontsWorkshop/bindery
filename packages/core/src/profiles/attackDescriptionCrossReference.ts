import type { SectionListMatch } from './patterns.js';
import type { ProfileToken } from './types.js';

/**
 * [Step 33 Z4, user report: "Attack names should be checked below, and if one is
 * found, that text should go into the notes."]
 * Attack descriptions in CoC rulebooks are sometimes expanded OUTSIDE the actual
 * entry in the ATTACKS list — in prose BELOW the statblock, introduced by its OWN
 * accent-style subheading (`fontRole: 'accent'`, the same style as the
 * "Attacks:"/"MOV:" labels), e.g. an attack name followed by a parenthetical
 * qualifier and a colon, then a paragraph describing what the attack does
 * (p. 24 "Wrak.pdf", on a specific creature's statblock). This content
 * currently ends up nowhere — exactly what the user is looking for when the
 * field on the sheet turns out too terse (A3).
 *
 * [case of differing parenthetical suffixes, measured live] The name in the ATTACKS
 * list and the subheading below it do NOT have to carry an identical parenthetical
 * suffix — an attack name with no suffix in the list can have below it a subheading
 * for the SAME attack carrying its OWN, DIFFERENT parenthetical suffix (e.g. a
 * qualifier describing the attack's delivery method). Matching is
 * done by the name WITHOUT its OWN suffix (if it has one) as a PREFIX
 * of the subheading, not by full string equality.
 */

/** e.g. an attack name like "Name (maneuver)" -> "Name" — strips the attack name's OWN trailing parenthetical suffix, if it has one. */
function stripTrailingParenthetical(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Whether `headingText` starts with `name` as a WHOLE word (not a fragment) — allows the match to end exactly at `name`, followed by a space or a parenthesis. */
function startsWithWholeName(headingText: string, name: string): boolean {
  if (headingText === name) return true;
  if (!headingText.startsWith(name)) return false;
  const nextChar = headingText[name.length];
  return nextChar === ' ' || nextChar === '(';
}

/**
 * [Bug measured live, a real Actor export from Foundry — a description
 * containing a word hyphenated across a line break (e.g. a generic invented
 * example like "crea-" / "ture" split into two tokens) ending up
 * unrejoined in the notes] Joins token texts with a space as usual, BUT a standalone token
 * "-"/"–" (a line break in the PDF in the middle of a word — the same token that
 * `matchSectionList`'s `rejoinHyphenated` recognizes, see `patterns.ts`)
 * is REMOVED, and the space AROUND it is skipped, instead of being appended as a
 * separate, dangling word. Unlike `matchSectionList`, there is no
 * dedicated profile flag here — this function produces FREE-FORM notes text, not
 * subject to further regex matching (no need to map character->token
 * as in `matchSectionList`), so there is no scenario in which a profile author
 * would want to KEEP a split word in the description.
 *
 * [reported live, another word hyphenated across a line break, e.g. a generic
 * invented example like "inter-" / "ested"] The shape above (a standalone
 * "-" token) is ONE of the ways pdf.js represents a line break in the
 * middle of a word — measured on the SAME book ("Wrak.pdf"), a different location
 * (p. 30, description of an ally/contact): the hyphen is sometimes GLUED to the end of the
 * previous token (e.g. "...inter-"), and the continuation of the word is the NEXT token WITHOUT its own
 * leading space (e.g. "ested..."). Recognized by the letter DIRECTLY
 * before the trailing hyphen (`\p{L}[-–]$`) — this distinguishes it from a hyphen after a digit/
 * punctuation (e.g. the range "20-30" never ends in a letter), where
 * merging without a space would be incorrect.
 */
export function joinRejoiningLineBreakHyphens(texts: readonly string[]): string {
  let result = '';
  let pendingHyphen = false;
  for (const text of texts) {
    if (/^[-–]$/.test(text)) {
      if (result.length > 0) pendingHyphen = true;
      continue;
    }
    const glued = /^(.*\p{L})[-–]$/u.exec(text);
    if (glued) {
      const prefix = result.length === 0 || pendingHyphen ? '' : ' ';
      result += prefix + glued[1];
      pendingHyphen = true;
      continue;
    }
    const prefix = result.length === 0 || pendingHyphen ? '' : ' ';
    result += prefix + text;
    pendingHyphen = false;
  }
  return result;
}

/**
 * For each item in `attacks.items`, searches the tokens AFTER the last
 * matched item (up to `attacks.endIndex` — the same section boundary that
 * already respects `terminateSectionBefore`/other entities' boundaries, see
 * `matchSectionList`) for a subheading (`fontRole: 'accent'`) starting with
 * the FULL name of that attack. When found, returns the text of the tokens
 * FOLLOWING it (up to the next subheading or the end of the range) as the
 * "expanded description" — one paragraph per attack (A10: match the whole name, not
 * a fragment — "Dodge" won't catch an incidental occurrence in the middle of another
 * word). Returns `null` for items where nothing was found — finding
 * nothing is a valid result (A7), not an error.
 */
export interface AttackDescriptionScan {
  /** Parallel to `attacks.items` — see `findAttackDescriptionsBelow`. */
  texts: (string | null)[];
  /**
   * [Step 34 Z2] Token ranges ACTUALLY consumed as the description of SOME
   * attack (subheading + its content, `[start, end)`) — for use by
   * `proseBlock` (notes located geometrically), so it does NOT propose
   * THE SAME content again as a separate note (step-34 brief, "Relationship
   * to Z4 from step 33": "just check whether the two mechanisms duplicate the
   * same content... and if so — filter it out"). Subheadings that did NOT
   * match any attack name (e.g. a subheading naming some non-attack special
   * ability, on p. 24 "Wrak.pdf" — that's NOT an attack) are DELIBERATELY skipped here — their content stays
   * available to `proseBlock`, which exists PRECISELY to capture it.
   */
  claimedRanges: { start: number; end: number }[];
}

/**
 * A shared scan used BY BOTH `findAttackDescriptionsBelow` (content) AND
 * `proseBlock` from step 34 (ranges to exclude from dedup) — a single source of
 * truth, so the two never diverge on what counts as "already described."
 *
 * [Step 34 Z2, bug measured live, "Wrak.pdf" p. 24] `attacks.endIndex`
 * is the boundary of the ITEM BUFFER (`terminateSectionBefore`/`matchSectionList`),
 * NOT the boundary up to which it's allowed to search for descriptions BELOW the
 * list — on a real profile `terminateSectionBefore` is sometimes set EXACTLY ON
 * the subheading of the first description (e.g. an attack name followed by a
 * parenthetical qualifier and a colon, so the
 * item list does NOT mistake it for an erroneous 5th item), which happens to cut
 * `endIndex` EXACTLY where this scan was supposed to start searching —
 * `searchStart >= searchEnd` and the ENTIRE Z4 function stays silent, even though the
 * descriptions really are there. `hardStopTokenIndices` (the same entity boundary that
 * `matchSectionList` itself receives) gives the TRUE upper bound, independent of
 * where `terminateSectionBefore` happens to cut through the item buffer.
 */
function scanAttackDescriptions(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): AttackDescriptionScan {
  const texts: (string | null)[] = attacks.items.map(() => null);
  const claimedRanges: { start: number; end: number }[] = [];
  if (attacks.items.length === 0) return { texts, claimedRanges };

  const searchStart = Math.max(...attacks.items.map((item) => item.endTokenIndex)) + 1;
  // `hardStopTokenIndices` NOT PASSED AT ALL (not: an empty []) -> EXACTLY the old
  // behavior (`searchEnd = attacks.endIndex`), so that call sites predating this
  // field (and their tests) see no change at all.
  const nextHardStop = hardStopTokenIndices ? (hardStopTokenIndices.filter((h) => h > attacks.headerTokenIndex).sort((a, b) => a - b)[0] ?? tokens.length) : undefined;
  const searchEnd = nextHardStop !== undefined ? Math.max(attacks.endIndex, nextHardStop) : attacks.endIndex;
  if (searchStart >= searchEnd) return { texts, claimedRanges };

  // Longest names first — so a longer name doesn't accidentally get
  // "swallowed" by a match on a shorter name that is its prefix.
  const candidates = attacks.items
    .map((item, itemIndex) => ({ itemIndex, name: stripTrailingParenthetical(item.groups['name'] ?? '') }))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  const claimedItemIndices = new Set<number>();
  let i = searchStart;
  while (i < searchEnd) {
    const tok = tokens[i]!;
    if (tok.fontRole === 'accent') {
      const headingText = tok.text.replace(/:\s*$/, '').trim();
      const match = candidates.find((c) => !claimedItemIndices.has(c.itemIndex) && startsWithWholeName(headingText, c.name));
      let j = i + 1;
      if (match) {
        const parts: string[] = [];
        while (j < searchEnd && tokens[j]!.fontRole !== 'accent') {
          parts.push(tokens[j]!.text);
          j++;
        }
        if (parts.length > 0) {
          texts[match.itemIndex] = joinRejoiningLineBreakHyphens(parts);
          claimedItemIndices.add(match.itemIndex);
          claimedRanges.push({ start: i, end: j });
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return { texts, claimedRanges };
}

export function findAttackDescriptionsBelow(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): (string | null)[] {
  return scanAttackDescriptions(tokens, attacks, hardStopTokenIndices).texts;
}

/** [Step 34 Z2] See `AttackDescriptionScan.claimedRanges`. */
export function findAttackDescriptionClaimedRanges(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): { start: number; end: number }[] {
  return scanAttackDescriptions(tokens, attacks, hardStopTokenIndices).claimedRanges;
}
