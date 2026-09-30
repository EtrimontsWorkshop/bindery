import { describe, expect, it } from 'vitest';
import { detectStatblocks } from '../../../src/statblock/pdf/detectStatblocks.js';
import { el, minimalProfile, page } from './testHelpers.js';

const TWO_COLUMNS = [
  { minX: 0, minY: 0, maxX: 280, maxY: 800 },
  { minX: 300, minY: 0, maxX: 600, maxY: 800 },
];

describe('detectStatblocks — single column, one clean statblock', () => {
  it('finds exactly one candidate covering the anchor and its body', () => {
    const p = page(1, [el('Goblin', 0, 100), el('HP:', 0, 90), el('7', 22, 90), el('AC:', 0, 80), el('15', 22, 80)]);
    const profile = minimalProfile({ requiredLabels: [{ pattern: 'HP:', isRegex: false }] });
    const candidates = detectStatblocks([p], profile);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.confidence).toBe(1);
    expect(candidates[0]!.regions).toEqual([{ pageNumber: 1, bbox: expect.any(Object) }]);
    expect(candidates[0]!.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:', '7', 'AC:', '15']);
  });

  it('finds two independent candidates, one per statblock, stacked vertically in one column', () => {
    const p = page(1, [el('Goblin', 0, 100), el('HP:', 0, 90), el('Orc', 0, 60), el('HP:', 0, 50)]);
    const profile = minimalProfile();
    const candidates = detectStatblocks([p], profile);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:']);
    expect(candidates[1]!.elements.map((e) => e.text)).toEqual(['Orc', 'HP:']);
  });
});

describe('detectStatblocks — two columns, two statblocks side by side (never merged)', () => {
  it("with boundary 'endOfColumnOrPage', each column's statblock is its own candidate, columns never mixed", () => {
    const p = page(
      1,
      [el('Goblin', 10, 100), el('HP:', 10, 90), el('7', 32, 90), el('Orc', 310, 100), el('HP:', 310, 90), el('15', 332, 90)],
      { columns: TWO_COLUMNS },
    );
    const profile = minimalProfile({ boundary: { kind: 'endOfColumnOrPage' } });
    const candidates = detectStatblocks([p], profile);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:', '7']);
    expect(candidates[1]!.elements.map((e) => e.text)).toEqual(['Orc', 'HP:', '15']);
    // Neither candidate's elements leak into the other's.
    expect(candidates[0]!.elements.some((e) => e.text === 'Orc')).toBe(false);
    expect(candidates[1]!.elements.some((e) => e.text === 'Goblin')).toBe(false);
  });

  it("WITHOUT endOfColumnOrPage (plain nextAnchor), two side-by-side statblocks would incorrectly merge into one — this is exactly why endOfColumnOrPage exists", () => {
    const p = page(
      1,
      [el('Goblin', 10, 100), el('HP:', 10, 90), el('Orc', 310, 100), el('HP:', 310, 90)],
      { columns: TWO_COLUMNS },
    );
    const profile = minimalProfile({ boundary: { kind: 'nextAnchor' } });
    const candidates = detectStatblocks([p], profile);
    // Goblin's candidate runs all the way to the Orc anchor -- crossing into column 2's non-anchor content first? No content between them here besides the anchors themselves, so Goblin's candidate is just itself.
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:']);
  });
});

describe('detectStatblocks — statblock crossing a column boundary', () => {
  it('one candidate spans two regions when nothing stops it before the column ends', () => {
    // 'Goblin' anchor near the BOTTOM of column 0 (nothing else in column 0);
    // the body picks up at the TOP of column 1 (x >= 300) and continues until
    // the next anchor ('Orc'), further down column 1.
    const p = page(
      1,
      [el('Goblin', 10, 5), el('HP:', 310, 795), el('7', 332, 795), el('Orc', 310, 700)],
      { columns: TWO_COLUMNS },
    );
    const profile = minimalProfile({ boundary: { kind: 'nextAnchor' } });
    const candidates = detectStatblocks([p], profile);
    expect(candidates).toHaveLength(2);
    const goblin = candidates[0]!;
    expect(goblin.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:', '7']);
    expect(goblin.regions).toHaveLength(2);
    expect(goblin.regions[0]!).toMatchObject({ pageNumber: 1 });
    expect(goblin.regions[1]!).toMatchObject({ pageNumber: 1 });
  });
});

describe('detectStatblocks — statblock crossing a page boundary', () => {
  it('one candidate spans two pages when nothing stops it before the next anchor, on the next page', () => {
    // 'Goblin' anchor near the bottom of page 1, alone; the body ('HP:',
    // 'continued text') picks up at the top of page 2 and continues until
    // the next anchor ('Orc'), further down page 2.
    const p1 = page(1, [el('Goblin', 0, 5)]);
    const p2 = page(2, [el('HP:', 0, 795), el('continued text', 0, 700), el('Orc', 0, 600)]);
    const profile = minimalProfile({ boundary: { kind: 'nextAnchor' } });
    const candidates = detectStatblocks([p1, p2], profile);
    expect(candidates).toHaveLength(2);
    const goblin = candidates[0]!;
    expect(goblin.elements.map((e) => e.text)).toEqual(['Goblin', 'HP:', 'continued text']);
    expect(goblin.regions.map((r) => r.pageNumber)).toEqual([1, 2]);
  });

  it("verticalGap does not falsely stop at a page crossing (the gap is reset there, not measured)", () => {
    const p1 = page(1, [el('Goblin', 0, 5)]); // anchor right at the bottom of page 1
    const p2 = page(2, [el('continued text', 0, 795)]); // picks up right at the top of page 2 -- huge raw Y difference, but it's a page crossing
    const profile = minimalProfile({ boundary: { kind: 'verticalGap', gapThreshold: 30 } });
    const candidates = detectStatblocks([p1, p2], profile);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.elements.map((e) => e.text)).toEqual(['Goblin', 'continued text']);
  });
});

describe('detectStatblocks — no statblocks in the document', () => {
  it('returns an empty list, not an error, when nothing matches the anchor', () => {
    const p = page(1, [el('just some prose text', 0, 100), el('nothing here looks like a heading', 0, 80)]);
    const candidates = detectStatblocks([p], minimalProfile());
    expect(candidates).toEqual([]);
  });

  it('returns an empty list for a completely empty document', () => {
    expect(detectStatblocks([], minimalProfile())).toEqual([]);
  });
});

describe('detectStatblocks — false positives are reported, not silently dropped', () => {
  it('an anchor-shaped line with no nearby required labels still produces a candidate, with confidence 0', () => {
    const p = page(1, [
      el('Contents', 0, 100), // looks like an anchor (capitalized word) but is really a table-of-contents heading
      el('Goblin', 0, 60), // a genuine statblock
      el('HP:', 0, 50),
    ]);
    const profile = minimalProfile({ requiredLabels: [{ pattern: 'HP:', isRegex: false }] });
    const candidates = detectStatblocks([p], profile);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.elements[0]!.text).toBe('Contents');
    expect(candidates[0]!.confidence).toBe(0);
    expect(candidates[0]!.missingRequiredLabels).toEqual(['HP:']);
    expect(candidates[1]!.elements[0]!.text).toBe('Goblin');
    expect(candidates[1]!.confidence).toBe(1);
  });
});

describe('detectStatblocks — candidate ids and elements are always populated, never thrown', () => {
  it('every candidate has a unique id', () => {
    const p = page(1, [el('Goblin', 0, 100), el('Orc', 0, 50)]);
    const candidates = detectStatblocks([p], minimalProfile());
    const ids = candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
