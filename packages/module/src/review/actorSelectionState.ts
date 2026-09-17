import type { CIFActor, CIFDocument } from '@bindery/core';

/**
 * [Step 20 Z2] Selection/edit model for the Actors tab — mirrors
 * `ReviewSelection` (images, Step 11 Z4): PURE presentation over an
 * already-built `CIFActor[]`, zero decision logic about WHAT is correct
 * (A1) — only "what is selected" and "what overrides the user made before
 * saving".
 *
 * Default selection: `nameConfident === true` -> SELECTED (the name is
 * already confident, ready to import without intervention); a placeholder
 * -> VISIBLE, UNSELECTED, until the user resolves the name (S4/A10 — the
 * same pattern as low-confidence images).
 */

/**
 * [Step 20 Z2] Keys used for the completeness indicator — EXACTLY the same
 * canonical keys that `coc7Adapter.fromActor` actually reads
 * (`CHARACTERISTIC_KEY_MAP` + `attribs` fields). There isn't yet a general,
 * system-neutral registry of canonical keys (MDD §5.4/§7 promises one in the
 * repo structure, but nobody has built it) — this screen, just like the
 * adapter itself, knows them directly for now. This is a SUMMARY of
 * already-computed data (how many of the expected fields are actually
 * present), not a NEW classification decision.
 */
const COMPLETENESS_STAT_KEYS: readonly string[] = [
  'strength',
  'constitution',
  'size',
  'dexterity',
  'charisma',
  'intelligence',
  'education',
  'willpower',
  'sanity',
  'hitPoints',
  'movement',
  'magicPoints',
  'damageBonus',
  'build',
];

export interface ActorCompleteness {
  hasAttacks: boolean;
  presentStatCount: number;
  expectedStatCount: number;
  missingStatCount: number;
}

/** A field counts as "present" when it either parsed numerically or has any raw text at all (e.g. `db: "+1D4"` — a string, never `numeric`, but STILL a real value, not a gap). */
function isStatPresent(stat: { raw: string; numeric?: number } | undefined): boolean {
  if (!stat) return false;
  return stat.numeric !== undefined || stat.raw.trim().length > 0;
}

export function computeActorCompleteness(actor: CIFActor): ActorCompleteness {
  let present = 0;
  for (const key of COMPLETENESS_STAT_KEYS) {
    if (isStatPresent(actor.statistics[key])) present++;
  }
  return {
    hasAttacks: actor.attacks.length > 0,
    presentStatCount: present,
    expectedStatCount: COMPLETENESS_STAT_KEYS.length,
    missingStatCount: COMPLETENESS_STAT_KEYS.length - present,
  };
}

export class ActorReviewSelection {
  #selected = new Map<string, boolean>();
  /** Name AFTER user resolution — an empty string = not yet resolved (a placeholder with no choice made). */
  #resolvedName = new Map<string, string>();
  /** `actorId -> (canonicalKey -> overridden raw value)`. */
  #statOverrides = new Map<string, Map<string, string>>();
  /** `actorId -> set of attack INDICES removed by the user (we don't mutate `CIFActor.attacks` directly — `undo` is done by clicking again). */
  #removedAttacks = new Map<string, Set<number>>();
  /** [Step 35 Z1] `actorId -> CIFImage.id` of the selected token — an empty string (default, no entry) = "none". ONLY images with the `token` destination (Images tab) go into the candidate list — see `#buildActorImagePicker` in `ReviewScreen.ts`. */
  #tokenImageId = new Map<string, string>();
  /** [Step 35 Z2] `actorId -> CIFImage.id` of the portrait OVERRIDE under "Advanced settings" — no entry (distinct from an empty string) = the portrait follows the token (P1 product decision: "One pick sets both"). An explicitly stored empty string = the author DELIBERATELY chose "none" for the portrait despite a token being set. */
  #portraitImageIdOverride = new Map<string, string>();

  static fromDocument(document: CIFDocument): ActorReviewSelection {
    const selection = new ActorReviewSelection();
    for (const actor of document.actors ?? []) {
      selection.#selected.set(actor.id, actor.nameConfident);
      selection.#resolvedName.set(actor.id, actor.nameConfident ? actor.name : '');
    }
    return selection;
  }

  isSelected(id: string): boolean {
    return this.#selected.get(id) ?? false;
  }
  setSelected(id: string, selected: boolean): void {
    if (this.#selected.has(id)) this.#selected.set(id, selected);
  }

  /** Effective name: the user's override (even empty, if explicitly cleared) or the confident name from the CIF. */
  resolvedName(actor: CIFActor): string {
    const override = this.#resolvedName.get(actor.id);
    if (override !== undefined) return override;
    return actor.nameConfident ? actor.name : '';
  }
  setResolvedName(actorId: string, name: string): void {
    this.#resolvedName.set(actorId, name.trim());
  }
  isNameResolved(actor: CIFActor): boolean {
    return this.resolvedName(actor).length > 0;
  }

  statOverride(actorId: string, canonicalKey: string): string | undefined {
    return this.#statOverrides.get(actorId)?.get(canonicalKey);
  }
  setStatOverride(actorId: string, canonicalKey: string, value: string): void {
    const map = this.#statOverrides.get(actorId) ?? new Map<string, string>();
    map.set(canonicalKey, value);
    this.#statOverrides.set(actorId, map);
  }
  /** The raw value TO USE (overridden or the original from the CIF) — the only place the rest of the screen/import should read from. */
  effectiveStatRaw(actor: CIFActor, canonicalKey: string): string {
    return this.statOverride(actor.id, canonicalKey) ?? actor.statistics[canonicalKey]?.raw ?? '';
  }

  isAttackRemoved(actorId: string, attackIndex: number): boolean {
    return this.#removedAttacks.get(actorId)?.has(attackIndex) ?? false;
  }
  toggleAttackRemoved(actorId: string, attackIndex: number): void {
    const set = this.#removedAttacks.get(actorId) ?? new Set<number>();
    if (set.has(attackIndex)) set.delete(attackIndex);
    else set.add(attackIndex);
    this.#removedAttacks.set(actorId, set);
  }
  /** Attacks AFTER the user's removals — the only list `#runImport` should pass to the adapter. */
  effectiveAttacks(actor: CIFActor): CIFActor['attacks'] {
    return actor.attacks.filter((_, i) => !this.isAttackRemoved(actor.id, i));
  }

  /** [Step 35 Z1] Id of the image chosen as the token — an empty string = "none" (not yet chosen, or explicitly cleared). */
  tokenImageId(actorId: string): string {
    return this.#tokenImageId.get(actorId) ?? '';
  }
  /** [user report, auto-suggest token] Distinguishes "the author hasn't chosen anything yet" from "the author explicitly chose none" (the same pattern as `hasCustomPortrait`) — without this, the auto-suggestion in `ReviewScreen.ts` would overwrite the deliberate "none" choice back to a guessed suggestion on EVERY render. */
  hasTokenImageSelection(actorId: string): boolean {
    return this.#tokenImageId.has(actorId);
  }
  setTokenImageId(actorId: string, imageId: string): void {
    this.#tokenImageId.set(actorId, imageId);
  }
  /** [Step 35 Z2] Effective portrait: the "Advanced" override if the author explicitly set it, otherwise EXACTLY the same image as the token (P1: "One pick sets both"). */
  portraitImageId(actorId: string): string {
    return this.#portraitImageIdOverride.get(actorId) ?? this.tokenImageId(actorId);
  }
  /** Whether the portrait has its OWN assignment, independent of the token ("Advanced" expanded and used) — controls the visibility of the override control in the UI. */
  hasCustomPortrait(actorId: string): boolean {
    return this.#portraitImageIdOverride.has(actorId);
  }
  setPortraitImageId(actorId: string, imageId: string): void {
    this.#portraitImageIdOverride.set(actorId, imageId);
  }
  /** Undo the override — the portrait follows the token again. */
  clearCustomPortrait(actorId: string): void {
    this.#portraitImageIdOverride.delete(actorId);
  }

  get selectedCount(): number {
    let n = 0;
    for (const v of this.#selected.values()) if (v) n++;
    return n;
  }
  selectAll(): void {
    for (const id of this.#selected.keys()) this.#selected.set(id, true);
  }
  selectNone(): void {
    for (const id of this.#selected.keys()) this.#selected.set(id, false);
  }
}

function parseNumericLike(raw: string): number | undefined {
  const trimmed = raw.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * [Step 20 Z2] `CIFActor` AFTER the user's overrides (name/values/removed
 * attacks) — the only version that should reach `coc7Adapter.fromActor`,
 * whether for the notes PREVIEW on this screen or for the ACTUAL import
 * (`#runImport`). A pure function — zero mutation of the original
 * `CIFActor` (a new object), so that "Undo" (clicking a removed attack
 * again) and `provenance` navigation (which reads the original
 * `actor.provenance`) keep working on untouched source data.
 */
export function applyActorOverrides(actor: CIFActor, selection: ActorReviewSelection): CIFActor {
  const name = selection.resolvedName(actor) || actor.name;
  const statistics: CIFActor['statistics'] = {};
  for (const [key, stat] of Object.entries(actor.statistics)) {
    const override = selection.statOverride(actor.id, key);
    statistics[key] = override === undefined ? stat : { ...stat, raw: override, numeric: parseNumericLike(override) };
  }
  return { ...actor, name, statistics, attacks: [...selection.effectiveAttacks(actor)] };
}
