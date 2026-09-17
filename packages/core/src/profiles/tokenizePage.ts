import { resolveFontKey } from '../inventory/fontRegistry.js';
import type { FontRole } from '../inventory/fontRegistry.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { splitMergedLabelValueTokens, stripStrayLeadingColonTokens } from './inferPatternFromSelection.js';
import type { ProfileToken } from './types.js';

/**
 * [Step 22] Extracted from `buildActorsForDocument.ts` (there it was a private
 * `tokensForPage`) — Profile Studio (`analyzeProfileDocument.ts`) needs
 * EXACTLY the same tokenization, so diagnostics see the same tokens
 * as the real statblock pipeline, not its own, potentially diverging
 * copy. Duck-typed `PdfPageLike` — the same pattern as
 * `buildActorsForDocument.ts`/`inventory/inventory.ts`.
 *
 * [Step 29, considered and REJECTED, fixed in Step 30 Z5] Merging words
 * split by pdf.js at a diacritic-character boundary (p. 23 "Zew Cthulhu
 * 7ed. Wrak.pdf": a statblock heading's personal name got a name candidate
 * of just its bare ASCII initial, instead of the full name, because the
 * accented remainder landed in a separate token). The first attempt (step
 * 29, `mergeTouchingTokens` from
 * `inferPatternFromSelection.ts`, called globally) caught a REGRESSION in the
 * synthetic `buildActorsForDocument.test.ts`: a short numeric value (length <=2
 * characters, a short fragment under that criterion) merged with the neighboring
 * short attribute-abbreviation label next to it, because the only condition besides geometry was the length of one of
 * the two sides — safe for clicking a SINGLE token in the UI (its only
 * consumer up to that point), too broad for ALL tokens of an entire
 * document, where short numeric values are common.
 *
 * [Step 30 Z5, more precise criterion from the brief] `mergeDiacriticSplitTokens`
 * below adds TWO extra conditions on top of geometry (touching with no gap, the
 * same line): the second token must start with a NON-ASCII character (the
 * signature of a genuine diacritic split — the accented remainder of a
 * split name starts with a non-ASCII letter, an ordinary short label does
 * not), and both tokens must share the same `fontRole`.
 * Measured directly on real data (that same p. 23): the bare initial and
 * the accented remainder of the name
 * have DIFFERENT `fontKey` (pdf.js used two different font resources for one
 * visually-composed word — hence the split in the first place), BUT the same `fontRole`
 * ('heading', since both are a bold heading) — the criterion from the brief
 * ("the same font key") would NOT have worked on this specific case,
 * which is why `fontRole` is used (the coarser, more stable classification from
 * inventory), not `fontKey`. The regression case (a short number plus a
 * short attribute label) has DIFFERENT
 * `fontRole` (`body` vs `accent`) AND the attribute label starts with ASCII — both
 * conditions independently exclude it.
 */
const DIACRITIC_MERGE_GAP_PT = 1;
const DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH = 2;

function looksLikeDiacriticSplit(prev: ProfileToken, next: ProfileToken): boolean {
  const gap = next.bbox.minX - prev.bbox.maxX;
  const sameLine = Math.min(prev.bbox.maxY, next.bbox.maxY) - Math.max(prev.bbox.minY, next.bbox.minY) > 0;
  const shortFragment = prev.text.length <= DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH || next.text.length <= DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH;
  const nextStartsNonAscii = next.text.length > 0 && next.text.charCodeAt(0) > 127;
  const sameFontRole = prev.fontRole !== undefined && prev.fontRole === next.fontRole;
  return sameLine && gap <= DIACRITIC_MERGE_GAP_PT && shortFragment && nextStartsNonAscii && sameFontRole;
}

function mergeDiacriticSplitTokens(tokens: readonly ProfileToken[]): ProfileToken[] {
  const merged: ProfileToken[] = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (prev && looksLikeDiacriticSplit(prev, t)) {
      merged[merged.length - 1] = {
        ...prev,
        text: prev.text + t.text,
        bbox: { minX: prev.bbox.minX, maxX: t.bbox.maxX, minY: Math.min(prev.bbox.minY, t.bbox.minY), maxY: Math.max(prev.bbox.maxY, t.bbox.maxY) },
      };
      continue;
    }
    merged.push(t);
  }
  return merged;
}

export interface TokenizePagePdfPageLike {
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

export interface TextContentItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  fontName?: string;
}

export function tokenizePage(
  items: readonly TextContentItemLike[],
  page: TokenizePagePdfPageLike,
  fontRoles: ReadonlyMap<string, FontRole>,
  pageNumber: number,
): ProfileToken[] {
  const tokens: ProfileToken[] = [];
  for (const item of items) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const transform = item.transform;
    const size = transform ? fontSizeFromTransform(transform as [number, number, number, number, number, number]) : 0;
    const fontKey = item.fontName ? resolveFontKey(item.fontName, page.commonObjs, size) : undefined;
    const fontRole = fontKey ? fontRoles.get(fontKey) : undefined;
    const x = transform?.[4] ?? 0;
    const y = transform?.[5] ?? 0;
    const w = item.width ?? 0;
    tokens.push({ text: str.trim(), bbox: { minX: x, maxX: x + w, minY: y, maxY: y + (size || 10) }, fontRole, fontKey: fontKey ?? undefined, page: pageNumber });
  }
  // [Step 42, bug measured live] The opposite problem from `mergeDiacriticSplitTokens`
  // above: on some PDFs pdf.js itself MERGES the label and value of an
  // attribute grid into one TextItem (a short all-caps attribute abbreviation
  // immediately followed by its numeric value), when they are printed without a colon
  // and tightly spaced. `splitMergedLabelValueTokens` (`inferPatternFromSelection.ts`,
  // ALSO used by `ProfileStudio.ts`'s `#getBuildTokens`, so both
  // places see the same split) splits them back apart — see
  // the comment at its definition.
  //
  // [Step 43, bug measured live] `stripStrayLeadingColonTokens`
  // (same file, same shared mechanism) removes a colon that
  // pdf.js sometimes leaves at the START of a value instead of at the end of a label —
  // see the comment at its definition (a bold mini-label immediately
  // followed by its plain-text value with a leading colon).
  return splitMergedLabelValueTokens(stripStrayLeadingColonTokens(mergeDiacriticSplitTokens(tokens)));
}
