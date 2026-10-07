import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout, type PdfDocumentLike } from '../../src/text/buildTextLayout.js';
import { buildPageLayouts } from '../../src/layout/buildPageLayout.js';

import { build as buildFalseMerge } from '../synth/fixtures/layout-2col-false-merge.js';
import { build as buildTrueSpanning } from '../synth/fixtures/layout-2col-true-spanning.js';
import { build as buildLowConfidence } from '../synth/fixtures/layout-2col-lowconfidence.js';

/**
 * Integration tests of group E — the "a line crosses the gutter" discriminator verified on the REAL
 * pipeline (buildPageLayouts, which ties together column detection + the `gutterRepair.ts` repair
 * pass), not only on hand-built `TextLine`s (see `test/layout/gutterRepair.test.ts` for those, faster
 * unit tests of the discriminator itself).
 *
 * `layout-2col-false-merge` and `layout-2col-true-spanning` are DELIBERATELY inseparable: a fixture
 * proving splitting without a fixture proving NOT splitting proves nothing.
 */

async function openFixture(buf: Buffer): Promise<PdfDocumentLike> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLike;
}

async function runFullPipeline(buf: Buffer) {
  const doc = await openFixture(buf);
  const inv = await buildInventory(doc as never);
  const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));
  const doc2 = await openFixture(buf);
  const textLayout = await buildTextLayout(doc2, fontSizeByKey);
  const result = buildPageLayouts(textLayout, inv);
  return { inv, textLayout, result };
}

describe('group E — a false merge of columns (layout-2col-false-merge)', () => {
  it('a line joining two columns at the same height gets SPLIT (now by the edge split, BEFORE gutterRepair)', async () => {
    // This particular fixture (a larger-font label at the edge of a merged line) is now split by
    // `lineEdgeSplit.ts` EARLIER than `gutterRepair.ts` even gets a chance to act — the resulting
    // fragments are already too NARROW to cross the gutter, so `GUTTER_FALSE_MERGE_REPAIRED` no
    // longer fires (nothing is left to repair). The end result (a correct split into columns) is
    // IDENTICAL to when gutterRepair.ts did all the work — only the MECHANISM and its diagnostics
    // changed.
    const { result } = await runFullPipeline(buildFalseMerge());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    const edgeSplitDiag = result.diagnostics.find((d) => d.code === 'INLINE_HEADING_EDGE_SPLIT');
    expect(edgeSplitDiag).toBeDefined();
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const leftFragment = primary.lines.find((l) => l.text.includes('Short left end here'));
    const rightFragment = primary.lines.find((l) => l.text.includes('Sidebar Title'));
    expect(leftFragment).toBeDefined();
    expect(rightFragment).toBeDefined();
    // Split into the RIGHT columns — the left fragment in column 0, the right one in column 1.
    expect(leftFragment!.columnIndex).toBe(0);
    expect(rightFragment!.columnIndex).toBe(1);
    // No fragment contains text from the other side of the gutter.
    expect(leftFragment!.text).not.toContain('Sidebar');
    expect(rightFragment!.text).not.toContain('Short left end');
  });
});

describe('group E — a true spanning line (layout-2col-true-spanning)', () => {
  it('a header with tokens INSIDE the gutter area is NOT touched — the discriminator works both ways', async () => {
    const { result } = await runFullPipeline(buildTrueSpanning());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    // No repair diagnostic — nothing was split.
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const heading = primary.lines.find((l) => l.text.includes('Full Width Heading'));
    expect(heading).toBeDefined();
    // It stays UNASSIGNED to any column (spanning/marginalia in reading order), not split.
    expect(heading!.columnIndex).toBe(-1);
    expect(heading!.text).toBe(
      'Full Width Heading Spans The Gutter Right Through It Completely From Edge To Edge',
    );
  });
});

describe('group E — the confidence-threshold safeguard (layout-2col-lowconfidence)', () => {
  it('columns detected, but with LOW confidence (confidence < 0.85) — the false edge-label pattern still gets split by the edge split (independent of confidence)', async () => {
    // `lineEdgeSplit.ts` runs BEFORE `detectColumns`/`gutterRepair.ts` on RAW lines and doesn't look at
    // column confidence AT ALL — for THIS SPECIFIC pattern (a larger-font label at the edge of a merged
    // line) it splits unconditionally, even when the columns are detected with low confidence. The
    // confidence-threshold safeguard of `gutterRepair.ts` REMAINS in the code and works exactly as
    // before — still verified directly, at the function level, in `gutterRepair.test.ts` ("confidence
    // below the threshold -> untouched") — this fixture simply no longer demonstrates it in the full
    // pipeline for THIS pattern, because the edge split got there first. This is NOT a regression: the
    // final text is CORRECT (separated), only the mechanism changed.
    const { result } = await runFullPipeline(buildLowConfidence());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    expect(result.diagnostics.find((d) => d.code === 'INLINE_HEADING_EDGE_SPLIT')).toBeDefined();
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const leftFragment = primary.lines.find((l) => l.text.includes('Short left end here'));
    const rightFragment = primary.lines.find((l) => l.text.includes('Sidebar Title'));
    expect(leftFragment).toBeDefined();
    expect(rightFragment).toBeDefined();
    expect(leftFragment!.text).not.toContain('Sidebar');
  });
});
