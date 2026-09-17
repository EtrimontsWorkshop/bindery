import { uploadImage } from './uploadImages.js';

/**
 * Journals from CIF (Step 9 Z4/Z5, MDD phase 8). The input is an
 * already-built `CIFDocument` (hierarchy + HTML built in `packages/core`,
 * zero decision logic here — A1/`check:boundary`): this module ONLY (1)
 * uploads images embedded in the content and (2) replaces the `assetRef`
 * placeholder (= `CIFImage.id`, see `buildCIFDocument.ts`) with the real
 * Foundry path in the `src` attribute, then creates a
 * `JournalEntry`+`JournalEntryPage`.
 *
 * [Step 9, the v14 JournalEntryPage shape was verified in the source BEFORE
 * writing this code, per the brief's warning] `common/documents/
 * journal-entry-page.mjs`: a FLAT schema (`text.content` HTMLField,
 * `title.level` 1-6, `format` defaulting to `JOURNAL_ENTRY_PAGE_FORMATS.HTML`)
 * — ZERO shims/embedded-document traps analogous to `Scene#background`
 * (Step 8). `JournalEntry.pages` is a plain `EmbeddedCollectionField` — page
 * data can be passed DIRECTLY in `JournalEntry.create({pages: [...]})`,
 * without a separate `createEmbeddedDocuments` or the risk of a "default
 * empty entry" (that was a case specific to `Scene`/`Level`, not a general
 * Foundry pattern).
 */

export interface CIFImageForUpload {
  id: string;
  format: string;
}

export interface CIFJournalPageForCreation {
  name: string;
  headingLevel: number;
  html: string;
}

export interface CIFJournalForCreation {
  name: string;
  pages: CIFJournalPageForCreation[];
}

export interface CreateJournalsFromCIFInput {
  journals: readonly CIFJournalForCreation[];
  images: readonly CIFImageForUpload[];
  /** `CIFImage.id` -> already-encoded bytes (from `buildCIFDocument`'s `imageBytesById`). */
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  /** Used for the file names of uploaded images — usually the source PDF's name without extension. */
  baseName: string;
  /** [Step 11 Z6] `JournalEntry` folder id (see `ensureFolder.ts`) — `undefined` = root. */
  folder?: string;
}

export interface CreatedJournalRef {
  id: string;
  uuid: string;
  name: string;
}

export interface CreateJournalsFromCIFResult {
  journalIds: string[];
  /** [Step 11 Z6] Created journals with their full `uuid` — for linking from the post-import summary. */
  createdJournals: CreatedJournalRef[];
  /** Images whose bytes weren't found in `imageBytesById` (shouldn't happen — diagnostics). */
  missingImageIds: string[];
}

/** Uploads ALL images embedded in journals, returns `CIFImage.id` -> real Foundry path. */
async function uploadAllImages(
  images: readonly CIFImageForUpload[],
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>,
  baseName: string,
): Promise<{ pathById: Map<string, string>; missingImageIds: string[] }> {
  const pathById = new Map<string, string>();
  const missingImageIds: string[] = [];
  for (const img of images) {
    const entry = imageBytesById.get(img.id);
    if (!entry) {
      missingImageIds.push(img.id);
      continue;
    }
    const format = entry.format === 'png' ? 'png' : 'webp';
    const upload = await uploadImage({ bytes: entry.bytes, baseName: `${baseName}-${img.id}`, format });
    pathById.set(img.id, upload.path);
  }
  return { pathById, missingImageIds };
}

/** Replaces `src="<CIFImage.id>"` (placeholder, see the file header) with the real path — matched by the EXACT attribute, not just the id, so it doesn't accidentally match text in the content. */
function substituteImagePaths(html: string, pathById: ReadonlyMap<string, string>): string {
  let result = html;
  for (const [id, path] of pathById) {
    result = result.split(`src="${id}"`).join(`src="${path}"`);
  }
  return result;
}

export async function createJournalsFromCIF(input: CreateJournalsFromCIFInput): Promise<CreateJournalsFromCIFResult> {
  const { pathById, missingImageIds } = await uploadAllImages(input.images, input.imageBytesById, input.baseName);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const JournalEntryCls = (foundry.documents as any).JournalEntry ?? (globalThis as any).JournalEntry;

  const journalIds: string[] = [];
  const createdJournals: CreatedJournalRef[] = [];
  for (const journal of input.journals) {
    const pagesData = journal.pages.map((page) => ({
      name: page.name,
      type: 'text',
      title: { show: true, level: Math.min(6, Math.max(1, page.headingLevel)) },
      text: { content: substituteImagePaths(page.html, pathById) },
    }));
    const entry = await JournalEntryCls.create({ name: journal.name, pages: pagesData, folder: input.folder });
    if (!entry) {
      throw new Error(`Bindery | failed to create journal "${journal.name}"`);
    }
    journalIds.push(entry.id);
    createdJournals.push({ id: entry.id, uuid: entry.uuid, name: journal.name });
  }

  return { journalIds, createdJournals, missingImageIds };
}
