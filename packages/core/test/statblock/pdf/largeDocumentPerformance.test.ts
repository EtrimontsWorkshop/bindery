import { describe, expect, it } from 'vitest';
import { detectStatblocks } from '../../../src/statblock/pdf/detectStatblocks.js';
import { buildStatblockReadingOrder } from '../../../src/statblock/pdf/readingOrder.js';
import { el, minimalProfile, page } from './testHelpers.js';

/**
 * Performance on a large PDF (hundreds of pages). Deliberately does NOT open a real PDF (hand-built `PageForDetection[]` is the right layer for THIS
 * concern): what's actually at risk of scaling badly is `detectStatblocks`'
 * OWN algorithm (building one reading order across every page, then
 * re-scanning slices of it per anchor) — not pdf.js's own decode speed,
 * which this project doesn't control and isn't what changed here. A
 * generous time budget below is a regression GUARD against an accidental
 * quadratic blowup (e.g. re-walking the whole document per anchor instead
 * of per-candidate slice), not a tight performance SLA.
 */
describe('statblock pdf/ — performance on a large (hundreds-of-pages) document', () => {
  it('detectStatblocks finds one candidate per page across 300 pages, well within a generous time budget', () => {
    const PAGE_COUNT = 300;
    const pages = Array.from({ length: PAGE_COUNT }, (_, i) => page(i + 1, [el('Goblin', 0, 100), el('HP:', 0, 90), el('7', 22, 90), el('AC:', 0, 80), el('15', 22, 80)]));
    const profile = minimalProfile({ requiredLabels: [{ pattern: 'HP:', isRegex: false }] });

    const start = performance.now();
    const candidates = detectStatblocks(pages, profile);
    const elapsedMs = performance.now() - start;

    expect(candidates).toHaveLength(PAGE_COUNT);
    expect(candidates.every((c) => c.confidence === 1)).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('buildStatblockReadingOrder scales roughly linearly, not quadratically, with page count', () => {
    const build = (pageCount: number): number => {
      const pages = Array.from({ length: pageCount }, (_, i) => page(i + 1, [el('Goblin', 0, 100), el('HP:', 0, 90), el('7', 22, 90)]));
      const start = performance.now();
      buildStatblockReadingOrder(pages);
      return performance.now() - start;
    };

    build(50); // warm up (JIT) before the timed comparison
    const small = build(100);
    const large = build(1000);

    // A quadratic algorithm run on 10x the pages would take roughly 100x as
    // long; a linear one takes roughly 10x. Generous 40x ceiling absorbs
    // timer noise on a small, sub-millisecond `small` measurement without
    // hiding a real quadratic regression (which would blow past it easily).
    expect(large).toBeLessThan(Math.max(small, 1) * 40);
  });
});
