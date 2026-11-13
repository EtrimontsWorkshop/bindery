import type { CIFDocument, CIFImage, Diagnostic } from '@bindery/core';
import { pickGrid, type GridConfig } from '../apps/GridPicker.js';
import { createJournalsFromCIF, type CIFJournalForCreation } from '../documents/createJournalFromCIF.js';
import { createJournalHandoutFromImage } from '../documents/createJournalHandoutFromImage.js';
import { createJournalHandoutFromImages } from '../documents/createJournalHandoutFromImages.js';
import { createSceneFromImage } from '../documents/createSceneFromImage.js';
import { ensureFolder } from '../documents/ensureFolder.js';
import { uploadImage, UploadSession } from '../documents/uploadImages.js';
import { SCENES_JOURNALS_FROM_CIF_ENABLED } from '../featureFlags.js';
import { pageRef } from '../i18n.js';
import type { ImportTargets } from '../settings.js';
import type { StatblockReviewState } from '../statblock/ui/statblockReviewState.js';
import type { ReviewSelection } from './selectionState.js';

/**
 * The import itself: what happens when the user confirms the review. It uploads the chosen pictures and creates the
 * scenes, journals and actors, from the choices the review screen holds. Moved out of `ReviewScreen.ts` unchanged; the
 * screen passes its state in (`ReviewImportContext`) and shows what comes back.
 */

/**
 * What earlier import attempts of one review already did. An attempt that fails part-way (a folder that cannot be
 * created, a journal that cannot be saved) leaves the documents it made behind, and clicking "Import" again would
 * make them a second time. A retry skips what is recorded here and keeps its summary entries; an upload is reused
 * while the picture's bytes are the same array (an edit replaces them, so an edited picture is uploaded again).
 */
export interface ImportProgress {
  doneKeys: Set<string>;
  entries: { label: string; uuid?: string }[];
  uploads: Map<string, { bytes: Uint8Array; path: string }>;
}

export interface ReviewImportContext {
  document: CIFDocument;
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  /** The PDF's file name: the base of uploaded files' names. */
  fileName: string;
  targets: ImportTargets;
  selection: ReviewSelection;
  progress: ImportProgress;
  /** Images changed by hand (eraser, token panel): the "white background" setting leaves them as they are. */
  handEditedImageIds: ReadonlySet<string>;
  /** The Statblocks tab's state, `null` while that feature is off or was never opened. */
  statblocks: StatblockReviewState | null;
}

/** Below this confidence a detected grid is not offered as the starting point of the grid window. */
const MIN_GRID_SUGGESTION_CONFIDENCE = 0.4;

export async function runReviewImport(ctx: ReviewImportContext): Promise<{ entries: { label: string; uuid?: string }[]; diagnostics: Diagnostic[] }> {
  const doc = ctx.document;
  const baseName = ctx.fileName.replace(/\.pdf$/i, '') || 'bindery-import';
  const prefix = ctx.targets.namePrefix.trim();
  const withPrefix = (name: string): string => (prefix ? `${prefix} ${name}` : name);
  // The uploaded FILE's name mirrors the document name the user actually
  // typed in the Images tab (`image.caption`), sanitized by `uploadImage`
  // itself — an empty caption keeps the previous, PDF-filename+id scheme
  // unchanged.
  const uploadBaseNameFor = (image: CIFImage): string => (image.caption?.trim() ? `${baseName}-${image.caption.trim()}` : `${baseName}-${image.id}`);

  const progress = ctx.progress;
  const entries = progress.entries;
  const done = progress.doneKeys;
  const runDiagnostics: Diagnostic[] = [];
  const uploadSession = new UploadSession();
  /**
   * Uploads a picture once per import (and across retries, see `ImportProgress`) — a picture used both as an image
   * destination and as a statblock's portrait is uploaded once.
   */
  const uploadOnce = async (imageId: string, bytes: { bytes: Uint8Array; format: string }, uploadBaseName: string): Promise<string> => {
    const known = progress.uploads.get(imageId);
    if (known && known.bytes === bytes.bytes) return known.path;
    const upload = await uploadImage({ bytes: bytes.bytes, baseName: uploadBaseName, format: bytes.format === 'png' ? 'png' : 'webp', keepTransparency: ctx.handEditedImageIds.has(imageId) }, { session: uploadSession });
    progress.uploads.set(imageId, { bytes: bytes.bytes, path: upload.path });
    return upload.path;
  };

  // Scenes — SOLELY the selected ones.
  const sceneFolderId = await ensureFolder(ctx.targets.sceneFolder, 'Scene');
  // Images already handled via CIFScene
  // (below) or embedded in a journal (further down) do NOT pass through
  // the per-image destination loop again — the same image shouldn't get
  // TWO documents. SOLELY for scenes/journals/pages that are ACTUALLY
  // selected — the original version added `scene.imageRef`
  // unconditionally, so an image belonging to an UNSELECTED (and thus
  // never created) CIFScene was nonetheless excluded from the per-image
  // destination loop in the Images tab ("the scene isn't created" — the
  // image got NO document at all, contrary to the user's intent set in
  // the dropdown).
  const usedImageIds = new Set<string>();
  // See the comment next to `SCENES_JOURNALS_FROM_CIF_ENABLED`
  // at the top of the file — CIFScene/CIFJournal auto-detection is
  // disabled "for now", the same images are still available in the Images
  // tab with a Scene/Journal Destination.
  if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
    for (const scene of doc.scenes) {
      if (ctx.selection.isSceneSelected(scene.id)) usedImageIds.add(scene.imageRef);
    }

    for (const scene of doc.scenes) {
      if (!ctx.selection.isSceneSelected(scene.id)) continue;
      if (done.has(`scene:${scene.id}`)) continue;
      const image = doc.images.find((i) => i.id === scene.imageRef);
      const bytes = ctx.imageBytesById.get(scene.imageRef);
      if (!image || !bytes) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_IMAGE_MISSING', params: { name: scene.name, imageRef: scene.imageRef }, pageNumber: scene.provenance.pageNumber });
        continue;
      }
      try {
        const name = withPrefix(scene.name);
        const grid = await pickGridForImage(bytes, image);
        if (grid === null) {
          runDiagnostics.push({ severity: 'warning', code: 'REVIEW_SCENE_SKIPPED', params: { name }, pageNumber: scene.provenance.pageNumber });
          continue;
        }
        const imagePath = await uploadOnce(scene.imageRef, bytes, `${baseName}-${scene.imageRef}`);
        const created = await createSceneFromImage({ name, imagePath, width: image.width, height: image.height, grid, folder: sceneFolderId });
        entries.push({ label: name, uuid: created.uuid ?? undefined });
        done.add(`scene:${scene.id}`);
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_CREATE_FAILED', params: { name: scene.name, error: err instanceof Error ? err.message : String(err) }, pageNumber: scene.provenance.pageNumber });
      }
    }
  }

  // Journals — SOLELY selected journals, SOLELY selected pages within them.
  const journalFolderId = await ensureFolder(ctx.targets.journalFolder, 'JournalEntry');
  if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
    const filteredJournals: CIFJournalForCreation[] = [];
    for (const journal of doc.journals) {
      if (!ctx.selection.isJournalSelected(journal.id)) continue;
      const pages = journal.pages.filter((p) => ctx.selection.isJournalPageSelected(p.id));
      if (pages.length === 0) continue;
      for (const p of pages) for (const id of p.imageRefs) usedImageIds.add(id);
      filteredJournals.push({ name: withPrefix(journal.name), pages: pages.map((p) => ({ name: p.name, headingLevel: p.headingLevel, html: p.html })) });
    }
    if (filteredJournals.length > 0 && !done.has('cifJournals')) {
      const imagesForUpload = doc.images.filter((i) => usedImageIds.has(i.id)).map((i) => ({ id: i.id, format: i.format }));
      const result = await createJournalsFromCIF({
        journals: filteredJournals,
        images: imagesForUpload,
        imageBytesById: ctx.imageBytesById,
        baseName,
        folder: journalFolderId,
        uploadSession,
      });
      done.add('cifJournals');
      for (const j of result.createdJournals) entries.push({ label: j.name, uuid: j.uuid });
      for (const missing of result.missingImageIds) {
        runDiagnostics.push({ severity: 'warning', code: 'REVIEW_JOURNAL_IMAGE_MISSING', params: { imageId: missing } });
      }
    }
  }

  const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);

  // Images with the `journal` destination AND a non-empty
  // group name (set in the Images tab — per-image or in bulk) go
  // TOGETHER into ONE JournalEntry (multiple image-type pages), instead of
  // each getting its own separate journal as before. Images with an EMPTY
  // group (the default) keep the old behavior — handled by the per-image
  // loop below, which skips images already in `usedImageIds`.
  const journalGroups = new Map<string, CIFImage[]>();
  for (const image of doc.images) {
    if (usedImageIds.has(image.id)) continue;
    if (!ctx.selection.isImageSelected(image.id)) continue;
    if (ctx.selection.imageDestination(image.id) !== 'journal') continue;
    const group = ctx.selection.imageJournalGroup(image.id);
    if (!group) continue;
    // Claimed right away (not only after successful processing below) —
    // this image BELONGS to the group regardless of whether its
    // processing succeeds; the per-image loop below shouldn't touch it
    // even on error (avoids duplicate diagnostics for the same image).
    usedImageIds.add(image.id);
    const list = journalGroups.get(group) ?? [];
    list.push(image);
    journalGroups.set(group, list);
  }
  for (const [groupName, groupImages] of journalGroups) {
    if (done.has(`journalGroup:${groupName}`)) continue;
    const pages: { name: string; imagePath: string }[] = [];
    for (const image of groupImages) {
      const bytes = ctx.imageBytesById.get(image.id);
      if (!bytes) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
        continue;
      }
      try {
        const imagePath = await uploadOnce(image.id, bytes, uploadBaseNameFor(image));
        pages.push({ name: withPrefix(image.caption?.trim() || `${defaultImageName} ${pageRef(image.provenance.pageNumber)}`), imagePath });
      } catch (err) {
        // A code distinct from `REVIEW_IMAGE_DESTINATION_FAILED` below —
        // a different parameter shape (imageId+groupName, not name+destination), so
        // a shared code would give an inconsistent localization template.
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_JOURNAL_GROUP_FAILED', params: { imageId: image.id, groupName, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
      }
    }
    if (pages.length === 0) continue;
    try {
      const created = await createJournalHandoutFromImages({ name: withPrefix(groupName), pages, folder: journalFolderId });
      entries.push({ label: created.name, uuid: created.uuid ?? undefined });
      done.add(`journalGroup:${groupName}`);
    } catch (err) {
      runDiagnostics.push({ severity: 'error', code: 'REVIEW_JOURNAL_GROUP_CREATE_FAILED', params: { groupName, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  // The UPLOADED `token` image path per `CIFImage.id` — records what was ACTUALLY uploaded for
  // images whose destination is `token`. An image that for some reason didn't end up HERE
  // (deselected in the Images tab, destination changed, upload error — see the `catch` below)
  // simply has no entry, instead of a path to a nonexistent file.
  const uploadedTokenImagePathById = new Map<string, string>();

  // Per-image destination (Images tab) — SOLELY selected
  // images that have NOT already been handled as a CIFScene, embedded in
  // a journal, or gathered into a journal group above. `scene`/`journal`/
  // `token` are created directly from a SINGLE image;
  // `unassigned` (formerly `skip`, see
  // `defaultImageDestination`) is skipped.
  for (const image of doc.images) {
    if (usedImageIds.has(image.id)) continue;
    if (!ctx.selection.isImageSelected(image.id)) continue;
    const destination = ctx.selection.imageDestination(image.id);
    if (destination === 'unassigned') continue;
    if (done.has(`image:${image.id}`)) continue;

    const bytes = ctx.imageBytesById.get(image.id);
    if (!bytes) {
      runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
      continue;
    }
    const name = withPrefix(image.caption?.trim() || `${defaultImageName} ${pageRef(image.provenance.pageNumber)}`);
    try {
      // The grid is asked for BEFORE the upload: cancelling the grid window leaves this scene out (nothing uploaded,
      // nothing created, not marked as done, so "Import" again asks for it again) and the import goes on.
      const grid = destination === 'scene' ? await pickGridForImage(bytes, image) : null;
      if (destination === 'scene' && grid === null) {
        runDiagnostics.push({ severity: 'warning', code: 'REVIEW_SCENE_SKIPPED', params: { name }, pageNumber: image.provenance.pageNumber });
        continue;
      }
      const upload = { path: await uploadOnce(image.id, bytes, uploadBaseNameFor(image)) };
      if (destination === 'scene' && grid !== null) {
        const created = await createSceneFromImage({ name, imagePath: upload.path, width: image.width, height: image.height, grid, folder: sceneFolderId });
        entries.push({ label: name, uuid: created.uuid ?? undefined });
      } else if (destination === 'journal') {
        const created = await createJournalHandoutFromImage({ name, imagePath: upload.path, folder: journalFolderId });
        entries.push({ label: name, uuid: created.uuid ?? undefined });
      } else {
        // 'token' — saved to disk,
        // without creating a document. Originally, a label
        // without a path was INDISTINGUISHABLE from "nothing happened"
        // ("I can't see where the tokens are being saved") — we append
        // the real path returned by `FilePicker.upload()`, the only trace
        // of this save visible to the user (no document, hence no
        // `uuid`/link to open).
        entries.push({ label: `${name} — ${upload.path}` });
        // Recorded AFTER a successful upload — see the
        // comment next to `uploadedTokenImagePathById` above.
        uploadedTokenImagePathById.set(image.id, upload.path);
      }
      done.add(`image:${image.id}`);
    } catch (err) {
      runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_DESTINATION_FAILED', params: { name, destination, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
    }
  }

  if (!done.has('statblocks')) {
    await importStatblocks(ctx, entries, runDiagnostics, uploadOnce, uploadBaseNameFor);
    done.add('statblocks');
  }

  return { entries: [...entries], diagnostics: runDiagnostics };
}

/** Creates the Actors for the statblocks ticked in the Statblocks tab, with the pictures chosen there (uploaded here if the image import didn't already do it). */
async function importStatblocks(
  ctx: ReviewImportContext,
  entries: { label: string; uuid?: string }[],
  diagnostics: Diagnostic[],
  uploadOnce: (imageId: string, bytes: { bytes: Uint8Array; format: string }, uploadBaseName: string) => Promise<string>,
  uploadBaseNameFor: (image: CIFImage) => string,
): Promise<void> {
  const state = ctx.statblocks;
  if (!state || state.includedCount === 0) return;
  const i18n = game.i18n!;
  const resolveImagePath = async (imageId: string): Promise<string | undefined> => {
    const image = ctx.document.images.find((i) => i.id === imageId);
    const bytes = ctx.imageBytesById.get(imageId);
    if (!image || !bytes) return undefined;
    try {
      return await uploadOnce(imageId, bytes, uploadBaseNameFor(image));
    } catch (err) {
      diagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_DESTINATION_FAILED', params: { name: image.caption?.trim() || image.id, destination: 'statblock', error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
      return undefined;
    }
  };
  const report = await state.run(resolveImagePath);
  if (!report) return;
  const statusKey = { created: 'statusCreated', updated: 'statusUpdated', skipped: 'statusSkipped', error: 'statusError' } as const;
  for (const instance of report.instances) {
    entries.push({ label: `${i18n.localize(`BINDERY.statblockImport.${statusKey[instance.status]}`)}: ${instance.actorName}`, uuid: instance.actorUuid });
    diagnostics.push(...instance.diagnostics);
  }
}

/**
 * Opens `GridPicker` (built in step 8,
 * never called from anywhere until now — dead code) with a LIVE preview of
 * the SPECIFIC image, instead of giving every scene the same, ill-fitting
 * starting point. The user can confirm (the calibration is saved as
 * `lastGridConfig` — the starting slider position for the NEXT scene, so
 * as not to start from scratch on similar maps) or cancel — in which case
 * we use the LAST CONFIRMED calibration as a reasonable approximation (an
 * explicit user choice to "skip", not a silent imposition of someone
 * else's settings like in the original bug — see this file's history).
 */
async function pickGridForImage(bytes: { bytes: Uint8Array; format: string }, image: { width: number; height: number; suggestedGrid?: CIFImage['suggestedGrid'] }): Promise<GridConfig | null> {
  const mime = bytes.format === 'png' ? 'image/png' : 'image/webp';
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes.bytes)], { type: mime }));
  try {
    // The auto-detection suggestion is passed SOLELY when
    // confidence exceeds the "worth showing" threshold — below it, the
    // last manual calibration (`lastGridConfig`, see `GridPickerApp.pick`)
    // is a better starting point than guessing on a weak signal.
    const suggested = image.suggestedGrid;
    const suggestedGrid =
      suggested && suggested.confidence >= MIN_GRID_SUGGESTION_CONFIDENCE
        ? { size: suggested.size, offsetX: suggested.offsetX, offsetY: suggested.offsetY }
        : undefined;
    // `null` = the grid window was cancelled or closed: the caller leaves the scene out.
    return await pickGrid({ imageDataUrl: url, imageWidth: image.width, imageHeight: image.height, suggestedGrid });
  } finally {
    URL.revokeObjectURL(url);
  }
}
