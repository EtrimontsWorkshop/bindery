import { uploadImage } from './uploadImages.js';

/**
 * Journale z CIF (KROK-9 Z4/Z5, faza 8 MDD). Wejscie jest juz gotowym
 * `CIFDocument` (hierarchia + HTML zbudowane w `packages/core`, zero logiki
 * decyzyjnej tutaj — A1/`check:boundary`): ten modul WYLACZNIE (1) wgrywa
 * obrazy embedowane w tresci i (2) podmienia placeholder `assetRef` (=
 * `CIFImage.id`, patrz `buildCIFDocument.ts`) na prawdziwa sciezke Foundry w
 * atrybucie `src`, po czym tworzy `JournalEntry`+`JournalEntryPage`.
 *
 * [KROK-9, kształt JournalEntryPage v14 zweryfikowany w zrodlach PRZED
 * napisaniem tego kodu, zgodnie z ostrzezeniem briefu] `common/documents/
 * journal-entry-page.mjs`: schemat PLASKI (`text.content` HTMLField,
 * `title.level` 1-6, `format` domyslnie `JOURNAL_ENTRY_PAGE_FORMATS.HTML`) —
 * ZERO shimow/embedded-dokumentow-pulapek analogicznych do `Scene#background`
 * (KROK-8). `JournalEntry.pages` to zwykle `EmbeddedCollectionField` — dane
 * stron mozna przekazac WPROST w `JournalEntry.create({pages: [...]})`, bez
 * osobnego `createEmbeddedDocuments` ani ryzyka "domyslnego pustego wpisu"
 * (to byl specyficzny dla `Scene`/`Level` przypadek, nie ogolny wzorzec Foundry).
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
  /** `CIFImage.id` -> bajty juz zakodowane (z `buildCIFDocument`'s `imageBytesById`). */
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  /** Uzywane do nazw plikow wgrywanych obrazow — zwykle nazwa zrodlowego PDF-a bez rozszerzenia. */
  baseName: string;
  /** [KROK-11 Z6] Id folderu `JournalEntry` (patrz `ensureFolder.ts`) — `undefined` = korzen. */
  folder?: string;
}

export interface CreatedJournalRef {
  id: string;
  uuid: string;
  name: string;
}

export interface CreateJournalsFromCIFResult {
  journalIds: string[];
  /** [KROK-11 Z6] Utworzone journale z pelnym `uuid` — do linkowania z podsumowania po imporcie. */
  createdJournals: CreatedJournalRef[];
  /** Obrazy, ktorych bajtow nie znaleziono w `imageBytesById` (nie powinno sie zdarzyc — diagnostyka). */
  missingImageIds: string[];
}

/** Wgrywa WSZYSTKIE obrazy embedowane w journalach, zwraca `CIFImage.id` -> prawdziwa sciezka Foundry. */
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

/** Podmienia `src="<CIFImage.id>"` (placeholder, patrz naglowek pliku) na prawdziwa sciezke — dopasowanie po DOKLADNYM atrybucie, nie po samym id, zeby nie trafic przypadkiem w tekst tresci. */
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
      throw new Error(`Bindery | nie udalo sie utworzyc journala "${journal.name}"`);
    }
    journalIds.push(entry.id);
    createdJournals.push({ id: entry.id, uuid: entry.uuid, name: journal.name });
  }

  return { journalIds, createdJournals, missingImageIds };
}
