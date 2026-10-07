import { describe, expect, it } from 'vitest';
import { mergeWords, type MergeCandidateItem } from '../../src/layout/wordMerge.js';
import type { WordBoundary } from '../../src/text/types.js';
import type { FontGapProfile, HierarchicalGapProfile } from '../../src/text/gapStatistics.js';

const PAGE = 1;

function candidate(
  index: number,
  str: string,
  x: number,
  opts: Partial<MergeCandidateItem> = {},
): MergeCandidateItem {
  return {
    index,
    str,
    transform: opts.transform ?? [12, 0, 0, 12, x, 700],
    width: opts.width ?? str.length * 6,
    height: opts.height ?? 12,
    fontName: opts.fontName ?? 'F1',
    fontKey: opts.fontKey ?? 'Body@12',
    syntheticBold: opts.syntheticBold ?? false,
  };
}

function flatProfile(fontKey: string, intraWordThreshold = 3, interWordThreshold = 12): FontGapProfile {
  return { fontKey, intraWordThreshold, interWordThreshold, separation: 0.8, sampleCount: 200, reliable: true };
}

function unreliableFlatProfile(fontKey: string): FontGapProfile {
  return { fontKey, intraWordThreshold: 3, interWordThreshold: 12, separation: 0.1, sampleCount: 10, reliable: false };
}

/** Wraps the "flat" profile as hierarchical without its own page profile — the default case (no per-page override). */
function hierarchical(document: FontGapProfile, byPage: Map<number, FontGapProfile> = new Map()): HierarchicalGapProfile {
  return { fontKey: document.fontKey, document, byPage };
}

function reliableProfile(fontKey: string, intraWordThreshold = 3, interWordThreshold = 12): HierarchicalGapProfile {
  return hierarchical(flatProfile(fontKey, intraWordThreshold, interWordThreshold));
}

function unreliableProfile(fontKey: string): HierarchicalGapProfile {
  return hierarchical(unreliableFlatProfile(fontKey));
}

describe('mergeWords — the base condition: merging below the threshold', () => {
  it('merges two fragments of the same font, gap < intraWordThreshold, no boundary', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap = 85-(72+12) = 1
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.str).toBe('cat');
    expect(tokens[0]!.sourceIndices).toEqual([0, 1]);
  });

  it('merges a CHAIN of 3+ fragments into one token', () => {
    const items = [candidate(0, 'd', 72, { width: 6 }), candidate(1, 'o', 79, { width: 6 }), candidate(2, 'g', 86, { width: 6 })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.str).toBe('dog');
    expect(tokens[0]!.sourceIndices).toEqual([0, 1, 2]);
  });
});

describe('mergeWords — condition #1: the same font key', () => {
  it('does NOT merge when the font key differs, even with a small gap', () => {
    const items = [candidate(0, 'ca', 72, { width: 12, fontKey: 'A@12' }), candidate(1, 't', 85, { width: 6, fontKey: 'B@12' })];
    const profiles = new Map([['A@12', reliableProfile('A@12')], ['B@12', reliableProfile('B@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — condition #4 [HARD]: a word boundary is never crossed', () => {
  it('does NOT merge despite a small gap when there is a wordBoundary between the items', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 84, gapEnd: 85 }];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, boundaries, profiles, PAGE);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.str)).toEqual(['ca', 't']);
  });

  it('a single-letter word "w" (Polish) is NEVER glued to the next word when a boundary separates them', () => {
    // "w domu" — the space between "w" and "domu" detected as a wordBoundary by hygiene
    const items = [candidate(0, 'w', 72, { width: 6 }), candidate(1, 'domu', 90, { width: 24 })];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 78, gapEnd: 90 }];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, boundaries, profiles, PAGE);
    expect(tokens.map((t) => t.str)).toEqual(['w', 'domu']);
  });
});

describe('mergeWords — condition #6: the profile must be reliable (separation)', () => {
  it('does NOT merge when the font profile is uncertain (a unimodal distribution), despite a small gap and no boundary', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const profiles = new Map([['Body@12', unreliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });

  it('no profile at all (a font never seen in the statistics) -> conservatively, no merge', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const tokens = mergeWords(items, 0, [], new Map(), PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — condition #5: the gap must be strictly below the threshold', () => {
  it('does NOT merge when gap >= intraWordThreshold', () => {
    const items = [candidate(0, 'the', 72, { width: 18 }), candidate(1, 'cat', 95, { width: 18 })]; // gap=95-90=5 >= 3
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — a NEGATIVE gap (overlapping items) never merges', () => {
  it('does NOT merge when the items overlap geometrically (a negative gap), even though "gap < intraWordThreshold" is formally true', () => {
    // "next" starts INSIDE "prev" (prev: x=72..172, next starts at x=100) -> gap=100-172=-72.
    // Without the lower bound (gap>=0) every negative gap "passes" the gap<threshold test (e.g. 3), because -72<3 is true.
    const items = [candidate(0, 'ABCDEF', 72, { width: 100 }), candidate(1, 'GHIJ', 100, { width: 50 })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.str)).toEqual(['ABCDEF', 'GHIJ']);
  });

  it('replicates exactly a case from a real document (p. 3): two columns of a table of contents on the same baseline, overlapping', () => {
    const items = [
      candidate(0, 'AQUA NURGLIS', 255.9, { width: 97.7 }),
      candidate(1, 'ANVILGARD', 268.4, { width: 74.5 }), // starts BEFORE the end of the previous one (255.9+97.7=353.6)
    ];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 74.6, 100.9)]]); // the document threshold really measured for this font
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2); // must stay separate — this was a real bug found by calibration
  });
});

describe('mergeWords — condition #2: the same baseline', () => {
  it('does NOT merge items on different lines (cross-axis outside the tolerance), despite a close gap along the axis', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6, transform: [12, 0, 0, 12, 85, 650] })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — bucketing by baseline (a regression found by calibration on real files)', () => {
  it('a fragment of ANOTHER line that sorts BETWEEN two fragments of the same line by X doesn\'t prevent the merge', () => {
    // Line A (Y=700): "ca"@x=72 + "t"@x=85 -> should merge into "cat" (gap=1).
    // Line B (Y=650, a completely different line): "X"@x=80 — BETWEEN 72 and 85 in the global sort by X,
    // but on a DIFFERENT baseline. Without bucketing by line this item would break the adjacency of
    // "ca"/"t" in a naive sort of the whole stream by the along axis alone.
    const items = [
      candidate(0, 'ca', 72, { width: 12 }),
      candidate(1, 'X', 80, { transform: [12, 0, 0, 12, 80, 650], width: 8 }),
      candidate(2, 't', 85, { width: 6 }),
    ];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens.map((t) => t.str).sort()).toEqual(['X', 'cat']);
    const catToken = tokens.find((t) => t.str === 'cat')!;
    expect(catToken.sourceIndices).toEqual([0, 2]);
  });
});

describe('mergeWords — syntheticBold and order', () => {
  it('propagates syntheticBold from any source item to the merged token', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6, syntheticBold: true })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens[0]!.syntheticBold).toBe(true);
  });

  it('sorts the items along the reading axis before merging, regardless of the input order', () => {
    const items = [candidate(1, 't', 85, { width: 6 }), candidate(0, 'ca', 72, { width: 12 })]; // reversed order
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens[0]!.str).toBe('cat');
  });
});

describe('mergeWords — a hierarchical profile (document + page)', () => {
  it('uses the PAGE threshold when it is more conservative (smaller) than the document one', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 88, { width: 6 })]; // gap=88-84=4
    const doc = flatProfile('Body@12', 8, 20); // document: wide, tolerant (e.g. learned from paragraphs)
    const page = flatProfile('Body@12', 3, 12); // page: tight (e.g. a dense table of contents)
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[PAGE, page]]))]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    // gap=4: BELOW the document threshold (8) but ABOVE the page one (3) -> the more conservative (page) wins -> NO merge
    expect(tokens).toHaveLength(2);
  });

  it('merges normally when the gap is below BOTH thresholds (document and page)', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap=1
    const doc = flatProfile('Body@12', 8, 20);
    const page = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[PAGE, page]]))]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
  });

  it('no page profile (e.g. too few samples on this page) -> uses ONLY the document profile', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap=1
    const doc = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc)]]); // byPage empty — no entry for PAGE
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1); // gap=1 < the document threshold 3 -> merges normally
  });

  it('another page of the same document may have a DIFFERENT effective threshold (per-page isolation)', () => {
    const doc = flatProfile('Body@12', 8, 20);
    const tightPageProfile = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[2, tightPageProfile]]))]]);
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 88, { width: 6 })]; // gap=4

    const tokensPage1 = mergeWords(items, 0, [], profiles, 1); // no profile of page 1 -> only the document one (8) -> gap=4<8 -> merges
    expect(tokensPage1).toHaveLength(1);

    const tokensPage2 = mergeWords(items, 0, [], profiles, 2); // the profile of page 2 (3) is more conservative -> gap=4>=3 -> does NOT merge
    expect(tokensPage2).toHaveLength(2);
  });
});
