/**
 * [Step 19, gap reported live] Creates ONE `JournalEntry` with MULTIPLE
 * `image`-type pages — one page per image, in the given order. The
 * counterpart to `createJournalHandoutFromImage.ts` (single image = one
 * journal), but for a user who wants manual grouping ("select 5 and assign
 * them to one journal") — e.g. handouts sorted by book chapter, at the GM's
 * discretion. The grouping mechanism itself (which image goes to which
 * group) lives in `ReviewSelection` (pure presentation, no decision logic
 * here — A1/check:boundary); this function ONLY creates a document from an
 * already-prepared page list.
 */
export interface JournalHandoutImagePage {
  name: string;
  imagePath: string;
}

export interface CreateJournalHandoutFromImagesInput {
  name: string;
  pages: readonly JournalHandoutImagePage[];
  /** [Step 11 Z6] `JournalEntry` folder id (see `ensureFolder.ts`) — `undefined` = root. */
  folder?: string;
}

export async function createJournalHandoutFromImages(input: CreateJournalHandoutFromImagesInput): Promise<foundry.documents.BaseJournalEntry> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const JournalEntryCls = (foundry.documents as any).JournalEntry ?? (globalThis as any).JournalEntry;

  const pagesData = input.pages.map((page) => ({
    name: page.name,
    type: 'image',
    src: page.imagePath,
    title: { show: false },
  }));

  const entry = await JournalEntryCls.create({ name: input.name, pages: pagesData, folder: input.folder });
  return entry;
}
