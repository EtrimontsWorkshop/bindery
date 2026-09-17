import type { Rect } from '../geometry.js';
import { findColumnBand, isWithinColumnBand } from './columnBand.js';

/**
 * [Step 29 Z1] `itemPattern` (`sectionList`) is the only field in Profile
 * Studio that requires manually writing a regular expression (O1, the step-28
 * acceptance-test report: it came up three times in one session).
 * Instead of generating an ARBITRARY regex from examples (unpredictable, unreadable
 * for a human), we recognize a LIMITED FAMILY of shapes seen in
 * CoC7 statblocks (step-29 brief, table): name+percent[+rest after
 * the comma] (attacks, one entry per "line" of the section buffer) and
 * name+percent (skills, a comma-separated sequence on one "line").
 * The author clicks examples, and the pattern selects and fine-tunes the SHAPE — it doesn't build
 * the expression from scratch.
 *
 * The two families have a DIFFERENT matching shape, because `matchSectionList` (patterns.ts)
 * joins the WHOLE section into one flat text buffer (spaces instead of genuine
 * line breaks) and matches `itemPattern` globally against the whole buffer:
 * - Skills: each entry SELF-terminates with its own "NN%" (the next one starts
 *   right after the comma) — `matchAll` without a lookahead is enough.
 * - Attacks: AFTER the percent (and an optional ratio in parentheses) there can be an arbitrarily
 *   long damage description (a dice-notation value) — without a boundary the regex would also swallow
 *   the next entry. It requires a lookahead of "the next entry starts here, or the
 *   end of the buffer" — EXACTLY the same mechanism as the existing, MANUALLY
 *   written `itemPattern` in `spike/statblocks2/coc7-niczas-pl.json` (attacks).
 *
 * [measured directly on p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] One
 * attack entry is sometimes described WITHOUT a percentage at all — a weapon name
 * followed directly by a dice value, with no percentage
 * (the same combat skill as a percentage-based melee entry, only the weapon/damage differs). Hence a second,
 * "percentless" branch of the ATTACK family, appended to the first VIA
 * an alternation (`(?:...|...)`), THE SAME WAY the manually written
 * `itemPattern` in `profiles/coc7-quickstart-en.json` already does (two alternatives of one
 * named group `name`/`damage` in mutually exclusive branches —
 * confirmed that the regex engine (Node/V8, the same family as the browser)
 * handles this).
 *
 * The name does NOT require an uppercase first letter — measured directly: a weapon
 * name (not a proper name) can start with a lowercase letter. `\p{L}` (any
 * letter of any language), NEVER `[A-Za-z]` (step-29 brief: the PL profile
 * stumbled exactly on this with certain skill names that only exist in non-Latin-only form).
 */

export type ItemShapeCode = 'shapePercentRest' | 'shapeValueOnly' | 'shapeMixed' | 'shapePercentList';

export interface ItemPatternInference {
  itemPattern: string;
  /** Shape code to display in the UI (localization happens ONLY in `packages/module`, like every other message in this project). */
  shape: ItemShapeCode;
}

/**
 * [Bug measured live, another Actor export from Foundry, p. 24
 * "Wrak.pdf"] A period had until now been allowed in the name's character class — with
 * no justification in the data (no real example in this project has a
 * period INSIDE an entry name), yet with a SERIOUS cost: the Attacks section has a
 * LONG narrative paragraph between the header and the first genuine entry
 * (a sentence describing a special attack option, ending in a period, right
 * before the first genuine percentage-based entry) —
 * a global/leftmost-first match tries the starting position at
 * the beginning of that paragraph FIRST, and since a period was allowed, `(?<name>...)` could
 * absorb the ENTIRE paragraph up to the real name, producing an entry name equal to
 * the whole narrative sentence plus the real name glued together. Removing the period
 * from the class means such an attempt can no longer match the whole thing at all (there's
 * a period along the way that the class no longer includes) — the regex engine itself shifts
 * the starting position further, until it hits the genuine start of the name,
 * without needing `skipAfterHeader` in the profile (the mechanism is still
 * available as an extra safeguard, but stops being the ONLY defense against this
 * class of bug).
 */
/**
 * [reported live, "Wrak.pdf" Investigators]
 * Digits/period were COMPLETELY excluded (see the comment above) — correct
 * for bare prose, but wrong for a weapon with a caliber given in PARENTHESES
 * (e.g. a firearm's caliber): the lookahead searching for the NEXT entry didn't recognize
 * such a name as a valid start, so the `.*?` BEFORE it swallowed the whole
 * firearm entry together with the previous one as one, instead of stopping at
 * its boundary — measured directly, a real Actor export from Foundry
 * ("Wrak.pdf" p. 27/30): the firearm disappeared entirely from the
 * weapon list.
 *
 * The fix does NOT widen the class globally (that would just recreate the earlier
 * bug) — digits/period are allowed ONLY inside their OWN, fully
 * closed parentheses `(...)` (`\([^()]*\)`), which can occur any
 * number of times in the name. The earlier narrative sentence has NO
 * parentheses around its final period, so it still doesn't match this class —
 * verified directly, the test "a long narrative paragraph... does NOT contaminate
 * its name" still passes with this pattern.
 */
const NAME_CLASS = '\\p{L}[\\p{L} /-]*?(?:\\([^()]*\\)[\\p{L} /-]*?)*';
const PERCENT_ITEM_RE = /\d{1,3}%/g;

/**
 * [Bug measured live, a real Actor export from Foundry]
 * The "value" shape (`valueItem`, and the lookahead detecting its start) was
 * `\d[\p{L}\d+]*` -- A DIGIT, then ANY mix of letters/digits/plus, INCLUDING
 * ZERO characters. This allowed a BARE NUMBER ALONE as
 * a "damage value", even though CoC7's dice notation (and every other
 * system measured in this project) ALWAYS has a letter indicating the die type (e.g.
 * "1D3", "5D6", "1d8"). One monster's page (p. 24 "Wrak.pdf"), after the genuine
 * attack entries, has a LONG special-ability description full of ordinary numbers in
 * prose (measurements of length and range given in plain sentences) -- each
 * of these, preceded by any word, looked like a valid "percentless
 * entry" (`shapeMixed`, the `valueItem` branch), producing phantom
 * weapons in the real export with nonsensical damage values. Fix: require
 * AT LEAST ONE letter in the value -- genuine dice notation always has
 * one, a bare descriptive number in prose never does. A genuine weapon-plus-dice entry
 * (p. 23, the case this shape was originally created for) still matches (a die-type letter is present).
 */
const DICE_VALUE = '\\d[\\d]*\\p{L}[\\p{L}\\d+]*';

function countPercentOccurrences(text: string): number {
  return (text.match(PERCENT_ITEM_RE) ?? []).length;
}

/**
 * Skills: each entry is self-sufficient ("Name NN%"), no lookahead
 * needed -- the next entry starts immediately after the comma, so `matchAll`
 * globally over the whole buffer suffices (measured: 17/17 entries on p. 23).
 */
function buildSkillsPattern(): ItemPatternInference {
  return { itemPattern: `(?<name>${NAME_CLASS}) (?<value>\\d{1,3})%`, shape: 'shapePercentList' };
}

/**
 * [Step 19 legacy, extended in Step 30 Z3] An extra safety
 * net -- a subheading in the style "Capitalized Word:" also ends an entry,
 * regardless of `terminateSectionBefore`/hardStop (which usually already
 * catch this EARLIER, at the whole-section level anyway).
 *
 * [bug measured live, p. 24 "Zew Cthulhu 7ed. Wrak.pdf"]
 * The original character class `[\p{L} ]*` (ONLY letters and spaces) did not
 * recognize genuine special-ability subheadings that end with a parenthetical
 * qualifier before the colon (e.g. "Special attack (maneuver):") -- the parentheses in
 * the suffix don't fit this class, so this whole lookahead branch
 * never activated for such headers. The class was then widened to
 * `()./-` (parentheses, period, slash, hyphen) -- at that point identical
 * to `NAME_CLASS`. [Since the period fix in `NAME_CLASS`, see its comment,
 * NO LONGER identical -- this is an entry HEADER/BOUNDARY, not the entry name
 * itself, so the risk of "being dragged through a sentence" doesn't apply to it in the
 * same way; the period stays here deliberately.]
 */
const NEXT_HEADER_LIKE = `\\s*\\p{Lu}[\\p{L} ()./-]*:`;

/**
 * [Step 29 Z1, original version] A "name + percent + optional ratio in
 * parentheses + optional damage clause" entry -- percent + an optional ratio in parentheses + an optional
 * rest to the end of the entry.
 *
 * [Step 30 Z2, bug measured live] `damage` was originally `(?<damage>.*?)`
 * -- a RAW, arbitrary text fragment up to the entry boundary (the lookahead), so it
 * carried along the comma, the WORD LABEL ITSELF (e.g. "damage" -- that's a LABEL, not a
 * VALUE) and a dangling conjunction (e.g. "or", with no alternative after it, since that's already
 * its OWN, SEPARATE percentless entry). Result: `CIFAttack.damage` ended up with the
 * label and conjunction still attached instead of the clean dice value. Fix: optionally
 * skip ONE label word (any language -- not a hardcoded "damage"
 * dictionary), then capture ONLY the actual dice
 * value (`\d[\p{L}\d+]*` -- the same shape as `valueItem`).
 *
 * [problem measured live WITH THIS fix] A bare value ALONE as the
 * END of the match breaks the lookahead: when there is still dangling text
 * after the value (e.g. a trailing conjunction, or a conjunction followed by
 * another percentless entry when the author hasn't
 * yet given a percentless example), NO position in this text
 * looks like "NAME+percent" (nor, in the mixed shape, like the excluded
 * "NAME+value") -- matching the WHOLE entry fails, instead of simply
 * ending earlier. Appending an UNNAMED, lazy `.*?` AFTER the bare
 * value still absorbs that dangling text (as the old version did), but
 * NOW outside the `damage` group -- the bare value stays clean, while matching
 * the whole entry can still reach the next genuine entry.
 *
 * [Step 33 Z3, bug measured live, p. 24 "Wrak.pdf"] The first
 * version looked for an intro word RIGHT AFTER the percent/ratio, separated
 * ONLY by a comma — a special-attack entry whose damage clause came after a
 * colon-separated multi-sentence description
 * lost `damage` entirely, because the separator was a COLON, and the intro word
 * itself stands at the END of a long description, not right after it. Fix:
 * when intro words are already known (`introWords`, extracted from
 * the author's OWN percent examples — see `extractDamageIntroWords`,
 * NEVER a language dictionary), search for them ANYWHERE in the rest of the entry
 * (a lazy `.*?` BEFORE, not limited to right-after-the-separator), regardless
 * of whether the separator is a comma or a colon — both simply fall
 * within the same arbitrary `.*?`. `WORD_START_GUARD` (not `\b`) for the same
 * reasons as in `valueItem`: JS's `\b` doesn't count non-ASCII letters as a
 * "word character", so it would fail on words starting with a Polish
 * letter. No `introWords` (the author hasn't yet clicked any percent
 * example with a damage description) -> behavior from before this fix (one
 * optional word right after the separator), to avoid regressing simpler
 * shapes that already worked.
 */
function percentItem(introWords: readonly string[]): string {
  const restClause =
    introWords.length > 0
      ? `(?:.*?${WORD_START_GUARD}(?:${introWords.join('|')})\\s+(?<damage>${DICE_VALUE}))?.*?`
      : `(?:,?\\s*\\p{L}[\\p{L}]*)?\\s*(?<damage>${DICE_VALUE})?.*?`;
  return `(?<name>${NAME_CLASS}) \\*?(?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?${restClause}`;
}

/**
 * [measured p. 23, a percentless weapon-plus-dice entry] An entry WITHOUT a percentage -- name + value
 * (any mix of digits/letters, e.g. dice notation). `nameExclusion` (see
 * `extractDamageIntroWords`) prevents this shape from confusing a PREVIOUS
 * percent entry's OWN damage description -- this is the
 * SAME "word + dice-value" shape as a genuine percentless entry -- with
 * the start of a NEW entry -- the regex shape ALONE cannot tell
 * these apart, both cases are geometrically identical in the flattened buffer
 * (`matchSectionList` joins the whole section with a single space, losing the
 * line breaks). The only reliable signal is the word INTRODUCING the damage
 * description (e.g. the "damage" label, in whatever language the book uses), read directly from the author's OWN
 * percent example -- not a hardcoded language dictionary (MDD: independence
 * from language/system).
 */
/**
 * [problem measured live with the first version of this file] Plain
 * `(?!obrażenia\b)` is NOT enough -- it rejects ONLY a match
 * starting EXACTLY at the start of the excluded word, but the regex engine
 * ALSO tries a position one character further along ("brażenia" instead of "obrażenia"),
 * where the assertion no longer sees the whole excluded word and lets
 * a match through in the middle of it. Require a genuine word boundary FIRST
 * (the previous character is NOT a letter) -- then the exclusion actually works,
 * instead of being bypassed by a one-character shift.
 */
const WORD_START_GUARD = '(?<!\\p{L})';

function valueItem(nameExclusion: string): string {
  return `(?<name>${WORD_START_GUARD}${nameExclusion}${NAME_CLASS}) (?<damage>${DICE_VALUE})`;
}

function lookahead(includeValueBranch: boolean, nameExclusion: string): string {
  const branches = [`\\s*${NAME_CLASS} \\*?\\d{1,3}%`];
  if (includeValueBranch) branches.push(`\\s*${WORD_START_GUARD}${nameExclusion}${NAME_CLASS} ${DICE_VALUE}`);
  branches.push(NEXT_HEADER_LIKE, '$');
  return `(?=${branches.join('|')})`;
}

/**
 * A "name + percent + ratio + damage clause with a trailing conjunction"
 * entry yields EVERY word from the percent example's "rest" (everything AFTER
 * the percent/optional ratio), not just the one right after the comma.
 * [problem measured live, second iteration of this function] The first version
 * caught ONLY the word RIGHT AFTER the comma (the damage-clause intro word) -- a trailing
 * conjunction further in the
 * same rest (after the dice value) passed through unhindered and glued the
 * conjunction and the following percentless entry together into one (wrong) name. A damage description is sometimes longer than
 * one intro word -- exclude EVERYTHING that stands there.
 */
function extractDamageIntroWords(percentExamples: readonly string[]): readonly string[] {
  const words = new Set<string>();
  const tailRe = /\d{1,3}%(?:\s*\(\d+\/\d+\))?(.*)$/su;
  for (const example of percentExamples) {
    const tail = tailRe.exec(example)?.[1] ?? '';
    for (const m of tail.matchAll(/\p{L}{2,}/gu)) words.add(m[0]);
  }
  return [...words];
}

function buildAttacksPattern(percentExamples: readonly string[], valueOnlyExamples: readonly string[]): ItemPatternInference | null {
  const hasPercentExample = percentExamples.length > 0;
  const hasValueOnlyExample = valueOnlyExamples.length > 0;
  // [Step 33 Z3] Computed ALWAYS when there are any percent examples —
  // not just in the mixed shape as before. `percentItem` NOW ALSO uses this
  // to search for damage (see its comment), not just `valueItem`
  // for excluding names.
  const introWords = hasPercentExample ? extractDamageIntroWords(percentExamples) : [];
  if (hasPercentExample && hasValueOnlyExample) {
    const exclusion = introWords.length > 0 ? `(?!(?:${introWords.join('|')})\\b)` : '';
    return { itemPattern: `(?:${percentItem(introWords)}|${valueItem(exclusion)})${lookahead(true, exclusion)}`, shape: 'shapeMixed' };
  }
  if (hasPercentExample) return { itemPattern: `${percentItem(introWords)}${lookahead(false, '')}`, shape: 'shapePercentRest' };
  if (hasValueOnlyExample) return { itemPattern: `${valueItem('')}${lookahead(true, '')}`, shape: 'shapeValueOnly' };
  return null;
}

/**
 * Infers `itemPattern` from 1+ example entry texts clicked by the
 * profile author (each example is one "entry", e.g. one attack line
 * or one skill occurrence in a list). `kind` corresponds to the tab
 * the author is clicking on (Attacks/Skills) -- it determines the group names
 * the downstream pipeline expects (`buildCIFActor.ts`:
 * `name`+`toHit`+`damage` for attacks, `name`+`value` for skills).
 *
 * `null` = no example matches any known shape (e.g. the author
 * clicked an entry with no number at all) -- the UI should then ask for another example,
 * NEVER guess an arbitrary expression.
 */
export function inferItemPatternFromExamples(kind: 'attacks' | 'skills', exampleTexts: readonly string[]): ItemPatternInference | null {
  const examples = exampleTexts.map((t) => t.trim()).filter(Boolean);
  if (examples.length === 0) return null;

  if (kind === 'skills') {
    const hasPercent = examples.some((t) => countPercentOccurrences(t) >= 1);
    return hasPercent ? buildSkillsPattern() : null;
  }

  const percentExamples = examples.filter((t) => countPercentOccurrences(t) >= 1);
  const valueOnlyExamples = examples.filter((t) => countPercentOccurrences(t) === 0 && /\d/.test(t));
  return buildAttacksPattern(percentExamples, valueOnlyExamples);
}

export interface RowTextToken {
  text: string;
  bbox: Rect;
}

/**
 * [UI, clicking an example] Collects the text of the WHOLE visual line the
 * clicked token belongs to -- "the same line" = overlapping Y ranges
 * (the same test as `mergeTouchingTokens`), sorted by X, joined with a
 * single space. IN PRACTICE pdf.js has often already merged the whole line into ONE
 * token (measured directly on p. 23 "Wrak.pdf" -- every attack line is ONE
 * `TextItem`), so this function usually just returns the text of the clicked
 * token -- but it doesn't assume this, so it also works where pdf.js did NOT
 * merge the line.
 *
 * [Step 30, bug measured live] "The same line" computed ONLY by Y
 * (without knowledge of columns), on a two-column page, ALSO caught prose from the
 * NEIGHBORING column lying at the same height as the clicked line — measured
 * directly: clicking on a skill entry (left column, p. 23) pulled into that
 * same example random words of a monster's description from the right column, which then landed in `itemPattern`'s exclusions
 * (`extractDamageIntroWords`) as phantom "label words". The same
 * mechanism as the section-boundary fix (`findColumnBand`/`isWithinColumnBand`,
 * `columnBand.ts`) — on a single-column page the band covers the whole content, zero
 * change in behavior.
 */
export function collectRowText(tokens: readonly RowTextToken[], clickedIndex: number): string {
  const clicked = tokens[clickedIndex];
  if (!clicked) return '';
  const sameLine = (a: Rect, b: Rect): boolean => Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 0;
  const band = findColumnBand(tokens, clicked.bbox);
  return tokens
    .filter((t) => sameLine(t.bbox, clicked.bbox) && isWithinColumnBand(t.bbox, band))
    .slice()
    .sort((a, b) => a.bbox.minX - b.bbox.minX)
    .map((t) => t.text)
    .join(' ');
}
