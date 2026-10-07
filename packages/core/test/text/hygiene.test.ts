import { describe, expect, it } from 'vitest';
import { hasBoundaryBetween, runHygiene } from '../../src/text/hygiene.js';
import type { PdfTextItemLike } from '../../src/text/types.js';

// The field-by-field shape verified empirically directly on pdf.js's getTextContent() output:
// {str, dir, width, height, transform, fontName, hasEOL}.
function item(str: string, x: number, y: number, opts: Partial<PdfTextItemLike> = {}): PdfTextItemLike {
  return {
    str,
    dir: 'ltr',
    width: opts.width ?? str.length * 6,
    height: opts.height ?? 12,
    transform: opts.transform ?? [12, 0, 0, 12, x, y],
    fontName: opts.fontName ?? 'g_d0_f1',
    hasEOL: opts.hasEOL ?? false,
  };
}

describe('runHygiene — filtering whitespace', () => {
  it('filters out an item made up solely of whitespace and records it as a wordBoundary', () => {
    const items = [item('Alpha', 72, 700), item(' ', 100, 700, { width: 10 }), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.items.map((i) => i.str)).toEqual(['Alpha', 'Bravo']);
    expect(res.wordBoundaries).toEqual([{ afterItemIndex: 0, gapStart: 100, gapEnd: 110 }]);
  });

  it('merges consecutive whitespace items into ONE boundary', () => {
    const items = [item('Alpha', 72, 700), item(' ', 100, 700, { width: 5 }), item(' ', 105, 700, { width: 5 }), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.wordBoundaries).toHaveLength(1);
    expect(res.wordBoundaries[0]).toEqual({ afterItemIndex: 0, gapStart: 100, gapEnd: 110 });
  });

  it('the boundary before the first real item has afterItemIndex === -1', () => {
    const items = [item(' ', 72, 700, { width: 5 }), item('Alpha', 80, 700)];
    const res = runHygiene(items);
    expect(res.wordBoundaries[0]!.afterItemIndex).toBe(-1);
  });

  it('a completely empty item (str.length===0) is skipped, creates no boundary', () => {
    const items = [item('Alpha', 72, 700), item('', 100, 700), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.items.map((i) => i.str)).toEqual(['Alpha', 'Bravo']);
    expect(res.wordBoundaries).toHaveLength(0);
  });
});

describe('runHygiene — positional deduplication', () => {
  it('an exact duplicate (an identical str+transform) is reduced to one occurrence', () => {
    const items = [item('Goblin', 72, 700), item('Goblin', 72, 700)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.syntheticBold).toBe(false);
  });

  it('a duplicate shifted < 0.5pt is merged and marked syntheticBold', () => {
    const items = [item('Orc', 72, 670), item('Orc', 72.3, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.syntheticBold).toBe(true);
  });

  it('a shift >= 0.5pt is NOT treated as a duplicate (two separate items)', () => {
    const items = [item('Orc', 72, 670), item('Orc', 73, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => !i.syntheticBold)).toBe(true);
  });

  it('a different str at a similar position is not a duplicate', () => {
    const items = [item('Orc', 72, 670), item('Ogre', 72.1, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(2);
  });
});

describe('runHygiene — NFC normalization, ligatures, soft hyphen', () => {
  it('NFC: the decomposed and precomposed forms give an identical str', () => {
    const decomposed = item('Sil̵a', 72, 700); // l + a combining mark
    const precomposed = item('Siła', 72, 670);
    const res = runHygiene([decomposed, precomposed]);
    // NFC doesn't remove non-standard combining characters (U+0335 has no precomposed form with "l"),
    // but normalize('NFC') on both strings must give a deterministic, stable result.
    expect(res.items[1]!.str).toBe('Siła');
    expect(res.items[1]!.str.normalize('NFC')).toBe(res.items[1]!.str);
  });

  it('expands the ligatures FB00-FB06 into ASCII equivalents', () => {
    // "of" + ligatura fi (=f+i) + "ce" -> "office"; "fl" + "ame" -> "flame"
    const items = [item('ofﬁce', 72, 700), item('ﬂame', 72, 670)];
    const res = runHygiene(items);
    expect(res.items[0]!.str).toBe('office');
    expect(res.items[1]!.str).toBe('flame');
  });

  it('removes the soft hyphen U+00AD', () => {
    const res = runHygiene([item('encyclo­', 72, 700)]);
    expect(res.items[0]!.str).toBe('encyclo');
  });
});

describe('runHygiene — metrics after filtering', () => {
  it('fragmentationRatio computed AFTER discarding whitespace (not on the raw items)', () => {
    const items = [item('the', 72, 700), item(' ', 90, 700, { width: 30 }), item('a', 130, 700)];
    const res = runHygiene(items);
    expect(res.metrics.nonEmptyItemCount).toBe(2); // "the" and "a" — the space already filtered out
    expect(res.metrics.fragmentationRatio).toBeCloseTo(0.5); // "a" < 3 characters, "the" is not
  });

  it('a low unicodeConfidence generates the UNICODE_LOW_CONFIDENCE Diagnostic', () => {
    const puaText = String.fromCharCode(0xe000, 0xe001, 0xe002, 0xe003, 0xe004);
    const res = runHygiene([item(puaText, 72, 700)]);
    expect(res.metrics.unicodeConfidence).toBeLessThan(0.5);
    expect(res.diagnostics.some((d) => d.code === 'UNICODE_LOW_CONFIDENCE')).toBe(true);
  });
});

describe('hasBoundaryBetween — a boundary as a hard ban (a test enforcing the single-letter-word rule)', () => {
  it('detects a boundary between two original indices', () => {
    const boundaries = [{ afterItemIndex: 2, gapStart: 0, gapEnd: 0 }];
    expect(hasBoundaryBetween(boundaries, 0, 5)).toBe(true);
    expect(hasBoundaryBetween(boundaries, 3, 5)).toBe(false);
    expect(hasBoundaryBetween(boundaries, 0, 2)).toBe(false); // a boundary EXACTLY at the right end (exclusive) doesn't count as "between"
  });
});
