import type { ProfileToken } from './types.js';

/**
 * [Step 18 Z1, renamed in Step 39] Page classifier for import routing.
 * Discovery from Z0 (unforeseen in `Bindery-MDD-v2.1.md` Phase 4): 12 of the 27
 * "grids" detected in step 12/13 are full player-character sheets (10+
 * skills, backstory, equipment, chargen allocation points),
 * not NPC/monster statblocks. The pattern engine catches these TOO, because structurally
 * they have an identical STR/APP/CON/... grid — this classifier runs BEFORE
 * further parsing, to decide WHICH pattern set the page should be
 * processed with.
 *
 * [Step 39 Z1, change of direction from step 38] Step 38 proposed a
 * per-profile switch ("this profile also covers pregen Investigators, skip the
 * filter"). Step 39 does it differently: the same signal ("player sheet vs.
 * monster sheet") ROUTES, instead of being toggled off — a page matching the keywords
 * is no longer "skipped," but instead routed to a DIFFERENT, separate set of
 * patterns (`ProfileV2.playerCharacter`, `schema.ts`). The former `isPregenPage`/
 * `countPregenKeywordHits` no longer fit their name — they always meant "page with a
 * player character sheet," only the usage was one-sided (always "skip"). No
 * backward compatibility needed — internal functions, not exported in the public API.
 *
 * [Measured on `Zew_Cthulhu_Nie_czas_na_krzyk_v1_0.pdf`, `spike/statblocks2/`,
 * 27/27 grids classified correctly against the known classification from Z0]
 * The "skills list length" candidate (pregens 14-19 occurrences of `NN%`, NPC/
 * monsters 9-27) was REJECTED — the ranges overlap, no threshold cleanly
 * separates them. The "chargen keywords anywhere on the page" candidate gives a
 * PERFECT split: all 12 pregen pages hit >=3 of 5 keywords,
 * all 15 NPC/monster targets (pages 30/31/55/56/57/84)
 * hit 0. The `>=1` threshold leaves a wide safety margin (0 vs 3-5) for
 * other books, where only one of these words might appear.
 *
 * [Step 38, confirmed on `ZewCthulhu-WRAK.pdf`, p. 23-30] The same threshold
 * also works on a second, independent book: 6/6 pregen Investigator pages
 * (25-30) hit, 0 false hits on NPC/monster pages (23-24).
 *
 * Not verified on the English `CHA23131 Call of Cthulhu 7th Edition
 * Quick-Start Rules.pdf` (different language, different keywords) — see Z7 of the
 * Step 18 brief ("measurement across the whole book") before this classifier can be considered
 * portable across languages.
 */
export const DEFAULT_PLAYER_CHARACTER_KEYWORDS: readonly string[] = ['Rozdysponuj', 'Historia Badacza', 'Przymioty', 'Ideologia', 'Znaczące miejsca'];

export const PLAYER_CHARACTER_KEYWORD_HIT_THRESHOLD = 1;

/** Page import route — which pattern set of the profile (`ProfileV2`) it should be processed with. */
export type PageRoute = 'npc' | 'playerCharacter';

export interface PageRouteOptions {
  keywords?: readonly string[];
  /** How many of the `keywords` must occur on the page for it to be classified as the `playerCharacter` route. */
  hitThreshold?: number;
}

/** How many of the configured pregen-Investigator keywords occur among this page's token texts. */
export function countPlayerCharacterKeywordHits(pageTokens: readonly ProfileToken[], opts: PageRouteOptions = {}): number {
  const keywords = opts.keywords ?? DEFAULT_PLAYER_CHARACTER_KEYWORDS;
  const joined = pageTokens.map((t) => t.text).join(' ');
  return keywords.filter((k) => joined.includes(k)).length;
}

/** Classifies the page into an import route — `'playerCharacter'` when it matches the pregen-Investigator keywords, otherwise `'npc'` (behavior from before step 39: any page without these words is an NPC/monster statblock). */
export function classifyPageRoute(pageTokens: readonly ProfileToken[], opts: PageRouteOptions = {}): PageRoute {
  const threshold = opts.hitThreshold ?? PLAYER_CHARACTER_KEYWORD_HIT_THRESHOLD;
  return countPlayerCharacterKeywordHits(pageTokens, opts) >= threshold ? 'playerCharacter' : 'npc';
}
