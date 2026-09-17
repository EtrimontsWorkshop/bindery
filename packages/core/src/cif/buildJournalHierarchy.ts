import type { SemanticBlock } from '../semantic/blockBuilder.js';
import { flattenOutline, type ResolvedOutlineNode } from './outline.js';

/**
 * Journal hierarchy from PDF bookmarks + heading-based fallback (Step 9 Z4).
 *
 * [architectural decision] Foundry v14's `JournalEntry` has ONLY a flat
 * `pages` collection (`common/documents/journal-entry.mjs`: `pages: new
 * fields.EmbeddedCollectionField(...)`) — ZERO nesting of JournalEntry
 * inside JournalEntry. PDF bookmarks often have depth >2 (measured on
 * `samples/`: Za_lini_wroga.pdf has depth 5!). Mapping: the SHALLOWEST
 * level present in the markers -> `JournalEntry`, the next level ->
 * `JournalEntryPage`, EVERYTHING deeper does NOT create another structure —
 * it stays as a plain `heading` block in the page content (Z5 assigns it
 * <h3>/<h4>/... based on its own level), exactly like a real, printed
 * manual: chapter -> section -> plain subheading in the text.
 */

export interface SectionMarker {
  title: string;
  /** 1 = the shallowest level present in this set of markers. */
  level: number;
  /** Index (in the FLAT, already-ordered list of blocks of the whole document) of the first block belonging to this section. */
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
 * [Step 9 Z4] Markers from the bookmark tree — each resolved node (having a
 * `pageNumber`) is mapped to the index of the FIRST block on that page or
 * later (>=, because the target page may have no text blocks at all — e.g.
 * a pure map/cover page — in which case the section starts at the next
 * available block, an A7 degradation, not an error). Unresolvable nodes
 * (`pageNumber === null`, e.g. an external link) are SKIPPED, they do not
 * fail the whole import.
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

/** Heading level from the ranking of the dominant font size of a GIVEN block among ALL `heading` blocks of the whole document — the larger the font, the lower (more "top-level") the level. `SemanticBlock.headingLevel` is not actually populated anywhere else in the code (verified by grep) — it must be computed here. */
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

/** Fallback (no outline, Z4b): markers from `heading` blocks alone, level from the font-size ranking. */
export function headingsToMarkers(blocks: readonly SemanticBlock[]): SectionMarker[] {
  const levelByBlockId = assignHeadingLevels(blocks);
  const markers: SectionMarker[] = [];
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading') return;
    markers.push({
      title: b.rawText.trim() || `Section ${markers.length + 1}`,
      level: levelByBlockId.get(b.id) ?? 1,
      startBlockIndex: i,
    });
  });
  return markers;
}

/**
 * Builds the journal/page tree from the flat list of blocks + markers
 * (from the outline OR from the fallback — the same mechanism for both,
 * see `outlineToMarkers`/`headingsToMarkers`). No markers at all -> the
 * whole document is ONE journal with ONE page (final fallback, brief:
 * "the fallback must work").
 */
export function buildJournalDrafts(blocks: readonly SemanticBlock[], markers: readonly SectionMarker[], fallbackTitle: string): JournalDraft[] {
  if (blocks.length === 0) return [];
  if (markers.length === 0) {
    return [{ title: fallbackTitle, pages: [{ title: fallbackTitle, headingLevel: 1, blocks: [...blocks] }] }];
  }

  const minLevel = Math.min(...markers.map((m) => m.level));
  const journalMarkers = markers.filter((m) => m.level === minLevel);
  const pageLevel = minLevel + 1;

  // Blocks BEFORE the first journal marker (e.g. a title page without its
  // own bookmark) are NOT lost (A3) — they go into a synthetic journal at the start.
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

  // No sub-level (e.g. flat outline, depth 1) -> the whole journal is ONE page.
  if (pageMarkers.length === 0) {
    const pages = [{ title, headingLevel: 1, blocks: allBlocks.slice(rangeStart, rangeEnd) }].filter((p) => p.blocks.length > 0);
    return { title, pages };
  }

  const pages: JournalPageDraft[] = [];
  for (let i = 0; i < pageMarkers.length; i++) {
    // The block of the JOURNAL marker itself (e.g. title "Part I") and any
    // content BETWEEN it and the first page marker do NOT get their own,
    // separate (often nearly empty) page — they are appended to the FIRST
    // real page (i===0 starts at `rangeStart`, not at its own marker index).
    const start = i === 0 ? rangeStart : pageMarkers[i]!.startBlockIndex;
    const end = pageMarkers[i + 1]?.startBlockIndex ?? rangeEnd;
    pages.push({ title: pageMarkers[i]!.title, headingLevel: 2, blocks: allBlocks.slice(start, end) });
  }
  return { title, pages: pages.filter((p) => p.blocks.length > 0) };
}
