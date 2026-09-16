/**
 * [KROK-11 Z6] Znajdz-lub-utworz `Folder` po nazwie — ekran celu pozwala
 * wpisac nazwe folderu (nie wybrac z drzewa, MVP), wiec musimy sami
 * rozstrzygnac "juz istnieje" vs "trzeba utworzyc". Pusta nazwa = korzen
 * (brak folderu), zwraca `undefined`.
 */
export async function ensureFolder(name: string, type: 'JournalEntry' | 'Scene' | 'Actor'): Promise<string | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  const existing = (game.folders as unknown as { find(pred: (f: { name: string; type: string; id: string }) => boolean): { id: string } | undefined })?.find(
    (f) => f.name === trimmed && f.type === type,
  );
  if (existing) return existing.id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const FolderCls = (foundry.documents as any).Folder ?? (globalThis as any).Folder;
  const created = await FolderCls.create({ name: trimmed, type, parent: null });
  if (!created) throw new Error(`Bindery | nie udalo sie utworzyc folderu "${trimmed}"`);
  return created.id;
}
