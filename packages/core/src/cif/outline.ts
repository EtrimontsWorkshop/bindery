/**
 * Extraction and resolution of PDF bookmarks (Step 9 Z4, `doc.getOutline()`).
 * Empirically verified on ALL 9 files from `samples/`: 9/9 HAVE bookmarks
 * (depth 1-5), so the fallback (Z4b, without outline) has nothing to
 * self-check against on real files — tested only synthetically.
 *
 * The shape of `OutlineNode`/`getDestination`/`getPageIndex` — pdfjs-dist
 * `types/src/display/api.d.ts` (verified directly against the installed
 * version, not guessed): `dest` is `string | Array<any> | null` — string =
 * named destination (requires `getDestination()`), array = explicit
 * destination (the first element is a `RefProxy` ready for
 * `getPageIndex()`), null = none (e.g. an outline entry with no target,
 * just a grouping label).
 */

export interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

export interface PdfDocumentForOutline {
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

export interface ResolvedOutlineNode {
  title: string;
  /** 1-indexed page number; null = unresolvable target (e.g. an external link) — degrade, don't fail (A7). */
  pageNumber: number | null;
  /** 1 = topmost level (the top-level array of `getOutline()`). */
  depth: number;
  children: ResolvedOutlineNode[];
}

async function resolvePageNumber(dest: string | unknown[] | null, doc: PdfDocumentForOutline): Promise<number | null> {
  try {
    let resolved = dest;
    if (typeof resolved === 'string') resolved = await doc.getDestination(resolved);
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const pageIndex = await doc.getPageIndex(resolved[0]);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function resolveNode(node: PdfOutlineNode, depth: number, doc: PdfDocumentForOutline): Promise<ResolvedOutlineNode> {
  const pageNumber = await resolvePageNumber(node.dest, doc);
  const children = await Promise.all((node.items ?? []).map((child) => resolveNode(child, depth + 1, doc)));
  return { title: node.title, pageNumber, depth, children };
}

/** Returns [] when the PDF has no bookmarks (or `getOutline()` throws) — no outline is a valid, expected result (A7: degrade, don't fail). */
export async function extractOutline(doc: PdfDocumentForOutline): Promise<ResolvedOutlineNode[]> {
  let raw: PdfOutlineNode[] | null;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!raw || raw.length === 0) return [];
  return Promise.all(raw.map((n) => resolveNode(n, 1, doc)));
}

/** Flattens the tree into a flat list (DFS order, depth preserved per node). */
export function flattenOutline(nodes: readonly ResolvedOutlineNode[]): ResolvedOutlineNode[] {
  const flat: ResolvedOutlineNode[] = [];
  function walk(list: readonly ResolvedOutlineNode[]): void {
    for (const n of list) {
      flat.push(n);
      walk(n.children);
    }
  }
  walk(nodes);
  return flat;
}
