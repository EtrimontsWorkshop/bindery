/**
 * [Step 11 Z6] Find-or-create a `Folder` by name — the target screen lets
 * the user type a folder name (not pick from a tree, MVP), so we have to
 * resolve "already exists" vs. "needs to be created" ourselves. An empty
 * name = root (no folder), returns `undefined`.
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
  if (!created) throw new Error(`Bindery | failed to create folder "${trimmed}"`);
  return created.id;
}
