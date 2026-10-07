import { describe, expect, it } from 'vitest';
import { detectRunningElements, type PageForRunningElements } from '../../src/layout/runningElements.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

const PAGE_HEIGHT = 792;

function line(id: string, minX: number, maxX: number, y: number, fontKey = 'Header@9'): TextLine {
  return {
    id,
    text: id,
    bbox: { minX, minY: y, maxX, maxY: y + 10 },
    columnIndex: -1,
    crossAxisPosition: y,
    fonts: [{ key: fontKey, size: 9 }],
    dominantFont: { key: fontKey, size: 9 },
    syntheticBold: false,
  };
}

describe('detectRunningElements — matching NOT by exact text (the page number changes)', () => {
  it('a header of constant text + a varying page number on each of 6 pages -> detected on all', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 6 }, (_, i) => {
      const pageNumber = i + 1;
      // Header: a title constantly in the same position + a page number with a varying number of digits (1 vs 10+).
      const pageLabel = `Chapter One - ${pageNumber}`;
      return {
        pageNumber,
        pageHeight: PAGE_HEIGHT,
        primaryLines: [
          line(`header-p${pageNumber}`, 72, 72 + pageLabel.length * 5, 760), // y=760/792=95.9% > 93% -> header band
          line(`body-p${pageNumber}`, 72, 300, 400), // main content, outside the band
        ],
      };
    });
    const matches = detectRunningElements(pages);
    const headerMatches = matches.filter((m) => m.kind === 'header');
    expect(headerMatches).toHaveLength(6);
    expect(headerMatches.map((m) => m.pageNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // Main content is never matched as a header/footer.
    expect(matches.some((m) => m.lineId.startsWith('body'))).toBe(false);
  });
});

describe('detectRunningElements — a footer analogously to a header', () => {
  it('a line in the bottom band (y < 7% of the height) detected as a footer', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`footer-p${i + 1}`, 250, 350, 30, 'Footer@8')], // y=30/792=3.8% < 7%
    }));
    const matches = detectRunningElements(pages);
    expect(matches.every((m) => m.kind === 'footer')).toBe(true);
    expect(matches).toHaveLength(5);
  });
});

describe('detectRunningElements — a conjunction of conditions', () => {
  it('does NOT match when the font key differs on every page, despite the same position', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, 200, 760, `Font${i}@9`)], // a different font on every page
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('does NOT match when the horizontal position is too different between pages', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72 + i * 100, 200 + i * 100, 760)], // x shifts a lot on every page
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('matches despite a width difference resulting from a varying number of page-number digits', () => {
    const widths = [72 + 1 * 5, 72 + 2 * 5, 72 + 3 * 5]; // "9", "10", "100" - a different number of digits
    const pages: PageForRunningElements[] = widths.map((w, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, w, 760)],
    }));
    // The default tolerance (12pt) may split a 5pt-15pt difference into adjacent quantization buckets
    // by rounding at the boundary (a known trade-off of simple bucketing, see collections.ts) — here an
    // explicitly wider tolerance, to test the "similar, not identical width" MECHANISM itself, not a
    // specific default value.
    const matches = detectRunningElements(pages, { widthTolerancePt: 100 });
    expect(matches).toHaveLength(3);
  });
});

describe('detectRunningElements — the 60%-of-pages threshold in the range', () => {
  it('a signature present on fewer than 60% of pages is NOT reported', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      // only 5/10 = 50% of the pages have any candidate in the header band
      primaryLines: i < 5 ? [line(`h-p${i + 1}`, 72, 200, 760)] : [line(`body-p${i + 1}`, 72, 200, 400)],
    }));
    expect(detectRunningElements(pages)).toHaveLength(0);
  });

  it('a signature present at exactly the threshold (60%) IS reported', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: i < 6 ? [line(`h-p${i + 1}`, 72, 200, 760)] : [line(`body-p${i + 1}`, 72, 200, 400)],
    }));
    const matches = detectRunningElements(pages);
    expect(matches.filter((m) => m.kind === 'header')).toHaveLength(6);
  });
});

describe('detectRunningElements — doesn\'t remove, only marks (the contract of the returned data)', () => {
  it('returns lineId + pageNumber + kind, doesn\'t modify the input lines', () => {
    const pages: PageForRunningElements[] = Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      pageHeight: PAGE_HEIGHT,
      primaryLines: [line(`h-p${i + 1}`, 72, 200, 760)],
    }));
    const matches = detectRunningElements(pages);
    for (const m of matches) {
      expect(m).toHaveProperty('lineId');
      expect(m).toHaveProperty('pageNumber');
      expect(m.kind).toBe('header');
    }
  });
});
