import type { Rect } from '../geometry.js';
import type { SemanticBlock } from '../semantic/blockBuilder.js';

/**
 * Converts `SemanticBlock[]` (already in reading order) into the HTML of a
 * journal page (Step 9 Z5, MDD phase 8). The mapping table comes directly
 * from the `KROK-9-journale.md` brief. Sanitization is MANDATORY — here the
 * content is driven ONLY by structure (which tags), and ALL text
 * (originating from the user's file) is escaped before insertion — we never
 * parse or pass through any raw external HTML, so a full sanitizer (e.g.
 * DOMPurify, which requires DOM/jsdom) is unnecessary: we construct EVERY
 * tag ourselves, text is ALWAYS only content, never structure.
 */

/** Escapes special HTML characters — the only line of defense, because the ENTIRE tag structure is our own, never from user input. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface EmbeddedImageForHtml {
  /** `CIFImage.id`. */
  id: string;
  /** Image path/URL for the `src` attribute — a placeholder filled in only after upload (Foundry layer), here it is only inserted, never interpreted. */
  assetRef: string;
  pageNumber: number;
  bbox: Rect;
  caption?: string;
}

function joinLines(text: string): string {
  return text.replace(/\n/g, ' ').trim();
}

/**
 * [Step 9, live check in Foundry; confirmed/kept in Step 11] Below this
 * length (characters, after trimming) a `heading` block does NOT get its
 * own <h#> — it is rendered as a plain <p>. A PARTIAL safeguard: it catches
 * single/double characters ("m", "mn", "h").
 *
 * [Step 11, Z1] Longer merges (e.g. Za_lini_wroga p. 24/68 "Operation
 * Vanguard"+"Difficulty level...", Wrath & Glory "erosion of rebellion")
 * NOW have a real, dedicated fix source — `layout/lineEdgeSplit.ts` (Z1),
 * which splits a line with a label at the EDGE (start or end) — so this
 * length threshold is NO LONGER the only line of defense for this class of
 * bug. NOT lowered/removed: a check on `Cienie_posrod_mgie.pdf` p. 20
 * ("HOUSE OF HAMMERS", "PERFECT SUPPLIERS") showed that some of these
 * merges have a DEEPER cause that Z1 deliberately does not touch (a label
 * in the TRUE MIDDLE of the `runs` array, surrounded by the same font
 * family on both sides — the result of several physical lines/columns
 * being merged into one by an earlier clustering stage, not a simple edge
 * case) — see the comment in `lineEdgeSplit.ts` and RAPORT-KROK-11.md. Until
 * THIS class of bug has its own fix at the source, the length threshold
 * remains as a safety net. A deliberate, partial compromise (risk: a real
 * very short title, e.g. "I" or "A", will also land in a plain paragraph)
 * — accepted by the user after a live check in Foundry (Step 9), confirmed
 * again in Step 11.
 */
const MIN_HEADING_TEXT_LENGTH = 3;

function figureHtml(img: EmbeddedImageForHtml): string {
  const caption = img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '';
  return `<figure><img src="${escapeHtml(img.assetRef)}" alt="">${caption}</figure>`;
}

/** One block -> one HTML fragment, per the mapping table from the brief. `header`/`footer` are handled BEFORE the call (skipped in the content) — this function does not expect them. */
function blockToHtmlFragment(b: SemanticBlock): string {
  switch (b.kind) {
    case 'heading': {
      const text = joinLines(b.rawText);
      if (text.length < MIN_HEADING_TEXT_LENGTH) return `<p>${escapeHtml(text)}</p>`;
      const level = Math.min(6, Math.max(1, b.headingLevel ?? 2));
      return `<h${level}>${escapeHtml(text)}</h${level}>`;
    }
    case 'body':
      return `<p>${escapeHtml(joinLines(b.rawText))}</p>`;
    case 'sidebar':
      return `<aside class="bindery-sidebar">${escapeHtml(joinLines(b.rawText))}</aside>`;
    case 'caption':
      return `<figcaption>${escapeHtml(joinLines(b.rawText))}</figcaption>`;
    case 'table':
      // Rough reconstruction — one row per source line, without reconstructing cells (brief: out of scope).
      return `<table><tbody>${b.lines.map((l) => `<tr><td>${escapeHtml(l.text)}</td></tr>`).join('')}</tbody></table>`;
    case 'marginalia':
      return `<p>${escapeHtml(joinLines(b.rawText))}</p>`; // wrapped in a combined <aside> by the caller (see blocksToHtml)
    case 'statblock':
    case 'unknown':
    default:
      // `statblock` is out of MVP scope (v2.0, Step 9 brief "what NOT to do"),
      // `unknown` is what survived all the rules (Z1a) — both get a safe
      // fallback instead of disappearing (A3: nothing is lost, even
      // unrecognized content ends up in the content).
      return `<p class="bindery-${b.kind}">${escapeHtml(joinLines(b.rawText))}</p>`;
  }
}

/**
 * Builds the HTML of a single journal page from its blocks (already in
 * reading order, may span MULTIPLE physical PDF pages —
 * `JournalPageDraft.blocks` from `buildJournalHierarchy.ts`) + images to
 * embed. An image between two blocks in reading order (same PDF page, Y
 * position) lands BETWEEN their corresponding fragments (brief: "requires
 * this explicitly"). `header`/`footer` are skipped in the content (but
 * their `rawText` survives separately in `CIFJournalPage.rawText`, built by
 * the caller from the FULL list of blocks — A3). `marginalia` is collected
 * into a single `<aside>` at the END of the page (brief: "not woven into
 * the flow").
 */
export function blocksToHtml(blocks: readonly SemanticBlock[], images: readonly EmbeddedImageForHtml[]): { html: string; imageRefs: string[] } {
  const imagesByPage = new Map<number, EmbeddedImageForHtml[]>();
  for (const img of images) {
    const arr = imagesByPage.get(img.pageNumber) ?? [];
    arr.push(img);
    imagesByPage.set(img.pageNumber, arr);
  }

  // Blocks are already sorted page-ascending + reading order within a page
  // (`buildPageLayouts`) — we group them into runs BY PAGE while preserving
  // this order, so each page is paired with its OWN images.
  const pageGroups: { pageNumber: number; blocks: SemanticBlock[] }[] = [];
  for (const b of blocks) {
    const last = pageGroups[pageGroups.length - 1];
    if (last && last.pageNumber === b.pageNumber) last.blocks.push(b);
    else pageGroups.push({ pageNumber: b.pageNumber, blocks: [b] });
  }

  const parts: string[] = [];
  const marginaliaParts: string[] = [];
  const imageRefs: string[] = [];
  const usedImageIds = new Set<string>();

  type Entry = { y: number; kind: 'block'; block: SemanticBlock } | { y: number; kind: 'image'; image: EmbeddedImageForHtml };

  for (const group of pageGroups) {
    const pageImages = (imagesByPage.get(group.pageNumber) ?? []).filter((img) => !usedImageIds.has(img.id));
    const entries: Entry[] = [
      ...group.blocks.map((b): Entry => ({ y: b.bbox.maxY, kind: 'block', block: b })),
      ...pageImages.map((img): Entry => ({ y: img.bbox.maxY, kind: 'image', image: img })),
    ];
    // Y decreases going down the page in PDF layout — reading order (top->bottom) means decreasing Y.
    entries.sort((a, b) => b.y - a.y);

    for (const entry of entries) {
      if (entry.kind === 'image') {
        usedImageIds.add(entry.image.id);
        imageRefs.push(entry.image.id);
        parts.push(figureHtml(entry.image));
        continue;
      }
      const b = entry.block;
      if (b.kind === 'header' || b.kind === 'footer') continue; // skipped in the content (rawText preserved separately)
      if (b.kind === 'marginalia') {
        marginaliaParts.push(blockToHtmlFragment(b));
        continue;
      }
      parts.push(blockToHtmlFragment(b));
    }
  }

  // Images without ANY text block on the same page (e.g. a purely
  // graphical page) go at the end — we don't lose them entirely (A3).
  for (const img of images) {
    if (usedImageIds.has(img.id)) continue;
    usedImageIds.add(img.id);
    imageRefs.push(img.id);
    parts.push(figureHtml(img));
  }

  if (marginaliaParts.length > 0) {
    parts.push(`<aside class="bindery-marginalia">${marginaliaParts.join('')}</aside>`);
  }

  return { html: parts.join('\n'), imageRefs };
}
