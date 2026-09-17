import type { Rect } from '../geometry.js';
import type { ImageTargetKind } from '../images/finalize.js';
import type { PageRoute } from '../profiles/pageRoute.js';
import type { Diagnostic } from '../text/types.js';

/**
 * CIF — Canonical Intermediate Format (Step 9 Z3, MDD §5.3). A neutral
 * format: it contains no concepts from any specific game system or Foundry.
 *
 * MDD v1.2 defines `CIFDocument`/`CIFActor`/`CIFScene`/`Provenance`/`Diagnostic`
 * directly, but only USES (does not define) `CIFJournal`/`CIFImage` in
 * field types — these two had to be designed here from scratch (verified
 * by grepping the MDD, no `interface CIFJournal`/`interface CIFImage`
 * anywhere in the file).
 *
 * `CIFActor` (statblocks) was deliberately OMITTED — the Step 9 brief
 * states directly: "the MVP does not need CIFActor (statblocks are v2.0)".
 * When it appears in v2.0, adding an `actors: CIFActor[]` field to
 * `CIFDocument` is an ADDITIVE change (optional or with a default), it
 * doesn't have to be breaking/major — but ANY change to the shape of
 * EXISTING fields (schemaVersion:1) requires a major bump (brief, Step 9).
 */

export interface Provenance {
  pageNumber: number;
  bbox: Rect;
  blockIds: string[];
}

/**
 * [Step 18 Z6] `CIFActor` — exactly per MDD §5.3 (it was deliberately
 * omitted from `CIFDocument` in the initial CIF design in step 9, "the MVP
 * does not need CIFActor" — see the comment at the top of the file). Adding
 * it here is an ADDITIVE change: new types, `CIFDocument.actors?:
 * CIFActor[]` optional, zero changes to existing fields — `schemaVersion`
 * stays `1`.
 *
 * [Scope narrowing, Step 18, clarified in Step 20 Z2b, extended in Step 39
 * Z1] Initially this step built CIFActor ONLY for NPCs/monsters (Z0: 15 out
 * of 27 "grids" in the test book, pre-generated Investigators deliberately
 * out of scope). Since step 39, `route` (below) distinguishes both
 * categories — see `profiles/pageRoute.ts` and
 * `profiles/assembleStatblocks.ts`. `traits`/`equipment`/`spells` are NOT
 * populated by `buildCIFActor` (no pattern for parsing them has been built
 * yet); they remain empty arrays, not guessed placeholder values. `skills`
 * has been populated since Step 20 Z2b, but ONLY when the profile
 * configured `entityAssembly.skillsPattern` — older/other profiles still
 * get an empty array. The fields exist in the type (per MDD), because they
 * belong to `CIFActor` as a whole, even when not currently populated.
 */
export interface CIFActor {
  id: string;
  name: string;
  /**
   * [Step 20 Z2] Whether `name` is a real name from the manual (confidence
   * >= the threshold, `entityAssembly.nameConfidenceThreshold`) or a
   * placeholder. Without this field, the review screen would have to guess
   * from the string's CONTENT (e.g. matching the profile's
   * `namePlaceholder` template) — fragile, because the template is
   * configurable per profile, so anything reading `CIFActor` would have to
   * know which profile produced it. An explicit, additive field.
   */
  nameConfident: boolean;
  /**
   * [Step 19 Z4, gap measured live] Populated ONLY when `name` is a
   * placeholder (confidence below the threshold) — a list of candidates
   * considered by geometric pairing (`entityAssembly`), so the user has a
   * CHANCE to determine which real character from the book is hiding
   * behind the placeholder "NPC from p. N (#k)", instead of guessing from
   * the page alone. Without this field, the information was computed
   * (`AssembledStatblock.name.candidates`) but lost when building
   * `CIFActor` — exactly the gap that Z1's DoD required ("Name below
   * threshold → placeholder with a list of candidates"), marked as
   * satisfied before it actually was.
   */
  nameCandidates?: readonly string[];
  /** Free-form label from the manual: "Cultist", "Thug", "Ghoul". No interpretation applied. */
  typeLabel?: string;
  /** CANONICAL keys (MDD §5.4), not names from the manual — `LabelledPairMatchEntry.canonicalKey`. */
  statistics: Record<string, CIFStat>;
  skills: CIFNamedValue[];
  attacks: CIFAttack[];
  traits: CIFNamedText[];
  equipment: CIFNamedText[];
  spells: CIFNamedText[];
  description?: string;
  /** Id from `CIFImage[]`. */
  imageRef?: string;
  /** ALWAYS populated (A3). */
  rawText: string;
  provenance: Provenance;
  /** Fields the profile was unable to classify. End up in the document's notes. */
  unmapped: CIFNamedText[];
  /**
   * [Step 34 Z2] Prose blocks attached geometrically
   * (`entityAssembly.notesPatterns`) — see `AssembledStatblock.notes`. `[]`
   * when the profile has no such pattern OR none matched (A10). Optional —
   * an additive field (like `attackBelowTexts` in `AssembledStatblock`), so
   * code that constructs `CIFActor` directly (test fixtures predating this
   * field) doesn't have to change.
   */
  notes?: { label: string; text: string }[];
  /**
   * [Step 39 Z1] The route whose set of patterns built this entity —
   * `'npc'` (monster/NPC) or `'playerCharacter'` (ready-made Investigator).
   * The adapter (`packages/module/src/adapters/coc7.ts`) uses it to choose
   * the Foundry actor type (`npc` vs `character`). Optional — an additive
   * field (like `notes` above), so code that constructs `CIFActor` directly
   * (test fixtures predating this field) doesn't have to change;
   * `undefined` is treated by the adapter as `'npc'` (the behavior before
   * step 39).
   */
  route?: PageRoute;
}

export interface CIFStat {
  /** Raw value, exactly as in the book. */
  raw: string;
  numeric?: number;
  unit?: 'percent' | 'plain' | 'dice' | 'modifier';
  /** Original label — for display in the review screen and for notes. */
  sourceLabel: string;
  confidence: number;
  /** [Step 33 Z1] Footnote found on its own line right after the block, associated with this value because it is the ONLY one in the block that ends with a bare asterisk — see `LabelledPairMatchEntry.footnoteText` (profiles/patterns.ts). */
  footnoteText?: string;
  /** [Step 34 Z1] Description cut off from `raw` AFTER the number at the start of the same value ("Armor: 5, unusually thick skin" -> `raw`="5", this field="unusually thick skin") — see `LabelledPairMatchEntry.descriptionText` (profiles/patterns.ts). */
  descriptionText?: string;
}

export interface CIFAttack {
  name: string;
  /** Raw string; the adapter parses it according to its own rules (MDD §5.3 — not a CIF-level interpretation). */
  toHit?: string;
  damage?: string;
  range?: string;
  properties: string[];
  rawText: string;
  /** [Step 33 Z4] Description found in the prose below the ATTACKS section, introduced by its own subheading starting with the full name of this attack — see `attackDescriptionCrossReference.ts`. `undefined` when nothing was found. */
  belowText?: string;
}

/** [Step 18, designed from scratch — the MDD uses this type in the `skills` field, but never defines it] Name + single value, e.g. skill + percentage. */
export interface CIFNamedValue {
  name: string;
  value: string;
  confidence?: number;
}

/** [Step 18, designed from scratch — as above, the `traits`/`equipment`/`spells`/`unmapped` fields] Name + arbitrary accompanying text. */
export interface CIFNamedText {
  name: string;
  text: string;
}

/**
 * [Step 9 discovery] The MDD defines `CIFScene` WITHOUT `rawText`, but the
 * Step 9 brief directly requires "rawText with the original content
 * (assumption A3) for EVERY element" — extending the MDD's type with
 * `rawText` (an empty string when a scene has no accompanying text at all
 * — heading/caption).
 */
export interface CIFScene {
  id: string;
  name: string;
  imageRef: string;
  /** null = not detected. Do NOT guess (MDD) — automatic grid detection is out of MVP scope. */
  suggestedGrid: { sizePx: number; offsetX: number; offsetY: number } | null;
  rawText: string;
  provenance: Provenance;
}

/** [Step 9, designed from scratch — see the comment at the top of the file] A system-neutral image (map/handout/portrait), independent of whether it ends up on a scene or in a journal. */
export interface CIFImage {
  id: string;
  targetKind: ImageTargetKind;
  width: number;
  height: number;
  format: string;
  /** Reference to the image bytes — filled in by the import layer (outside the CIF, which is pure data), NOT the binary content itself. */
  assetRef: string;
  /** Caption/accompanying text (a nearby `caption` block), if any. */
  caption?: string;
  /**
   * [Step 11 Z4, ADDITIVE field — does not change schemaVersion:1]
   * `'content'` or `'undecided'` — ONLY these two values enter the CIF
   * (`decoration`/`mask` are rejected earlier, see `buildCIFDocument.ts`).
   * The review screen (phase 9) uses this field for default
   * checking/sorting — `packages/module` does NOT compute the
   * classification itself, it only READS what `core` has already decided
   * (A1/check:boundary).
   */
  classification: 'content' | 'undecided';
  /** [Step 11 Z4, ADDITIVE field] See `ClassifiedImage.confidence` in `images/classify.ts`. */
  confidence: number;
  /**
   * [Step 17, ADDITIVE field] Automatic grid-detection suggestion from
   * pixels (`images/detectGrid.ts`) — best-effort, `undefined` when nothing
   * was found. ONLY a suggestion to pre-fill the manual calibrator
   * (`GridPicker`, `packages/module`) — `packages/core` does NOT decide
   * whether it is "confident enough" to show (that decision is UI policy,
   * see the comment in `detectGrid.ts`).
   */
  suggestedGrid?: { size: number; offsetX: number; offsetY: number; confidence: number };
  rawText: string;
  provenance: Provenance;
}

/** [Step 9, designed from scratch] A single journal page — the equivalent of `JournalEntryPage` (Foundry), but neutral. */
export interface CIFJournalPage {
  id: string;
  name: string;
  /** 1-6, the heading level FROM WHICH this page was created (Foundry `title.level`). */
  headingLevel: number;
  /** HTML already SANITIZED (Z5) — ready for `JournalEntryPage.text.content`. */
  html: string;
  /** `CIFImage.id` of images embedded in this page's content, in order of occurrence. */
  imageRefs: string[];
  rawText: string;
  provenance: Provenance;
}

/** [Step 9, designed from scratch] A single journal entry — the equivalent of `JournalEntry` (Foundry), but neutral; the bookmark tree flattened into (JournalEntry -> pages), see `buildJournalHierarchy.ts`. */
export interface CIFJournal {
  id: string;
  name: string;
  pages: CIFJournalPage[];
  rawText: string;
  provenance: Provenance;
}

export interface CIFDocument {
  schemaVersion: 1;
  source: {
    fileName: string;
    fileHash: string;
    pageCount: number;
    detectedProfileId: string | null;
    detectedLanguage: string | null;
    /** ISO 8601. */
    extractedAt: string;
  };
  journals: CIFJournal[];
  scenes: CIFScene[];
  images: CIFImage[];
  /** [Step 18 Z6, ADDITIVE field — does not change schemaVersion:1] NPC/monster statblocks, see `cif/buildCIFActor.ts`. Optional: documents built before this step (and all tests constructing them) remain valid without this field. */
  actors?: CIFActor[];
  diagnostics: Diagnostic[];
}
