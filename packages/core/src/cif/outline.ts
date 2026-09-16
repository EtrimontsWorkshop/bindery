/**
 * Ekstrakcja i rozwiazywanie zakladek PDF (KROK-9 Z4, `doc.getOutline()`).
 * Empirycznie zweryfikowane na WSZYSTKICH 9 plikach z `samples/`: 9/9 MA
 * zakladki (glebokosc 1-5), wiec fallback (Z4b, bez outline) nie ma na czym
 * sie sam-sprawdzic na prawdziwych plikach — testowany wylacznie syntetycznie.
 *
 * Ksztalt `OutlineNode`/`getDestination`/`getPageIndex` — pdfjs-dist
 * `types/src/display/api.d.ts` (zweryfikowane wprost w zainstalowanej wersji,
 * nie zgadywane): `dest` to `string | Array<any> | null` — string = nazwana
 * destynacja (wymaga `getDestination()`), tablica = destynacja jawna (pierwszy
 * element to `RefProxy` gotowy dla `getPageIndex()`), null = brak (np. wpis
 * outline bez celu, tylko etykieta grupujaca).
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
  /** 1-indeksowany numer strony; null = nierozwiazywalny cel (np. link zewnetrzny) — degraduj, nie failuj (A7). */
  pageNumber: number | null;
  /** 1 = najwyzszy poziom (tablica najwyzsza `getOutline()`). */
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

/** Zwraca [] gdy PDF nie ma zakladek (albo `getOutline()` rzuci) — brak outline to poprawny, oczekiwany wynik (A7: degraduj, nie failuj). */
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

/** Splaszcza drzewo do listy plaskiej (kolejnosc DFS, glebokosc zachowana per-wezel). */
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
