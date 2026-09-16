import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { runHygiene } from '../../src/text/hygiene.js';
import { groupByAngle } from '../../src/layout/angleStreams.js';
import type { PdfTextItemLike } from '../../src/text/types.js';

import { build as buildTextRotatedMarginalia } from '../synth/fixtures/text-rotated-marginalia.js';
import { build as buildTextRotatedExtreme } from '../synth/fixtures/text-rotated-extreme.js';

async function textItemsOf(buf: Buffer): Promise<PdfTextItemLike[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent({ disableNormalization: true } as never);
  return (tc.items as PdfTextItemLike[]).filter((i) => 'str' in i);
}

describe('groupByAngle — fixture text-rotated-marginalia (grupa B)', () => {
  it('dwa strumienie: 0° isPrimary=true, 90° isPrimary=false', async () => {
    const clean = runHygiene(await textItemsOf(buildTextRotatedMarginalia()));
    const { streams } = groupByAngle(clean.items);
    expect(streams.map((s) => s.angle)).toEqual([0, 90]);
    expect(streams.find((s) => s.angle === 0)!.isPrimary).toBe(true);
    expect(streams.find((s) => s.angle === 90)!.isPrimary).toBe(false);
  });
});

describe('groupByAngle — fixture text-rotated-extreme (grupa B)', () => {
  it('strumien 90° dominujacy, obsluzony bez bledu', async () => {
    const clean = runHygiene(await textItemsOf(buildTextRotatedExtreme()));
    const { streams } = groupByAngle(clean.items);
    const total = streams.reduce((sum, s) => sum + s.items.length, 0);
    const vertical = streams.find((s) => s.angle === 90);
    expect(vertical).toBeDefined();
    expect(vertical!.items.length / total).toBeGreaterThan(0.85);
  });
});
