/**
 * [KROK-19, zgloszony na zywo brak] Tworzy JEDEN `JournalEntry` z WIELOMA
 * stronami typu `image` — jedna strona na obraz, w podanej kolejnosci.
 * Odpowiednik `createJournalHandoutFromImage.ts` (pojedynczy obraz = jeden
 * journal), ale dla uzytkownika, ktory chce reczne grupowanie ("zaznaczasz 5
 * i przypisujesz do jednego journala") — np. handouty posegregowane
 * rozdzialami ksiazki, wedlug uznania MG. Sam mechanizm grupowania (jaki
 * obraz do jakiej grupy) zyje w `ReviewSelection` (czysta prezentacja, brak
 * logiki decyzyjnej tutaj — A1/check:boundary); ta funkcja WYLACZNIE tworzy
 * dokument z juz-gotowej listy stron.
 */
export interface JournalHandoutImagePage {
  name: string;
  imagePath: string;
}

export interface CreateJournalHandoutFromImagesInput {
  name: string;
  pages: readonly JournalHandoutImagePage[];
  /** [KROK-11 Z6] Id folderu `JournalEntry` (patrz `ensureFolder.ts`) — `undefined` = korzen. */
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
