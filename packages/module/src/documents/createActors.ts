import type { AdapterResult } from '@bindery/core';
import { escapeHtmlBasic, type Coc7ActorPayload, type Coc7EmbeddedItemSpec } from '../adapters/coc7.js';

/**
 * [Step 19 Z3] `Actor.createDocuments()` as a batch (never in a loop) +
 * embedded `Item`s (skill/weapon) for each created actor, with the correct
 * `weapon -> skill` link via `system.skill.main.id`. Consumes
 * `AdapterResult<Coc7ActorPayload>[]` from `coc7Adapter.fromActor` (Z1) —
 * the adapter ONLY returns data, THIS function is the only place that
 * actually creates documents (A5-compliant split: "what" decisions are made
 * earlier/elsewhere, "save this to the database" happens here, mechanically).
 */

const NON_WEAPON_ATTACK_NAMES = new Set(['unik', 'dodge', 'uniknięcie']);

export interface CreateActorsInput {
  results: readonly AdapterResult<Coc7ActorPayload>[];
  /** [Step 11 Z6 pattern] `Actor` folder id (see `ensureFolder.ts`) — `undefined` = root. */
  folder?: string;
  signal?: AbortSignal;
}

export interface CreatedActorEntry {
  actor: foundry.documents.BaseActor;
  notes: AdapterResult<Coc7ActorPayload>['notes'];
  issues: AdapterResult<Coc7ActorPayload>['issues'];
}

/** `weapon` is skipped for ATTACKS entries that are actually a defensive reaction (Dodge), not weapons — the decision is described (and deliberately deferred) in the `Coc7EmbeddedItemSpec` comment in `adapters/coc7.ts`. */
function isDodgeLikeAttackName(name: string): boolean {
  return NON_WEAPON_ATTACK_NAMES.has(name.trim().toLowerCase());
}

function buildSkillItemData(spec: Coc7EmbeddedItemSpec & { kind: 'skill' }): object {
  // [H4 trap, reconfirmed in Z1] `system.value` is a GETTER — write ONLY
  // through `system.adjustments.base`.
  return { name: spec.name, type: 'skill', system: { skillName: spec.name, adjustments: { base: spec.basePercent ?? 0 } } };
}

function buildWeaponItemData(spec: Coc7EmbeddedItemSpec & { kind: 'weapon' }, skillIdByName: ReadonlyMap<string, string>): object {
  const linkedName = spec.linkedSkillName ?? spec.name;
  // [Step 33 Z4, FIX after the report "Additional attack description does
  // not appear in Notes"] `system.description` on a CoC7 weapon sheet is
  // THREE SEPARATE fields: `value` (description, the same as
  // `spec.description` below — has worked since step 20), `special` and
  // `keeper` ("Keeper's Notes" — its OWN tab on the sheet, separate from
  // "Description"). The first version of this fix appended `belowText` to
  // `value` — TECHNICALLY visible, but not where the user naturally looks
  // for "notes" (confirmed directly: `Item.create({type:'weapon'})` on a
  // live Foundry instance returns `system.description =
  // {value, special, keeper}` — `keeper` is the RIGHT place for information
  // FOR THE KEEPER found OUTSIDE the attack entry itself, not a mixin to
  // its description). The label ("From the text below...") is still
  // appended — the "Keeper's Notes" tab alone doesn't explain WHERE this
  // text comes from (it could look like the Keeper's own note, not a
  // source excerpt from the book).
  const keeperNotes = spec.belowText ? `<p><em>${game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel')}</em> ${spec.belowText}</p>` : undefined;
  return {
    name: spec.name,
    type: 'weapon',
    // [Step 41, reported live] CoC7's own `defaultImg` for the "weapon" type
    // is always `icons/svg/sword.svg` — THE SAME for melee and ranged
    // (confirmed in the system source), so without this every imported
    // weapon got an identical sword icon, even a pistol/rifle. For ranged
    // weapons we explicitly override it with a real firearm icon from
    // Foundry's built-in assets (the same one carried by CoC7's ready-made
    // compendium entries for firearms) — for melee we set NOTHING, to
    // preserve the system's existing (correct) default sword.
    ...(spec.ranged ? { img: 'icons/weapons/guns/gun-wood.webp' } : {}),
    system: {
      skill: { main: { name: linkedName, id: skillIdByName.get(linkedName) ?? null } },
      range: { normal: { value: '', damage: spec.damage ?? '' } },
      // [Step 40, reported live] CoC7 creates EVERY weapon as melee by
      // default (`properties.rngd` initializes to `false`, no separate
      // "melee" field) — without this, every imported pistol/rifle landed
      // on the character sheet as melee. `spec.ranged` comes from the
      // profile (`SectionListPattern.rangedKeywords`), not from logic
      // invented here.
      properties: { rngd: spec.ranged ?? false },
      // [Step 20 Z2, gap measured live] Without this, the weapon sheet's
      // "Description" tab is empty — `spec.description` carries the raw
      // matched text from the book (adapters/coc7.ts), the only place where
      // the SOURCE text of this particular attack (e.g. parenthetical
      // footnotes) is visible after import.
      description: { value: spec.description ?? '', ...(keeperNotes ? { keeper: keeperNotes } : {}) },
    },
  };
}

/**
 * [user report after Step 33 Z4, "I don't see any description in the
 * notes"] `belowText` (the description found in prose BELOW the ATTACKS
 * section) was only going into EACH weapon's own "Keeper's Notes" tab
 * separately (`buildWeaponItemData` above) — the user was checking the
 * character's MAIN "Notes" tab (`biography.personalDescription`,
 * deliberately empty since Step 20 Z2) and found nothing there. This copies
 * THE SAME descriptions (not the whole raw statblock — Step 20 Z2 still
 * stands, characteristics/attacks/skills are already visible elsewhere on
 * the sheet, so duplicating THEM would be noise) ALSO into the character's
 * notes, one sentence per found description, labeled with the attack name.
 * An empty string when no attack has `belowText` (A7 — nothing to copy is a
 * valid result).
 *
 * [Step 34 Z2] `entityNotes` (prose blocks attached geometrically,
 * `Coc7ActorPayload.entityNotes`) is APPENDED to THIS SAME note, each one
 * labeled with its OWN pattern label (e.g. "Description"), NOT concatenated
 * into one string (step 34 brief: "In the actor note, blocks are separated
 * by headings from the labels").
 *
 * [user report, "Invisibility Invisibility: ability..."] The block's label
 * (entered by the profile author in the Studio) often duplicates the book's
 * OWN sub-heading, which is already the FIRST word of the matched content
 * (because the note geometrically starts FROM that sub-heading — see
 * `proseBlock.ts`) — showing BOTH produces "Invisibility Invisibility: ...".
 * When the content already starts (case-insensitively) with the label, that
 * OWN fragment (with the colon) is BOLDED instead of prepending a second,
 * separate heading. GENUINELY unrelated labels (the author can still type
 * anything) are still shown as before (its own bolded heading + space +
 * full content).
 *
 * [user report, "Invisibility, Spells and Sanity Loss should be bold"] The
 * previous version, on a match (content already starts with the label),
 * dropped the bolding ENTIRELY to avoid a duplicate — but the note then
 * looked like a plain paragraph with no heading at all. `splitLeadingLabel`
 * instead extracts EXACTLY that text fragment (with its original
 * capitalization and colon), so it can be bolded instead of omitted.
 *
 * [Live report after Step 39, "Investigator's history Investigator's
 * history: ..."] A colon was REQUIRED right after the label — this worked
 * for books where the note's sub-heading has the form "Label:" (e.g.
 * "Invisibility:"), but NOT for the Investigators in "Wrak.pdf":
 * "Investigator's History" is the section's MAIN heading (the `heading`
 * role, no colon) — a colon appears ONLY on SUB-labels WITHIN this section
 * ("Appearance:", "Traits:"), not on the section heading itself. Without a
 * colon, `splitLeadingLabel` always returned `null` for this block, so the
 * duplicated fragment was never extracted. The colon is now OPTIONAL
 * (`:?`) — it still requires an EXACT text match of the label at the very
 * start (a small risk of a false match), but no longer requires specific
 * punctuation after it.
 */
function splitLeadingLabel(label: string, text: string): { prefix: string; rest: string } | null {
  const normalizedLabel = label.trim().replace(/:$/, '');
  if (normalizedLabel.length === 0) return null;
  const leadingWhitespace = text.length - text.trimStart().length;
  const match = new RegExp(`^${normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?`, 'iu').exec(text.slice(leadingWhitespace));
  if (!match) return null;
  return { prefix: text.slice(leadingWhitespace, leadingWhitespace + match[0].length), rest: text.slice(leadingWhitespace + match[0].length) };
}

/**
 * [Live report, "everything is one after another, it should be like in the
 * PDF, one below the other starting on a new line"] `stopAtSameFontRole`
 * (the engine, `proseBlock.ts`) inserts `"\n\n"` wherever the collection
 * FLEW PAST a sub-heading instead of stopping at it (e.g. "Appearance:"
 * inside "Investigator's History") — a single `<p>` with a raw `"\n\n"`
 * inside it would render as ONE paragraph (HTML collapses whitespace),
 * losing exactly that split. So this splits into separate `<p>` elements —
 * one per paragraph/entry, matching how it visually appears in the PDF. For
 * text without `"\n\n"` (every existing profile so far), behavior is
 * identical to before — a single `<p>`.
 */
function paragraphsToHtml(text: string): string {
  return text
    .split('\n\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtmlBasic(p)}</p>`)
    .join('');
}

function buildActorNotesValue(items: readonly Coc7EmbeddedItemSpec[], entityNotes: readonly { label: string; text: string }[]): string {
  const label = game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel');
  const attackParts = items
    .filter((it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !!it.belowText)
    .map((it) => `<p><strong>${escapeHtmlBasic(it.name)}</strong> — <em>${label}</em> ${it.belowText}</p>`);
  const entityParts = entityNotes.map((n) => {
    const split = splitLeadingLabel(n.label, n.text);
    const body = split ? split.rest : n.text;
    const leadHtml = split ? `<strong>${escapeHtmlBasic(split.prefix)}</strong>` : `<strong>${escapeHtmlBasic(n.label)}</strong> `;
    const paragraphs = body
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length === 0) return `<p>${leadHtml}</p>`;
    const [first, ...rest] = paragraphs;
    return [`<p>${leadHtml}${escapeHtmlBasic(first!)}</p>`, ...rest.map((p) => `<p>${escapeHtmlBasic(p)}</p>`)].join('');
  });
  return [...attackParts, ...entityParts].join('');
}

/**
 * [Step 39 Z4] `character`'s `biography` is an `ArrayField` of `{title,
 * value}` objects (Step 38, measured directly from the system source — see
 * `adapters/coc7.ts`), NOT a single text field like `npc`'s
 * (`buildActorNotesValue` above). Each note block (`entityNotes`, e.g.
 * "Investigator's History"/"Appearance") becomes its OWN array entry —
 * matches the measured structure 1:1, without concatenating into one
 * paragraph (which for a player character would lose the sheet's readable
 * section breakdown). Attack descriptions from ATTACKS (`belowText`) get
 * their OWN entry, labeled with the attack name — the same reasoning as
 * `buildActorNotesValue` (rare for pre-generated Investigators, but possible
 * if a profile configures `attackDescriptionCrossReference` on this route).
 */
function buildCharacterBiographyArray(
  items: readonly Coc7EmbeddedItemSpec[],
  entityNotes: readonly { label: string; text: string }[],
): { title: string; value: string }[] {
  const label = game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel');
  const attackEntries = items
    .filter((it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !!it.belowText)
    .map((it) => ({ title: it.name, value: `<p><em>${label}</em> ${it.belowText}</p>` }));
  // [Live report after Step 39, "Investigator's history Investigator's
  // history: ..."] Unlike `buildActorNotesValue` (NPC, a SINGLE text field,
  // so the bolded prefix is the ONLY place the label is ever visible) —
  // here `title` ALREADY CARRIES the label as its OWN, SEPARATE
  // `ArrayField` field (a section heading on the CoC7 sheet, Step 38).
  // Bolding the extracted prefix INSIDE `value` would show the label AGAIN,
  // right below its own heading — the exact same duplicate, just bolded
  // instead of plain. So when `split` succeeds, the prefix is simply
  // OMITTED (not bolded) — `title` already shows it.
  const noteEntries = entityNotes.map((n) => {
    const split = splitLeadingLabel(n.label, n.text);
    const value = paragraphsToHtml((split ? split.rest : n.text).trimStart());
    return { title: n.label, value };
  });
  return [...attackEntries, ...noteEntries];
}

/**
 * Direct read of the Foundry document class — the same pattern as
 * `createSceneFromImage.ts`/`ensureFolder.ts` (`foundry.documents.X` in
 * newer versions, `globalThis.X` as a backward-compatibility fallback).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDocumentClass(name: 'Actor' | 'Item'): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (foundry.documents as any)[name] ?? (globalThis as any)[name];
}

export async function createActorsFromAdapterResults(input: CreateActorsInput): Promise<CreatedActorEntry[]> {
  input.signal?.throwIfAborted();
  if (input.results.length === 0) return [];

  const ActorCls = getDocumentClass('Actor');
  const ItemCls = getDocumentClass('Item');

  // [Step 39 Z4] The shape of `biography` branches on `actorData.type`
  // (`'character'` vs `'npc'`, set by the adapter based on
  // `CIFActor.route` — see `adapters/coc7.ts`), NOT on some separate
  // parameter here — one source of truth for the actor type.
  const actorDataArray = input.results.map((r) => {
    const actorData = r.data.actorData as { type?: string; system?: Record<string, unknown> } & Record<string, unknown>;
    if (actorData.type === 'character') {
      const biography = buildCharacterBiographyArray(r.data.items, r.data.entityNotes);
      if (biography.length === 0) return { ...actorData, folder: input.folder };
      return { ...actorData, folder: input.folder, system: { ...actorData.system, biography } };
    }
    const notesValue = buildActorNotesValue(r.data.items, r.data.entityNotes);
    if (!notesValue) return { ...actorData, folder: input.folder };
    return {
      ...actorData,
      folder: input.folder,
      system: { ...actorData.system, biography: { personalDescription: { value: notesValue } } },
    };
  });

  // [DoD Z3] Actor.createDocuments() as a BATCH — one call for ALL actors
  // from this book, never a `for (...) Actor.create(...)` loop.
  const createdActors: { id: string; name: string }[] = await ActorCls.createDocuments(actorDataArray);
  if (!createdActors || createdActors.length !== input.results.length) {
    throw new Error(`Bindery | Actor.createDocuments returned ${createdActors?.length ?? 0} documents, expected ${input.results.length}`);
  }

  // [Step 19 Z4, problem measured live] DO NOT assume `createdActors` comes
  // back in the SAME order as `actorDataArray` — measured live in Foundry
  // (user: "NPC from p. 55 #3 is actually the Parasitic..."), one actor's
  // data was loaded under a DIFFERENT one's name. Foundry's code
  // (`client-backend.mjs`) gives no HARD, documented ordering guarantee
  // through the whole preCreate/hook/socket-response chain, so instead of
  // relying on array position, each created document is matched to its
  // adapter result BY NAME (unique within this batch by construction — each
  // placeholder carries its own page number+ordinal). Duplicate names
  // (shouldn't happen, but no guessing) get the FIRST still-unused entry
  // from the queue, stably in original input order — not randomly.
  const resultQueueByName = new Map<string, number[]>();
  input.results.forEach((r, idx) => {
    const name = (r.data.actorData as { name: string }).name;
    const queue = resultQueueByName.get(name) ?? [];
    queue.push(idx);
    resultQueueByName.set(name, queue);
  });

  const entries: CreatedActorEntry[] = [];
  try {
    for (let i = 0; i < createdActors.length; i++) {
      input.signal?.throwIfAborted();
      const actorDoc = createdActors[i]!;
      const queue = resultQueueByName.get(actorDoc.name);
      const resultIndex = queue?.shift();
      if (resultIndex === undefined) {
        throw new Error(
          `Bindery | could not match the created actor "${actorDoc.name}" to any adapter result (name mismatch between the request and Foundry's response) — aborted to avoid assigning Items to the wrong actor`,
        );
      }
      const result = input.results[resultIndex]!;

      const skillSpecs = result.data.items.filter((it): it is Coc7EmbeddedItemSpec & { kind: 'skill' } => it.kind === 'skill');
      const weaponSpecs = result.data.items.filter(
        (it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !isDodgeLikeAttackName(it.name),
      );

      const skillIdByName = new Map<string, string>();
      if (skillSpecs.length > 0) {
        const skillDocs: { id: string; name: string }[] = await ItemCls.createDocuments(
          skillSpecs.map(buildSkillItemData),
          { parent: actorDoc },
        );
        for (const doc of skillDocs) skillIdByName.set(doc.name, doc.id);
      }

      input.signal?.throwIfAborted();

      // A weapon requires `system.skill.main.id` from the ALREADY created
      // skill Item (above) — hence TWO sequential calls per actor, not one.
      if (weaponSpecs.length > 0) {
        await ItemCls.createDocuments(
          weaponSpecs.map((spec) => buildWeaponItemData(spec, skillIdByName)),
          { parent: actorDoc },
        );
      }

      entries.push({ actor: actorDoc as unknown as foundry.documents.BaseActor, notes: result.notes, issues: result.issues });
    }
  } catch (err) {
    // [DoD Z3] An AbortSignal (or any other error during Item creation)
    // aborts WITHOUT leaving garbage behind — we delete ALL already-created
    // actors (embedded Items cascade-delete with their parent in Foundry),
    // not just the ones that had already gotten their Items.
    const ids = createdActors.map((a) => a.id);
    await ActorCls.deleteDocuments(ids).catch(() => {});
    throw err;
  }

  return entries;
}
