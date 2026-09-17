/**
 * [Step 14 Z4] Creates a SINGLE-PAGE `JournalEntry` with a single image as a
 * handout — the `destination: 'journal'` path from the review screen (phase
 * 9), for images that are NOT already embedded in any phase-8 journal page
 * (those are handled by `createJournalFromCIF.ts`). Deliberately does NOT
 * reuse `createJournalsFromCIF` — that pipeline expects already-built page
 * HTML from `blocksToHtml.ts`, whereas here the input is a bare image with
 * no accompanying text.
 */
export interface CreateJournalHandoutFromImageInput {
  name: string;
  imagePath: string;
  /** [Step 11 Z6] `JournalEntry` folder id (see `ensureFolder.ts`) — `undefined` = root. */
  folder?: string;
}

export async function createJournalHandoutFromImage(input: CreateJournalHandoutFromImageInput): Promise<foundry.documents.BaseJournalEntry> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const JournalEntryCls = (foundry.documents as any).JournalEntry ?? (globalThis as any).JournalEntry;

  const pageData = {
    name: input.name,
    type: 'image',
    src: input.imagePath,
    title: { show: false },
  };

  const entry = await JournalEntryCls.create({ name: input.name, pages: [pageData], folder: input.folder });
  return entry;
}
