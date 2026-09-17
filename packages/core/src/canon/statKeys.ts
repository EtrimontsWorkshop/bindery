/**
 * [Step 23, closing an MDD gap] `Bindery-MDD-v2.2.md` §5.4 describes a
 * registry of canonical keys with hints — never actually implemented in code
 * (verified while building the profile editor: `packages/core/src/canon/`
 * didn't exist, and `canonicalKey` in `patterns.ts` was an arbitrary string
 * with no input assistance whatsoever). This file is LITERALLY the table
 * from MDD §5.4, moved into code.
 *
 * [MDD §5.4, rule] "hints are suggestions for the profile author, not
 * automatic mapping". This registry is NOT used for validation or for any
 * decision in the parsing pipeline (`patterns.ts`/`assembleStatblocks.ts`
 * do NOT import it) — it exists exclusively as a source of hints in the
 * profile editor form (`packages/module`), so the profile author has a list
 * of known keys on hand instead of inventing their own naming for the same
 * concepts in every profile separately. An unrecognized label is still fully
 * valid — `canonicalKey` in `LabelledPairsPattern.labels` is a plain
 * `z.string()` (`schema.ts`), deliberately not constrained to this registry.
 */

export interface CanonicalStatDefinition {
  /** Hints — how this stat tends to be named across different rulebooks/languages. EXCLUSIVELY for display in the UI (e.g. "also seen as: STR, Siła"), never for automatic matching. */
  hints: readonly string[];
}

export const CANONICAL_STATS = {
  strength: { hints: ['STR', 'S', 'Siła', 'Stärke', 'Force', 'Fuerza'] },
  dexterity: { hints: ['DEX', 'Ag', 'Zręczność', 'Geschick'] },
  constitution: { hints: ['CON', 'T', 'Wytrzymałość', 'Zähigkeit'] },
  intelligence: { hints: ['INT', 'Int', 'Inteligencja'] },
  willpower: { hints: ['POW', 'WP', 'SW', 'Siła Woli', 'Willenskraft'] },
  charisma: { hints: ['APP', 'Fel', 'Ogłada', 'Charisma'] },
  perception: { hints: ['Per', 'Spostrzegawczość'] },
  size: { hints: ['SIZ', 'Size', 'Rozmiar'] },
  education: { hints: ['EDU', 'Wykształcenie'] },
  luck: { hints: ['Luck', 'Szczęście', 'Fortuna'] },
  sanity: { hints: ['SAN', 'Poczytalność'] },
  hitPoints: { hints: ['HP', 'W', 'Żywotność', 'Punkty Wytrzymałości'] },
  movement: { hints: ['MOV', 'M', 'Ruch', 'Bewegung'] },
  initiative: { hints: ['Init', 'I', 'Inicjatywa'] },
  armour: { hints: ['AP', 'Armour', 'Armor', 'PZ', 'Pancerz'] },
} as const satisfies Record<string, CanonicalStatDefinition>;

export type CanonicalStatKey = keyof typeof CANONICAL_STATS;

/** List of keys in a fixed, readable order (object declaration order) — used to populate the hint list in the UI. */
export const CANONICAL_STAT_KEYS: readonly CanonicalStatKey[] = Object.keys(CANONICAL_STATS) as CanonicalStatKey[];
