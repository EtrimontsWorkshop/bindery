/**
 * [KROK-14 Z4] Tworzy JEDNOSTRONICOWY `JournalEntry` z pojedynczym obrazem
 * jako handout — sciezka `destination: 'journal'` z ekranu przegladu (faza 9),
 * dla obrazow, ktore NIE sa juz osadzone w zadnej stronie journala z fazy 8
 * (te obsluguje `createJournalFromCIF.ts`). Celowo NIE reuzywa
 * `createJournalsFromCIF` — ten potok oczekuje juz-zbudowanego HTML strony z
 * `blocksToHtml.ts`, tutaj wejsciem jest goly obraz bez tekstu towarzyszacego.
 */
export interface CreateJournalHandoutFromImageInput {
  name: string;
  imagePath: string;
  /** [KROK-11 Z6] Id folderu `JournalEntry` (patrz `ensureFolder.ts`) — `undefined` = korzen. */
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
