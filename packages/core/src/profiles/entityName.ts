import type { Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { FontRoleCandidatePattern } from './schema.js';

/**
 * [Step 18 Z3] Candidates for entity name — implementation of the
 * `fontRoleCandidate` pattern from MDD §5.5, generalizing H2 from the step-13
 * spike (`collectNameCandidates`): short text with a font role other than an excluded
 * one (typically != 'body'), with two additional filters discovered in step 12 —
 * running headers (same text on many pages) and continuations of words
 * broken across lines by hyphenation.
 *
 * [H2, step 12] The font role ALONE is NOT sufficient as a standalone decision
 * (724 candidates across 106 pages, "fatal precision") — it is an INPUT to
 * the geometric filter (`entityAssembly.ts`), not a standalone result.
 */

export interface FontRoleCandidateMatch {
  text: string;
  bbox: Rect;
  tokenIndex: number;
}

/**
 * Text+fontKey -> the set of page numbers it appears on — for
 * `excludeRepeatedAcrossPages`. Requires `token.page`; without it (a single page
 * at a time) nothing gets rejected (a safe no-op, not a false
 * rejection).
 *
 * [Step 30 Z5, bug measured live] A key based ONLY on text (without fontKey)
 * would falsely reject a genuine entity name when the same character string appears
 * ELSEWHERE in the book for an UNRELATED reason — measured directly: a monster's name
 * (p. 24 "Zew Cthulhu 7ed. Wrak.pdf") is both a statblock heading
 * (`Cambria-Bold@11`, top of page), AND a separate, genuine running footer
 * (`ACaslonPro-Italic@8.5`, bottom of page, p. 23+24) AND ordinary bold
 * occurrences in prose elsewhere in the book (`ACaslonPro-Bold@9`, p.
 * 6+14, e.g. index/cross-references) — TOGETHER 4 distinct pages, above the threshold of 3, even though
 * NO SINGLE source (the same font) repeats that many times. A genuine
 * running header/footer, BY DEFINITION, keeps a CONSISTENT style on every
 * repetition (that is what "running" means) — a key based on the PAIR
 * (text, fontKey) distinguishes these cases, preserving detection of genuine
 * running headers (same text, same font, across many pages) without
 * falsely rejecting an entity name that happens to share ITS TEXT with
 * something else using a DIFFERENT font elsewhere.
 */
function countDistinctPagesPerText(tokens: readonly ProfileToken[]): Map<string, Map<string | undefined, Set<number>>> {
  const byText = new Map<string, Map<string | undefined, Set<number>>>();
  for (const t of tokens) {
    if (t.page === undefined) continue;
    const byFontKey = byText.get(t.text) ?? new Map<string | undefined, Set<number>>();
    const pages = byFontKey.get(t.fontKey) ?? new Set<number>();
    pages.add(t.page);
    byFontKey.set(t.fontKey, pages);
    byText.set(t.text, byFontKey);
  }
  return byText;
}

const RUNNING_HEADER_MIN_DISTINCT_PAGES = 3;

export function matchFontRoleCandidate(tokens: readonly ProfileToken[], pattern: FontRoleCandidatePattern): FontRoleCandidateMatch[] {
  const excludeRoles = new Set(pattern.excludeRoles);
  const pageCountByText = pattern.excludeRepeatedAcrossPages ? countDistinctPagesPerText(tokens) : null;
  // [Step 29 Z3] An empty `requireFontKeys` (the default, for backward compatibility) = no
  // additional filter, behavior identical to before Step 29.
  const requiredFontKeys = pattern.requireFontKeys.length > 0 ? new Set(pattern.requireFontKeys) : null;

  const out: FontRoleCandidateMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.text || tok.text.length === 0 || tok.text.length > pattern.maxLength) continue;
    // [Step 18 Z7, fix for a bug reported via measurement] `fontRole ===
    // 'unknown'` (a role that WAS actually computed, but without enough
    // occurrences in `buildInventory` to classify it confidently) is NOT the
    // same as "a role other than body" — it's an absence of signal, not a positive signal.
    // Measured directly: a rare font variant ("ACaslonPro-Regular@9.5" —
    // occurring only in short explanatory sentences appended after certain
    // body-part headings) was getting `unknown`, not `body`, so
    // the profile's default `excludeRoles: ['body']` (MDD §5.5) let it through.
    // Treat `unknown` identically to having no role at all.
    if (!tok.fontRole || tok.fontRole === 'unknown' || excludeRoles.has(tok.fontRole)) continue;
    if (requiredFontKeys && (!tok.fontKey || !requiredFontKeys.has(tok.fontKey))) continue;
    // [Step 18 Z7, fix for a bug reported via measurement] Measured on a real
    // book: an explanatory sentence directly after a body-part heading (a
    // short note clarifying that a paired body part is a separate creature
    // with the same stats, p. 56) fit within `maxLength` AND had a font role
    // != 'body' (small caps/italic lead-in to the description), so it passed as a "confident"
    // name instead of a placeholder — exactly the case S4 was supposed to
    // guard against. No genuine name in the measured sample ends with a
    // period/exclamation mark/question mark — prose sentences almost always do.
    if (/[.!?]$/.test(tok.text.trim())) continue;

    if (pattern.excludeHyphenContinuations) {
      const isHyphenItself = /^[-–]$/.test(tok.text);
      if (isHyphenItself) continue;
      const prevWasHyphen = i > 0 && /^[-–]$/.test(tokens[i - 1]!.text);
      if (prevWasHyphen) continue;
    }

    if (pageCountByText) {
      const pages = pageCountByText.get(tok.text)?.get(tok.fontKey);
      if (pages && pages.size >= RUNNING_HEADER_MIN_DISTINCT_PAGES) continue;
    }

    // [Step 20 Z2, bug measured live] A name is sometimes one token together with a
    // trailing comma, when it's immediately followed in the sentence by a role description
    // (e.g. "<name>, <occupation>" -> token "<name>,") — pdf.js merges them,
    // because they share the same font/size as the rest of the phrase. The comma is never
    // part of the name in any measured case; it is trimmed from the END of the
    // candidate text, not from the whole token (rejecting the whole token would lose
    // the genuine name).
    const text = tok.text.replace(/,+$/, '');
    if (!text) continue;

    out.push({ text, bbox: tok.bbox, tokenIndex: i });
  }
  return out;
}
