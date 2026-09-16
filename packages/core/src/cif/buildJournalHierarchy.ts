import type { SemanticBlock } from '../semantic/blockBuilder.js';
import { flattenOutline, type ResolvedOutlineNode } from './outline.js';

/**
 * Hierarchia journali z zakladek PDF + fallback po naglowkach (KROK-9 Z4).
 *
 * [decyzja architektoniczna] Foundry v14 `JournalEntry` ma WYLACZNIE plaska
 * kolekcje `pages` (`common/documents/journal-entry.mjs`: `pages: new
 * fields.EmbeddedCollectionField(...)`) — ZERO zagniezdzania JournalEntry w
 * JournalEntry. Zakladki PDF czesto maja glebokosc >2 (zmierzone na
 * `samples/`: Za_lini_wroga.pdf ma glebokosc 5!). Mapowanie: NAJPLYTSZY
 * poziom obecny w znacznikach -> `JournalEntry`, kolejny poziom -> `JournalEntryPage`,
 * WSZYSTKO glebsze NIE tworzy kolejnej struktury — zostaje zwyklym blokiem
 * `heading` w tresci strony (Z5 nada mu <h3>/<h4>/... wedlug wlasnego poziomu),
 * dokladnie jak prawdziwy, drukowany podrecznik: rozdzial -> sekcja -> zwykly
 * srodtytul w tekscie.
 */

export interface SectionMarker {
  title: string;
  /** 1 = najplytszy poziom obecny w tym zestawie znacznikow. */
  level: number;
  /** Indeks (w PLASKIEJ, juz uporzadkowanej liscie blokow calego dokumentu) pierwszego bloku nalezacego do tej sekcji. */
  startBlockIndex: number;
}

export interface JournalPageDraft {
  title: string;
  headingLevel: number;
  blocks: SemanticBlock[];
}

export interface JournalDraft {
  title: string;
  pages: JournalPageDraft[];
}

/**
 * [KROK-9 Z4] Znaczniki z drzewa zakladek — kazdy rozwiazany wezel (majacy
 * `pageNumber`) mapowany na indeks PIERWSZEGO bloku na tej stronie lub dalej
 * (>=, bo strona docelowa moze nie miec zadnych blokow tekstu — np. sama mapa/
 * okladka — wtedy sekcja zaczyna sie od nastepnego dostepnego bloku, degradacja
 * A7, nie blad). Wezly nierozwiazywalne (`pageNumber === null`, np. link
 * zewnetrzny) sa POMIJANE, nie failuja calego importu.
 */
export function outlineToMarkers(nodes: readonly ResolvedOutlineNode[], blocks: readonly SemanticBlock[]): SectionMarker[] {
  const resolved = flattenOutline(nodes).filter((n): n is ResolvedOutlineNode & { pageNumber: number } => n.pageNumber !== null);
  const withIndex = resolved.map((n) => {
    let idx = blocks.findIndex((b) => b.pageNumber >= n.pageNumber);
    if (idx === -1) idx = blocks.length;
    return { title: n.title, level: n.depth, startBlockIndex: idx };
  });
  return withIndex.sort((a, b) => a.startBlockIndex - b.startBlockIndex);
}

/** Poziom naglowka z rankingu rozmiaru fontu dominujacego DANEGO bloku wsrod WSZYSTKICH blokow `heading` calego dokumentu — im wiekszy font, tym nizszy (bardziej "gorny") poziom. Brak `SemanticBlock.headingLevel` faktycznie wypelnionego gdziekolwiek indziej w kodzie (zweryfikowane grepem) — musi byc obliczone tutaj. */
export function assignHeadingLevels(blocks: readonly SemanticBlock[]): Map<string, number> {
  const headingBlocks = blocks.filter((b) => b.kind === 'heading');
  const sizes = new Set<number>();
  for (const b of headingBlocks) sizes.add(b.lines[0]?.dominantFont.size ?? 0);
  const sortedDesc = [...sizes].sort((a, b) => b - a);
  const levelBySize = new Map<number, number>();
  sortedDesc.forEach((size, i) => levelBySize.set(size, Math.min(i + 1, 6)));
  const result = new Map<string, number>();
  for (const b of headingBlocks) {
    result.set(b.id, levelBySize.get(b.lines[0]?.dominantFont.size ?? 0) ?? 6);
  }
  return result;
}

/** Fallback (brak outline, Z4b): znaczniki z blokow `heading` samych, poziom z rankingu rozmiaru fontu. */
export function headingsToMarkers(blocks: readonly SemanticBlock[]): SectionMarker[] {
  const levelByBlockId = assignHeadingLevels(blocks);
  const markers: SectionMarker[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading') return;
    markers.push({
      title: b.rawText.trim() || `Sekcja ${markers.length + 1}`,
      level: levelByBlockId.get(b.id) ?? 1,
      startBlockIndex: i,
    });
  });
  return markers;
}

/**
 * Buduje drzewo journal/strona z plaskiej listy blokow + znacznikow (z outline
 * LUB z fallbacku — ten sam mechanizm dla obu, patrz `outlineToMarkers`/
 * `headingsToMarkers`). Brak znacznikow w ogole -> caly dokument to JEDEN
 * journal z JEDNA strona (fallback ostateczny, brief: "fallback musi dzialac").
 */
export function buildJournalDrafts(blocks: readonly SemanticBlock[], markers: readonly SectionMarker[], fallbackTitle: string): JournalDraft[] {
  if (blocks.length === 0) return [];
  if (markers.length === 0) {
    return [{ title: fallbackTitle, pages: [{ title: fallbackTitle, headingLevel: 1, blocks: [...blocks] }] }];
  }

  const minLevel = Math.min(...markers.map((m) => m.level));
  const journalMarkers = markers.filter((m) => m.level === minLevel);
  const pageLevel = minLevel + 1;

  // Blokow PRZED pierwszym journal-markerem (np. strona tytulowa bez wlasnej
  // zakladki) NIE gubimy (A3) — trafiaja do syntetycznego journala na poczatku.
  const firstJournalStart = journalMarkers[0]!.startBlockIndex;
  const drafts: JournalDraft[] = [];
  if (firstJournalStart > 0) {
    drafts.push(buildOneJournal(fallbackTitle, blocks, 0, firstJournalStart, markers, pageLevel));
  }

  for (let i = 0; i < journalMarkers.length; i++) {
    const start = journalMarkers[i]!.startBlockIndex;
    const end = journalMarkers[i + 1]?.startBlockIndex ?? blocks.length;
    drafts.push(buildOneJournal(journalMarkers[i]!.title, blocks, start, end, markers, pageLevel));
  }
  return drafts;
}

function buildOneJournal(
  title: string,
  allBlocks: readonly SemanticBlock[],
  rangeStart: number,
  rangeEnd: number,
  allMarkers: readonly SectionMarker[],
  pageLevel: number,
): JournalDraft {
  const pageMarkers = allMarkers.filter((m) => m.level === pageLevel && m.startBlockIndex >= rangeStart && m.startBlockIndex < rangeEnd);

  // Brak podziomu (np. outline plaski, glebokosc 1) -> caly journal to JEDNA strona.
  if (pageMarkers.length === 0) {
    const pages = [{ title, headingLevel: 1, blocks: allBlocks.slice(rangeStart, rangeEnd) }].filter((p) => p.blocks.length > 0);
    return { title, pages };
  }

  const pages: JournalPageDraft[] = [];
  for (let i = 0; i < pageMarkers.length; i++) {
    // Blok znacznika JOURNALA samego (np. tytul "Czesc I") i ewentualna tresc
    // MIEDZY nim a pierwszym znacznikiem strony NIE dostaja wlasnej, osobnej
    // (czesto niemal pustej) strony — doklejane do PIERWSZEJ prawdziwej strony
    // (i===0 zaczyna od `rangeStart`, nie od wlasnego indeksu markera).
    const start = i === 0 ? rangeStart : pageMarkers[i]!.startBlockIndex;
    const end = pageMarkers[i + 1]?.startBlockIndex ?? rangeEnd;
    pages.push({ title: pageMarkers[i]!.title, headingLevel: 2, blocks: allBlocks.slice(start, end) });
  }
  return { title, pages: pages.filter((p) => p.blocks.length > 0) };
}
