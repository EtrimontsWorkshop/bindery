import type { AdapterIssue, AdapterResult, CIFActor, ImportContext, LocalizableMessage, SystemAdapter } from '@bindery/core';

/**
 * [Step 19 Z1] CoC7 adapter — MDD §5.6, phase 6. Field schema read from the
 * H4 spike, step 13 (`spike/statblocks2/h4-create-actors.js`), VERIFIED
 * WORKING — 3 real Actor+Item created in an actual Foundry instance. Canonical
 * `CIFActor.statistics` keys verified in Step 19 Z0 (`P` = the abbreviated
 * key derived from the source book's own Polish label for Sanity, not
 * hitPoints — see `RAPORT-KROK-19.md`).
 *
 * **Pure function** (§5.6 point 4 of the contract) — zero Foundry API calls, zero
 * document creation. Returns DATA; `documents/createActors.ts` (Z3) consumes
 * it and actually creates the `Actor`/`Item`.
 *
 * [Trap found in the H4 spike, confirmed] `skill.system.value` is a GETTER in
 * the CoC7 system — you must write to `system.adjustments.base`, never `value`
 * directly.
 */

const CHARACTERISTIC_KEY_MAP: Readonly<Record<string, string>> = {
  strength: 'str',
  charisma: 'app',
  constitution: 'con',
  willpower: 'pow',
  size: 'siz',
  education: 'edu',
  dexterity: 'dex',
  intelligence: 'int',
};

/**
 * [Step 19 Z1, bug fixed] "HP" is sometimes written as "N*(M)" — but this was
 * measured on two DIFFERENT real statblocks, with TWO different meanings:
 * one character ("HP 5*(7)", footnote "* Reduced HP due to an earlier
 * attack") — 5 is the current (reduced) value, 7 is the original. One
 * creature, p. 31 ("HP 24*(12)", footnote about HALF HP during an incomplete
 * transformation) — 24 is the normal value, 12 is a CONDITIONAL alternative
 * (half), NOT the "maximum" of a larger number 24. This cannot be
 * distinguished structurally (both have the identical shape "N*(M)") — it
 * requires reading the specific footnote. Instead of guessing which
 * interpretation applies, take the FIRST number as the best approximation and
 * flag `needsReview` (A10).
 */
type HitPointsParseReason = 'ok' | 'empty' | 'asterisk' | 'unparseable';

function parseHitPoints(raw: string | undefined): { value: number | null; max: number | null; reason: HitPointsParseReason } {
  if (!raw) return { value: null, max: null, reason: 'empty' };
  const trimmed = raw.trim();
  const withAsterisk = /^(\d+)\*\(\d+\)$/.exec(trimmed);
  if (withAsterisk) return { value: Number(withAsterisk[1]), max: null, reason: 'asterisk' };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, max: n, reason: 'ok' };
  // [Step 19 Z4, bug fixed] The previous version flagged the SAME
  // `needsReview` for "N*(M)" (genuinely ambiguous, requires reading the
  // footnote) and for a plain "–" (simply no value for this creature) —
  // the note in `fromActor` always said "contains an annotation (*)", which
  // for "–" is simply UNTRUE. Distinguished here so the note describes what
  // actually happened (A3/A10 — not just "nothing lost", but also
  // "the explanation is true").
  return { value: null, max: null, reason: trimmed.length > 0 ? 'unparseable' : 'empty' };
}

/**
 * [Step 19 Z4, bug fixed] The previous version returned `null` with no note
 * at all when the value wasn't a number (e.g. Movement "12/12 flying" — a
 * flying creature, descriptive value) — a silent data loss, A3. Now it also
 * returns the reason, so the caller can add a note.
 *
 * Additionally: a bare trailing "*" (e.g. "14 *" — a footnote reference,
 * WITHOUT a parenthesized annotation like HP's "N*(M)") is unambiguous —
 * nothing follows it (the footnote has already been cut off by
 * `terminateSectionBefore` in the pattern engine), so the number BEFORE the
 * asterisk is safe to use, with a "check the footnote" note instead of
 * discarding the value entirely.
 */
function parseNumberOrNull(raw: string | undefined): { value: number | null; failed: boolean; hasFootnoteMarker: boolean } {
  if (raw === undefined) return { value: null, failed: false, hasFootnoteMarker: false };
  const trimmed = raw.trim();
  const withFootnoteMarker = /^(\d+)\s*\*$/.exec(trimmed);
  if (withFootnoteMarker) return { value: Number(withFootnoteMarker[1]), failed: false, hasFootnoteMarker: true };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, failed: false, hasFootnoteMarker: false };
  return { value: null, failed: trimmed.length > 0, hasFootnoteMarker: false };
}

/**
 * [Step 33 Z1, gap measured live, on a specific creature's statblock, p. 24 "Wrak.pdf"] Movement is
 * sometimes written as "N/M*" (base value / conditional variant, e.g.
 * swimming/flying), with a footnote on its OWN line below ("*Swimming") —
 * a standard CoC convention for condition-dependent values, not an edge
 * case. Previously: `parseNumberOrNull` didn't recognize `/`, so the whole
 * value went to `failed`, `mov.auto` stayed `true`, and the CoC7 system
 * recalculated its own (wrong) number from the characteristics instead of
 * using the source value. The first value (before `/`) is the CANONICAL
 * Movement value in the source — the variant and footnote are not lost (A3),
 * they go into the `MOVEMENT_RATIO_VARIANT` note (see the call site), never
 * into the numeric field itself.
 */
type MovementParseReason = 'ok' | 'empty' | 'ratio' | 'unparseable';

function parseMovement(raw: string | undefined): { value: number | null; reason: MovementParseReason; alternate?: string } {
  if (raw === undefined) return { value: null, reason: 'empty' };
  const trimmed = raw.trim();
  const ratio = /^(\d+)\s*\/\s*(\d+)\*?$/.exec(trimmed);
  if (ratio) return { value: Number(ratio[1]), reason: 'ratio', alternate: ratio[2] };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, reason: 'ok' };
  return { value: null, reason: trimmed.length > 0 ? 'unparseable' : 'empty' };
}

/**
 * [Step 26 Z3, measured on a real pregenerated investigator sheet] Unlike purely
 * numeric fields, DB (Damage Bonus) legitimately uses dice notation ("1D4",
 * "2D6"), so it couldn't go through `parseNumberOrNull` — but that meant the
 * raw text from `cif.statistics['damageBonus'].raw` reached Foundry with NO
 * validation at all. pdf.js merging the label with the value into a single
 * token (the same mechanism as S1 in `patterns.ts`) produced e.g. ": +1D4"
 * instead of "1D4" — the sheet would literally show that garbage instead of
 * the correct modifier. This cleans the leading separator/plus and the
 * Polish K->d dice notation (the same as `polishDiceToFoundry` for weapons,
 * which was never applied here), then rejects anything that still doesn't
 * look like a number/dice roll — degrading to a note + `auto: true`, just
 * like other fields (A7), instead of silently propagating garbage (A3).
 */
function parseDamageBonus(raw: string | undefined): { value: string | null; failed: boolean } {
  if (raw === undefined) return { value: null, failed: false };
  const cleaned = polishDiceToFoundry(raw.trim().replace(/^[:;,]+\s*/, '').replace(/^\+/, ''));
  if (/^-?\d+(?:d\d+)?$/i.test(cleaned)) return { value: cleaned, failed: false };
  return { value: null, failed: cleaned.length > 0 };
}

export function escapeHtmlBasic(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * [Step 19 Z5, gap reported live] Polish rulebooks write dice as "1K3" ("K"
 * = kostka/die) — Foundry's roll engine (`new Roll(formula)`) understands
 * ONLY "NdM" notation. Without this, the stored string reaches
 * `system.range.normal.damage` literally and is unrecognizable as a formula.
 * This translates ONLY the notation (K->d), never the content — the original
 * text from the book is kept separately in the biography's `rawText`
 * regardless (A3).
 */
function polishDiceToFoundry(damage: string): string {
  return damage.replace(/(\d)[kK](\d)/g, '$1d$2');
}

/** One Item to embed after creating the Actor (Z3) — skill always, weapon only when the attack looks armed (name != "Unik"/dodge; the actual decision stays in createActors.ts, not here — this is STILL just data). */
export interface Coc7EmbeddedItemSpec {
  kind: 'skill' | 'weapon';
  name: string;
  /** Only for `kind: 'skill'`. */
  basePercent?: number;
  /** Only for `kind: 'weapon'` — the name of the skill this weapon is linked to (`system.skill.main.name`, `id` filled in during Z3 AFTER the skill Item is created). */
  linkedSkillName?: string;
  damage?: string;
  /**
   * [Step 20 Z2, gap measured live] Only for `kind: 'weapon'` — the raw
   * matched text from the book (`CIFAttack.rawText`, e.g. a generic
   * "Attack Name 40%(20/8) 1D4+1"-shaped line), goes into the created Item's `system.description.value`.
   * Without this, the weapon sheet has an EMPTY Description tab after
   * import — the only place with the source text of that attack (name,
   * percentage, damage in the original notation with footnotes) simply
   * wasn't going anywhere, even though `rawText` had already been computed
   * in the CIF (A3 — nothing is lost silently — it broke at the last step,
   * not in the parsing engine).
   */
  description?: string;
  /**
   * [Step 33 Z4] Only for `kind: 'weapon'` — the description found in prose
   * BELOW the ATTACKS section (`CIFAttack.belowText`), already HTML-escaped,
   * WITHOUT a "where this came from" label — the label is game-world-language
   * text, so it's appended only in `createActors.ts` (which has access to
   * `game.i18n`), not here (`fromActor` must remain a pure function, see the
   * file header). `undefined` when nothing was found.
   */
  belowText?: string;
  /** [Step 40] Only for `kind: 'weapon'` — `true` when `CIFAttack.properties` carries `'ranged'` (the profile recognized the name as a ranged weapon, see `SectionListPattern.rangedKeywords`). Controls the created Item's `system.properties.rngd` (by default CoC7 treats every weapon as melee). */
  ranged?: boolean;
}

export interface Coc7ActorPayload {
  actorData: object;
  items: readonly Coc7EmbeddedItemSpec[];
  /**
   * [Step 34 Z2] Prose blocks attached geometrically (`CIFActor.notes`) —
   * raw text + source-language label (e.g. "Description"), WITHOUT
   * HTML/i18n (`fromActor` must remain a pure function, see the file
   * header) — composition with attack notes (Step 33 Z4) and the final HTML
   * happens in `createActors.ts` (which has Foundry access). `[]` when the
   * CIF had nothing (A10).
   */
  entityNotes: readonly { label: string; text: string }[];
}

export const coc7Adapter: SystemAdapter = {
  id: 'coc7-native',
  systemId: 'CoC7',
  systemVersion: '>=8.0.0',
  accepts: ['coc7'],
  produces: ['actors', 'items'],
  label: 'Call of Cthulhu 7th Edition (native)',

  fromActor(cif: CIFActor, ctx: ImportContext): AdapterResult<Coc7ActorPayload> {
    // [Step 27 Z1] `notes`/`issues` carry ONLY `{code, params}` (see
    // `LocalizableMessage`), never a ready-made sentence — this adapter lives
    // in `packages/module` and could formally call `game.i18n` directly, but
    // `fromActor` must remain a PURE FUNCTION (§5.6 point 4 of the contract,
    // see the file header) testable without Foundry
    // (`tools/verify-coc7-adapter.ts`) — localization only happens in
    // `ReviewScreen.ts` (`#renderActorNotesInto`, `localizeMessage('coc7',
    // ...)`).
    const notes: LocalizableMessage[] = [];
    const issues: AdapterIssue[] = [];

    const characteristics: Record<string, { value: number | null }> = {};
    for (const [cifKey, coc7Key] of Object.entries(CHARACTERISTIC_KEY_MAP)) {
      const stat = cif.statistics[cifKey];
      characteristics[coc7Key] = { value: stat?.numeric ?? null };
      if (stat && stat.numeric === undefined) {
        notes.push({ code: 'CHARACTERISTIC_NOT_NUMERIC', params: { label: stat.sourceLabel, raw: stat.raw } });
      }
    }

    const hp = parseHitPoints(cif.statistics['hitPoints']?.raw);
    if (!cif.statistics['hitPoints']) notes.push({ code: 'HIT_POINTS_MISSING' });
    if (hp.reason === 'asterisk') {
      notes.push({ code: 'HIT_POINTS_ASTERISK', params: { raw: cif.statistics['hitPoints']?.raw ?? '' } });
    } else if (hp.reason === 'unparseable') {
      notes.push({ code: 'HIT_POINTS_UNPARSEABLE', params: { raw: cif.statistics['hitPoints']?.raw ?? '' } });
    }
    const magicPoints = parseNumberOrNull(cif.statistics['magicPoints']?.raw);
    if (magicPoints.failed) notes.push({ code: 'MAGIC_POINTS_UNPARSEABLE', params: { raw: cif.statistics['magicPoints']?.raw ?? '' } });
    if (magicPoints.hasFootnoteMarker) {
      notes.push({ code: 'MAGIC_POINTS_FOOTNOTE', params: { raw: cif.statistics['magicPoints']?.raw ?? '' } });
    }
    const sanity = cif.statistics['sanity'];
    if (sanity && sanity.numeric === undefined && sanity.raw !== '–') {
      notes.push({ code: 'SANITY_UNPARSEABLE', params: { raw: sanity.raw } });
    }
    const movement = parseMovement(cif.statistics['movement']?.raw);
    if (movement.reason === 'unparseable') {
      notes.push({ code: 'MOVEMENT_UNPARSEABLE', params: { raw: cif.statistics['movement']?.raw ?? '' } });
    } else if (movement.reason === 'ratio') {
      const footnote = cif.statistics['movement']?.footnoteText;
      notes.push({
        code: 'MOVEMENT_RATIO_VARIANT',
        params: {
          raw: cif.statistics['movement']?.raw ?? '',
          base: String(movement.value),
          alternate: movement.alternate ?? '',
          footnoteNote: footnote ? ` (${footnote})` : '',
        },
      });
    }
    const build = parseNumberOrNull(cif.statistics['build']?.raw);
    if (build.failed) notes.push({ code: 'BUILD_UNPARSEABLE', params: { raw: cif.statistics['build']?.raw ?? '' } });
    const damageBonus = parseDamageBonus(cif.statistics['damageBonus']?.raw);
    if (damageBonus.failed) {
      notes.push({ code: 'DAMAGE_BONUS_UNPARSEABLE', params: { raw: cif.statistics['damageBonus']?.raw ?? '' } });
    }
    // [Step 34 Z1, gap measured live, on a specific creature's statblock, p. 24 "Wrak.pdf"] Before this
    // step `armor` was ALWAYS `{value: null}` — the profile never even had a
    // CHANCE to feed this field, regardless of whether the author had
    // clicked the "Armor" label in the Studio. Same degradation as the other
    // numeric fields (`build`/`magicPoints`): a purely descriptive value
    // ("none", "2-point thick hide" — no leading number, the profile engine
    // does NOT split it, see `patterns.ts` `VALUE_WITH_DESCRIPTION`) goes
    // entirely into the note (`ARMOR_UNPARSEABLE`), it is NOT silently lost
    // (A3), and `armor.value` stays `null`/`auto:true` — the system will
    // compute something reasonable instead of showing zero.
    const armor = parseNumberOrNull(cif.statistics['armour']?.raw);
    if (armor.failed) notes.push({ code: 'ARMOR_UNPARSEABLE', params: { raw: cif.statistics['armour']?.raw ?? '' } });
    const armorDescription = cif.statistics['armour']?.descriptionText;
    if (armorDescription) notes.push({ code: 'ARMOR_DESCRIPTION', params: { raw: armorDescription } });

    // [Step 39 Z4] The canonical `luck` key has existed in `canon/statKeys.ts`
    // (hints: "Luck"/"Szczęście"/"Fortuna") since MDD version 1.1 — before
    // this step it simply NEVER had anywhere to come from: no NPC profile had
    // a label corresponding to Luck (CoC7 monster/NPC statblocks don't carry
    // it), so `cif.statistics['luck']` was ALWAYS `undefined`, making this
    // note UNCONDITIONAL. Pre-generated Investigators (the `playerCharacter`
    // route, `pageRoute.ts`) DO HAVE Luck — the `Wrak.json` profile maps
    // the book's own Luck label to this key (Step 39 Z5) — so the note now reflects
    // whether THIS PARTICULAR profile recognized it, instead of always
    // claiming it didn't.
    const luck = parseNumberOrNull(cif.statistics['luck']?.raw);
    if (!cif.statistics['luck']) notes.push({ code: 'LUCK_NOT_RECOGNIZED' });
    else if (luck.failed) notes.push({ code: 'LUCK_UNPARSEABLE', params: { raw: cif.statistics['luck']?.raw ?? '' } });

    // [Step 25, bug measured live] The installed CoC7 system
    // (`models/actor/global-system.js`, `prepareBaseData`/`prepareDerivedData`)
    // RECALCULATES hp/mp/mov/db/build/san FROM THE CHARACTERISTICS on EVERY
    // data-preparation cycle, as long as `attribs.<field>.auto` stays at its
    // default `true` (`initial: true` in the schema) — exactly the same
    // mechanism as `flags.locked` (Step 19). Effect measured directly: a
    // specific creature's statblock gave a Movement value in the rulebook that
    // the CoC7 formula would NOT reproduce from its characteristics (a case
    // where STR is equal to, not GREATER than, SIZ, with DEX > SIZ) — the
    // imported actor showed the WRONG, formula-derived value instead of the
    // book's own value, because `mov.auto` stayed on and the system
    // overwrote our value on the first render. Fix: `auto: false` ONLY when
    // we actually have a parsed source value (null = missing in the source,
    // in which case we let the system compute something reasonable instead
    // of a locked `null` — A7, degrade without erroring).
    const attribs = {
      hp: { value: hp.value, max: hp.max, auto: hp.value === null },
      mp: { value: magicPoints.value, max: magicPoints.value, auto: magicPoints.value === null },
      // [Step 39 Z4] NO `auto` — unlike hp/mp/mov/db/build/san (Step 25,
      // comment near `attribs` above), Luck is NOT recalculated FROM
      // CHARACTERISTICS in CoC7 (rolled once at character creation, not via a
      // formula), so the same overwrite mechanism doesn't apply here — not
      // verified directly against the source (no access to a live Foundry
      // instance in this session), so the field stays in the SHAPE it had
      // before this step (`{value}`, no extra fields), rather than guessing
      // a schema key that may not exist.
      lck: { value: luck.value },
      san: { value: sanity?.numeric ?? null, auto: sanity?.numeric === undefined },
      mov: { value: movement.value, auto: movement.value === null },
      db: { value: damageBonus.value, auto: damageBonus.value === null },
      build: { value: build.value, auto: build.value === null },
      armor: { value: armor.value, auto: armor.value === null },
    };

    if (cif.attacks.length === 0) notes.push({ code: 'NO_ATTACKS_SECTION' });
    const items: Coc7EmbeddedItemSpec[] = [];
    // [Step 25, gap reported live] A combat maneuver (e.g. "Overwhelm
    // (fighting maneuver)") has NO hit percentage of its OWN in the source —
    // under CoC7 rules it always uses the attack skill it's listed AFTER in
    // the book (Fighting -> Overwhelm), never its own, separate skill.
    // Without this, every such variant got its own "0%" skill (wrong) — now
    // an attack WITHOUT a recognized `toHit` links to the NEAREST preceding
    // attack that DID have its own percentage, instead of creating a new
    // skill.
    let lastSkillName: string | null = null;
    for (const attack of cif.attacks) {
      const toHitValue = parseNumberOrNull(attack.toHit).value;
      let linkedSkillName: string;
      if (toHitValue !== null) {
        items.push({ kind: 'skill', name: attack.name, basePercent: toHitValue });
        linkedSkillName = attack.name;
        lastSkillName = attack.name;
      } else if (lastSkillName) {
        linkedSkillName = lastSkillName;
        notes.push({ code: 'ATTACK_LINKED_TO_PREVIOUS_SKILL', params: { attackName: attack.name, linkedSkillName: lastSkillName } });
      } else {
        // No earlier attack at all to link to (e.g. this attack is the
        // FIRST in the list) — shouldn't happen in real books (maneuvers
        // always follow their base skill), but degrade instead of failing
        // silently (A7): its own 0% skill, an explicit note for manual
        // correction.
        items.push({ kind: 'skill', name: attack.name, basePercent: 0 });
        linkedSkillName = attack.name;
        lastSkillName = attack.name;
        notes.push({ code: 'ATTACK_NO_TOHIT_NO_PREVIOUS', params: { attackName: attack.name } });
      }
      // [Step 19 Z5] `itemPattern` (see packages/core) has captured damage
      // since Z5 — if it's still missing (a weapon with no recognized
      // formula in the source, e.g. described in prose), it's explicitly
      // flagged in `notes` (A3/A10), never guessed from the attack name.
      // `polishDiceToFoundry` translates ONLY the dice notation ("1K3" ->
      // "1d3"), so that `system.range.normal.damage` is a valid formula for
      // Foundry's roll engine.
      const damage = attack.damage ? polishDiceToFoundry(attack.damage) : '';
      // [Step 33 Z4] `belowText` — the description found in prose BELOW the
      // ATTACKS section (see `attackDescriptionCrossReference.ts`) — already
      // HTML-escaped here (`fromActor` MUST remain a pure function, see the
      // file header), but DELIBERATELY without a "where this came from"
      // label/marker — this is DISPLAY TEXT (Foundry world language), not
      // diagnostics (`notes` go through `LocalizableMessage`+`game.i18n` in
      // `ReviewScreen.ts`), so the label is only added in `createActors.ts`,
      // which DOES have access to `game.i18n`, not here.
      const belowText = attack.belowText ? escapeHtmlBasic(attack.belowText) : undefined;
      const ranged = attack.properties.includes('ranged');
      items.push({ kind: 'weapon', name: attack.name, linkedSkillName, damage, description: `<p>${escapeHtmlBasic(attack.rawText)}</p>`, belowText, ranged });
      if (!attack.damage) notes.push({ code: 'WEAPON_DAMAGE_UNRECOGNIZED', params: { attackName: attack.name } });
      // [Step 40 Z3, live report "clicking to add ammo does nothing"] CoC7
      // counts magazine capacity (`system.bullets`) separately from the
      // number of ROUNDS IN the magazine (`system.ammo`) — the "reload"
      // button on the Actor sheet does `Math.min(ammo+1, bullets)`, so with
      // the default `bullets: null` (parsed as 0) it ALWAYS comes out to
      // `min(1,0)=0`, i.e. a write identical to the current value — a
      // silent no-op, no error. This profile (and the general "ATTACKS"
      // schema in this book) never gives magazine capacity at the weapon
      // ENTRY in a character statblock (unlike fields like damage/toHit) —
      // so there's nowhere to get it from without guessing (R2: a profile
      // carries parsing instructions, not invented content). Instead of
      // fabricating a number, this warns the GM that the field needs manual
      // completion before the button will work.
      if (ranged) notes.push({ code: 'WEAPON_AMMO_CAPACITY_UNKNOWN', params: { attackName: attack.name } });
    }

    // [Step 20 Z2b, gap reported live] `cif.skills` — the statblock's list
    // of GENERAL skills ("Skills: History 75%, Occult 60%..."), separate
    // from the attacks. Without this, that whole list simply never reached
    // the sheet — it wasn't even parsed (see `buildCIFActor.ts`).
    // Skip a name already taken by a skill linked to an attack (rare, but
    // possible when names overlap between ATTACKS and Skills) — don't
    // create two Items with the same name, which would confuse the GM.
    const existingSkillNames = new Set(items.filter((it) => it.kind === 'skill').map((it) => it.name));
    for (const skill of cif.skills) {
      if (existingSkillNames.has(skill.name)) continue;
      const basePercent = parseNumberOrNull(skill.value).value ?? 0;
      items.push({ kind: 'skill', name: skill.name, basePercent });
      existingSkillNames.add(skill.name);
    }

    if (cif.name.startsWith('NPC ze str.')) {
      // [Step 19 Z4, gap measured live] Without a candidate list, the user
      // gets only "something is uncertain on p. 55" and has to comb through
      // the whole PDF page themselves to figure out which character this is
      // — a problem measured live ("I can't verify which NPC this refers to
      // from this page"). Candidates come from geometric pairing
      // (entityAssembly), not guesswork — this is STILL "when uncertain,
      // don't guess, flag it" (A10), just with a genuinely useful hint.
      issues.push({ severity: 'warning', code: 'UNCERTAIN_NAME', params: { name: cif.name } });
      if (cif.nameCandidates && cif.nameCandidates.length > 0) {
        issues.push({ severity: 'warning', code: 'UNCERTAIN_NAME_CANDIDATES', params: { candidates: cif.nameCandidates.join(' | ') } });
      }
    }

    // [Step 35 Z1/Z2] Actor token/portrait — ONLY the user's explicit choice
    // in the review screen's Actors tab, passed as an image id
    // (`CIFImage.id`), never guessed geometrically (`images.associateWithEntity`
    // from the profile, MDD §5.5, deliberately NOT USED here — a product
    // decision from step 35: zero automatic matching). `imagePathResolver`
    // resolves the id to the path it's ACTUALLY already been uploaded to
    // (images are uploaded BEFORE actors are created, in `#runImport`) —
    // when the author picked an image that for some reason was NOT uploaded
    // (deselected in the Images tab, upload error), the resolver returns
    // `null` and the actor is created WITHOUT a token/portrait plus an
    // explicit warning, NEVER with a path to a nonexistent file (A3/A7 —
    // the same degradation pattern as the rest of this adapter's fields).
    const tokenImageRef = ctx.tokenImageRef ?? null;
    const portraitImageRef = ctx.portraitImageRef ?? null;
    const tokenImagePath = tokenImageRef ? ctx.imagePathResolver(tokenImageRef) : null;
    const portraitImagePath = portraitImageRef ? ctx.imagePathResolver(portraitImageRef) : null;
    if (tokenImageRef && !tokenImagePath) issues.push({ severity: 'warning', code: 'ACTOR_TOKEN_IMAGE_NOT_UPLOADED', params: { imageRef: tokenImageRef } });
    if (portraitImageRef && !portraitImagePath) issues.push({ severity: 'warning', code: 'ACTOR_PORTRAIT_IMAGE_NOT_UPLOADED', params: { imageRef: portraitImageRef } });

    // [Step 39 Z4] `CIFActor.route` (`pageRoute.ts`, optional — see its
    // comment in `cif/types.ts`) decides the Foundry actor type. `undefined`
    // (fixtures/calls from before step 39, constructing `CIFActor` directly
    // without this field) is treated as `'npc'` — EXACTLY the behavior from
    // before this step, zero change for existing profiles/tests.
    const isPlayerCharacter = cif.route === 'playerCharacter';

    // [Live report after Step 39, "the occupation field picked up the age
    // label too"] `cif.typeLabel`
    // assumes the occupation/type is its OWN, independently styled heading
    // (`typeLabelPattern`, fontRoleCandidate) — in Wrak.pdf, the book's own
    // Occupation label is usually a label+value field (like other label+value
    // fields, e.g. HP:/Build:), and its VALUE has `body` styling, structurally
    // excluded by `excludeRoles`, so this mechanism could never catch it.
    // Falls back to `cif.statistics['occupation']`/`['age']` — populated
    // when the profile author adds the book's own Occupation/Age labels as a
    // plain label to any `labelledPairs` (e.g. the derived-stats pattern),
    // with no need for its own `fontRoleCandidate`. `cif.typeLabel` takes
    // precedence (books where the occupation REALLY is its own heading) —
    // both paths describe the SAME system field.
    const occupation = cif.typeLabel ?? cif.statistics['occupation']?.raw;
    const age = cif.statistics['age']?.raw;

    // [Step 39 Z4, Step 38 P5] `actorLink`/`disposition` are deliberately
    // NEVER set here — `character-system.js`'s `_preCreateChanges`
    // unconditionally overwrites BOTH via `mergeObject` (`actorLink: true`,
    // `disposition: 1`) REGARDLESS of what this adapter would produce.
    // Trying to set anything else would be dead code — pretending to have
    // control it doesn't actually have.
    const actorData = {
      name: cif.name,
      type: isPlayerCharacter ? 'character' : 'npc',
      folder: ctx.folderId,
      // [Step 35 Z2, A13 verified directly against the CoC7 source
      // (`document-class.js` `_preCreate`, `hooks/create-token.js`)] The
      // `img` key is omitted ENTIRELY (not `img: undefined`/`null`) when the
      // author chose "none" — the system's `_preCreate` substitutes its OWN
      // default NPC image (`npc-system.js` `defaultImg`, "cultist.svg") ONLY
      // when `data.img` is `undefined` (or literally Foundry's mystery-man)
      // — an explicitly set, different path is NEVER overwritten.
      // `prototypeToken` similarly: a token dropped onto a scene gets
      // `actor.img` ONLY when its `texture.src` is STILL the mystery-man
      // (`create-token.js`) — an explicitly set, different path right in
      // `prototypeToken.texture.src` never hits this condition, so it
      // survives being dropped onto a scene unchanged (Z3 point 5).
      ...(portraitImagePath ? { img: portraitImagePath } : {}),
      ...(tokenImagePath ? { prototypeToken: { texture: { src: tokenImagePath } } } : {}),
      system: {
        characteristics,
        attribs,
        // [Step 20 Z2, problem measured live] The previous version put the
        // whole `cif.rawText` here — the ENTIRE matched statblock text
        // (characteristics+derived+attacks+skills). Effect measured live:
        // notes duplicated EVERYTHING already visible elsewhere on the sheet
        // (characteristics grid, weapon items, skills), with no added value
        // for the GM — pure noise, not an A3 "safety net". `rawText` still
        // exists in the CIF and is visible in the review screen BEFORE
        // import (adapter notes, Step 20 Z2) — that's where it has real
        // value (verifying the parse), not on the finished Actor sheet.
        // The field is left empty rather than removed: once
        // `CIFActor.unmapped` actually starts being populated (currently
        // always `[]`), ONLY what didn't fit anywhere else should land HERE.
        // [user report after Step 33 Z4, extended in Step 39 Z4]
        // `createActors.ts` OVERWRITES this field with attack
        // descriptions/entity notes found in prose — deliberately NOT here,
        // `fromActor` must remain a pure function (see the file header). The
        // placeholder MUST already have the target SHAPE
        // (`buildCharacterBiographyArray`/`buildActorNotesValue` in
        // `createActors.ts` branch on `actorData.type`, not on `route` — one
        // source of truth for the shape): `character` has `biography` as an
        // `ArrayField` of `{title, value}` objects (Step 38, measured
        // directly from the system source), `npc` — a single
        // `{personalDescription: {value}}` field.
        biography: isPlayerCharacter ? [] : { personalDescription: { value: '' } },
        // [Step 19 Z5, gap reported live] Verified directly against the
        // system source (`npc-system.js`): the NPC field starts by default
        // as `flags.locked = false` ("GM is still editing") — the combat
        // sheet in THIS state shows editable fields (name/skill), NOT a
        // clickable roll action. An automatically imported actor is by
        // definition "ready to review and use" (A5), so it starts locked —
        // exactly the same state the GM would manually "confirm" the sheet
        // into after creating it by hand.
        // [Step 39 Z4, UNVERIFIED for `character`] The NPC-system source was
        // confirmed directly (Step 19 Z5) — for `character` this field is
        // set IDENTICALLY, without the same verification against the
        // `character-system.js` source (Step 38 only checked
        // `_preCreateChanges` THERE, not this particular flag). The
        // behavior most consistent with the rest of the sheet (actor "ready
        // to review", A5); if Foundry doesn't have the field it will simply
        // ignore it — but A13 requires checking against a live actor (Z6,
        // product owner), not assuming.
        flags: { locked: true },
        // [Report after step 30, "Separating name from type/occupation"]
        // `occupation`/`age` (computed above) -> `system.infos.*` —
        // verified directly against the system source: both are plain
        // `StringField`s, exactly suited to this free-form text from the
        // rulebook (not `infos.type`, which in CoC7 denotes a creature
        // classification rather than a character's occupation). Omitted
        // entirely when no source provided them (backward compatibility —
        // the system field stays at its own default value).
        ...(occupation || age ? { infos: { ...(occupation ? { occupation } : {}), ...(age ? { age } : {}) } } : {}),
      },
    };

    // [user report, "armor disappeared from the notes now"] The
    // description cut off from the numeric value (`descriptionText`, see
    // the comment near `armorDescription` above) had UNTIL NOW gone only to
    // `notes` (pre-import review-screen diagnostics — `ARMOR_DESCRIPTION`),
    // NEVER onto the Actor sheet itself. As long as the profile author had
    // their OWN, manually pointed `proseBlock` targeting the same
    // paragraph, THAT block (via `cif.notes`) was the ONLY way this text
    // ever reached the character's notes at all — removing that block
    // (because it geometrically collided with the now-correctly-recognized
    // Armor field's own label, see `proseBlock.ts`) therefore removed the
    // description ENTIRELY, not just a redundant duplicate. Fix: append it
    // to `entityNotes` DIRECTLY from `cif.statistics`, using the same
    // mechanism as the other notes (label + text, with the same duplicate
    // heading rejection) — works REGARDLESS of whether the profile author
    // configured any `proseBlock` at all.
    const entityNotes = [...(cif.notes ?? [])];
    if (armorDescription) {
      const armorLabel = (cif.statistics['armour']?.sourceLabel ?? 'Pancerz').replace(/:\s*$/, '');
      entityNotes.push({ label: armorLabel, text: armorDescription });
    }

    return { data: { actorData, items, entityNotes }, notes, issues };
  },
};
