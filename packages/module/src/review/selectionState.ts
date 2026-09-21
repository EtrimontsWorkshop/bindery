import type { CIFDocument, CIFImage } from '@bindery/core';

/**
 * [Step 11 Z4] Selection model for the review screen. PURE presentation over
 * a decision `core` has already made (`CIFDocument.images[].classification`/
 * `.confidence`) — this file does NOT classify anything anew, it only
 * projects already-final fields onto "does the checkbox start checked"
 * (check:boundary, DoD: "the review screen contains no decision logic").
 *
 * [user report, "make it so all images are unchecked by default"] Default
 * selection: ALL images (`content` and `undecided` alike) start UNCHECKED —
 * the user explicitly checks what they actually want to import (the
 * previous Step 11 Z4 brief auto-checked confident `content`; dropped per an
 * explicit user request). Default order: `content` in page order, then
 * `undecided` sorted descending by area (`width*height`); real illustrations
 * are large, junk is small — the user reviews the first ~20 entries, not
 * ~180.
 */

/**
 * [Step 14 Z4] The destination of a SINGLE image, chosen by the user on the
 * review screen (MDD v2.1 §1.2, P1: "destination chosen per image"). `scene`
 * — creates a Scene with a background; `journal` — goes into a
 * SINGLE-PAGE JournalEntry as a handout; `token` — saved to disk (image
 * folder), without creating any document; `unassigned` — skipped on import,
 * until the user chooses something else (see `defaultImageDestination`
 * below — this used to be `skip`, replaced per an explicit user request, see
 * below).
 */
export type ImageDestination = 'scene' | 'journal' | 'token' | 'unassigned';

/**
 * [user report, "found images shouldn't be automatically assigned to
 * scenes/journals/tokens — let them all go to Unassigned, the user assigns
 * manually"] Previously the destination was guessed from `CIFImage.targetKind`
 * (scene->scene, portrait->token, handout/unknown->journal) — now ALWAYS
 * `unassigned`, regardless of `targetKind`: the automatic guess was too
 * often wrong (e.g. a portrait with no caption going straight to token), and
 * the user had to review every image manually anyway, so the "default
 * guess" just added noise to correct instead of saving work.
 */
export function defaultImageDestination(): ImageDestination {
  return 'unassigned';
}

function imageArea(image: CIFImage): number {
  return image.width * image.height;
}

/**
 * Default order of the image list: `content` (including low-confidence
 * `content`, see above) in ascending page order, THEN `undecided` sorted
 * descending by area.
 */
export function sortImagesForReview(images: readonly CIFImage[]): CIFImage[] {
  const content = images.filter((i) => i.classification === 'content').sort((a, b) => a.provenance.pageNumber - b.provenance.pageNumber);
  const undecided = images.filter((i) => i.classification === 'undecided').sort((a, b) => imageArea(b) - imageArea(a));
  return [...content, ...undecided];
}

export interface ReviewSelectionSnapshot {
  imageIds: readonly string[];
  sceneIds: readonly string[];
  journalIds: readonly string[];
  journalPageIds: readonly string[];
  /** [Step 14 Z4] The destination of EVERY image (not just selected ones) — `id -> destination`. */
  imageDestinations: ReadonlyMap<string, ImageDestination>;
}

/**
 * The selection state of the whole review screen — images, scenes,
 * journals, journal pages. Each domain is a `Map<id, boolean>` (not a Set of
 * selected ids) — an explicit `false` for unselected lets us distinguish
 * "deliberately unselected" from "id not yet known" (e.g. from a late-loaded
 * page), which simplifies the `has`/`get` calls in the UI (always defined
 * after `initialize`).
 */
export class ReviewSelection {
  #images = new Map<string, boolean>();
  #scenes = new Map<string, boolean>();
  #journals = new Map<string, boolean>();
  #journalPages = new Map<string, boolean>();
  /** [Step 14 Z4] Destination per image — a separate map from selection, because an unselected image STILL has a (unused, but remembered) destination. */
  #imageDestinations = new Map<string, ImageDestination>();
  /**
   * [Step 19, gap reported live: "I'm missing better journal sorting"] The
   * journal group name per image, ONLY for the `journal` destination — an
   * empty string (default) = the existing behavior, each image gets its OWN,
   * single JournalEntry. Images sharing THE SAME non-empty group name go
   * together into ONE JournalEntry (multiple pages) — the user decides the
   * sorting (e.g. by book chapter), `#runImport` in ReviewScreen only groups
   * by this already-made decision.
   */
  #imageJournalGroups = new Map<string, string>();

  static fromDocument(document: CIFDocument): ReviewSelection {
    const selection = new ReviewSelection();
    for (const image of document.images) {
      // [user report, "make it so all images are unchecked by default"]
      // Always `false` — see the doc-comment at the top of the file.
      selection.#images.set(image.id, false);
      selection.#imageDestinations.set(image.id, defaultImageDestination());
      selection.#imageJournalGroups.set(image.id, '');
    }
    // [Step 11] Scenes are already a decided, confident classification from
    // core (a CIFScene only exists when core has already deemed the image a
    // map/scene) — no own confidence field to threshold on, so they default
    // to SELECTED (mirroring Z4 "content" with no conflicting signals).
    for (const scene of document.scenes) selection.#scenes.set(scene.id, true);
    // [Step 16 Z2, bug fix] Extracting the whole book's text into journals
    // has been a SECONDARY/optional feature since the product pivot (Step
    // 11, Bindery-MDD-v2.1.md §0c) — the default "everything selected"
    // created "a mass of text journals" on EVERY import without asking, even
    // when the user only wanted individual images from the Images tab.
    // Default UNSELECTED — explicit opt-in via the Journals tab.
    for (const journal of document.journals) {
      selection.#journals.set(journal.id, false);
      for (const page of journal.pages) selection.#journalPages.set(page.id, false);
    }
    return selection;
  }

  isImageSelected(id: string): boolean {
    return this.#images.get(id) ?? false;
  }
  isSceneSelected(id: string): boolean {
    return this.#scenes.get(id) ?? false;
  }
  isJournalSelected(id: string): boolean {
    return this.#journals.get(id) ?? false;
  }
  isJournalPageSelected(id: string): boolean {
    return this.#journalPages.get(id) ?? false;
  }

  setImage(id: string, selected: boolean): void {
    if (this.#images.has(id)) this.#images.set(id, selected);
  }

  /**
   * [Step 18, "Select and crop"] Registers an image added AFTER
   * `fromDocument()` (a manual crop from the page preview, not from
   * automatic extraction) — `setImage`/`setImageDestination` above
   * deliberately do NOTHING for an unknown `id` (see their `if
   * (this.#X.has(id))` — a guard against typos elsewhere), so a manual crop
   * needs its own, explicit entry.
   *
   * [user report, "all images go to Unassigned, the user assigns manually"]
   * Starting selection = `destination !== 'unassigned'` — THE SAME rule
   * enforced by the dropdown change handler in `ReviewScreen.ts`
   * (`shouldBeSelected`), so the checkbox and the destination don't diverge
   * into two independent, silent sources of truth from the very START, not
   * only after the first manual change. `destination` here today is ALWAYS
   * `defaultImageDestination()` = `'unassigned'`, so in practice a manual
   * crop starts UNSELECTED, same as an automatically detected one — before
   * this change it used to start selected, because the destination was
   * immediately guessed from `targetKind`.
   */
  addManualImage(id: string, destination: ImageDestination): void {
    this.#images.set(id, destination !== 'unassigned');
    this.#imageDestinations.set(id, destination);
    this.#imageJournalGroups.set(id, '');
  }

  /** [Step 14 Z4] The image's destination — defaults from `defaultImageDestination`, overridable per image. */
  imageDestination(id: string): ImageDestination {
    return this.#imageDestinations.get(id) ?? 'unassigned';
  }
  setImageDestination(id: string, destination: ImageDestination): void {
    if (this.#imageDestinations.has(id)) this.#imageDestinations.set(id, destination);
  }
  /** [Step 14 Z4] Bulk operation "set for all SELECTED images" — see the Z4 brief. */
  setDestinationForSelected(destination: ImageDestination, scope?: ReadonlySet<string>): void {
    for (const [id, selected] of this.#images) {
      if (selected && (!scope || scope.has(id))) this.#imageDestinations.set(id, destination);
    }
  }

  /** [Step 19] The journal group name for an image — an empty string = no group (its own JournalEntry). */
  imageJournalGroup(id: string): string {
    return this.#imageJournalGroups.get(id) ?? '';
  }
  setImageJournalGroup(id: string, group: string): void {
    if (this.#imageJournalGroups.has(id)) this.#imageJournalGroups.set(id, group.trim());
  }
  /** [Step 19] Bulk operation "set the journal group for all SELECTED images" — mirrors `setDestinationForSelected`. */
  setJournalGroupForSelected(group: string, scope?: ReadonlySet<string>): void {
    const trimmed = group.trim();
    for (const [id, selected] of this.#images) {
      if (selected && (!scope || scope.has(id))) this.#imageJournalGroups.set(id, trimmed);
    }
  }
  setScene(id: string, selected: boolean): void {
    if (this.#scenes.has(id)) this.#scenes.set(id, selected);
  }
  setJournal(id: string, selected: boolean): void {
    if (this.#journals.has(id)) this.#journals.set(id, selected);
  }
  setJournalPage(id: string, selected: boolean): void {
    if (this.#journalPages.has(id)) this.#journalPages.set(id, selected);
  }

  /** Count of currently selected images — for the "N selected" counter in the screen header. */
  get selectedImageCount(): number {
    let n = 0;
    for (const v of this.#images.values()) if (v) n++;
    return n;
  }
  /** Selected images that actually have a destination — an "Unassigned" image is skipped by the import, so it must not count as something to import. */
  get selectedAssignedImageCount(): number {
    let n = 0;
    for (const [id, v] of this.#images) if (v && this.imageDestination(id) !== 'unassigned') n++;
    return n;
  }
  get selectedSceneCount(): number {
    let n = 0;
    for (const v of this.#scenes.values()) if (v) n++;
    return n;
  }
  get selectedJournalCount(): number {
    let n = 0;
    for (const v of this.#journals.values()) if (v) n++;
    return n;
  }

  /** Bulk (de)selection; `scope` limits it to those image ids (the images of the active tab) — without it, every image is affected. */
  selectAllImages(scope?: ReadonlySet<string>): void {
    for (const id of this.#images.keys()) if (!scope || scope.has(id)) this.#images.set(id, true);
  }
  selectNoImages(scope?: ReadonlySet<string>): void {
    for (const id of this.#images.keys()) if (!scope || scope.has(id)) this.#images.set(id, false);
  }

  setAllJournals(selected: boolean): void {
    for (const id of this.#journals.keys()) this.#journals.set(id, selected);
    for (const id of this.#journalPages.keys()) this.#journalPages.set(id, selected);
  }

  toSnapshot(): ReviewSelectionSnapshot {
    return {
      imageIds: [...this.#images.entries()].filter(([, v]) => v).map(([id]) => id),
      sceneIds: [...this.#scenes.entries()].filter(([, v]) => v).map(([id]) => id),
      journalIds: [...this.#journals.entries()].filter(([, v]) => v).map(([id]) => id),
      journalPageIds: [...this.#journalPages.entries()].filter(([, v]) => v).map(([id]) => id),
      imageDestinations: new Map(this.#imageDestinations),
    };
  }
}
