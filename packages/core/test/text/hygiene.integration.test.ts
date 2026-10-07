import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { runHygiene } from '../../src/text/hygiene.js';
import type { PdfTextItemLike } from '../../src/text/types.js';

import { build as buildTextEmptyItems } from '../synth/fixtures/text-empty-items.js';
import { build as buildTextPositionalDuplicates } from '../synth/fixtures/text-positional-duplicates.js';
import { build as buildTextLigaturesHyphenation } from '../synth/fixtures/text-ligatures-hyphenation.js';
import { build as buildTextCombiningDiacritics } from '../synth/fixtures/text-combining-diacritics.js';
import { build as buildTextBrokenToUnicode } from '../synth/fixtures/text-broken-tounicode.js';

async function textItemsOf(buf: Buffer): Promise<PdfTextItemLike[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent({ disableNormalization: true } as never);
  return (tc.items as PdfTextItemLike[]).filter((i) => 'str' in i);
}

describe('runHygiene — fixture text-empty-items (group B)', () => {
  it('4 pdf.js synthetic space items filtered out as wordBoundaries, 5 words kept', async () => {
    const res = runHygiene(await textItemsOf(buildTextEmptyItems()));
    expect(res.items.map((i) => i.str)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
    expect(res.wordBoundaries).toHaveLength(4);
  });
});

describe('runHygiene — fixture text-positional-duplicates (group B)', () => {
  it('Goblin reduced to 1, Orc merged with syntheticBold, Kobold unchanged', async () => {
    const res = runHygiene(await textItemsOf(buildTextPositionalDuplicates()));
    expect(res.items).toHaveLength(3);
    const goblin = res.items.find((i) => i.str === 'Goblin');
    const orc = res.items.find((i) => i.str === 'Orc');
    const kobold = res.items.find((i) => i.str === 'Kobold');
    expect(goblin?.syntheticBold).toBe(false);
    expect(orc?.syntheticBold).toBe(true);
    expect(kobold?.syntheticBold).toBe(false);
  });
});

describe('runHygiene — fixture text-ligatures-hyphenation (group B)', () => {
  it('the fi/fl ligatures expanded; joining a hyphenation break is NOT part of text hygiene (see line clustering)', async () => {
    const res = runHygiene(await textItemsOf(buildTextLigaturesHyphenation()));
    expect(res.items.map((i) => i.str)).toEqual(['office', 'flame', 'encyclo-', 'pedia']);
  });
});

describe('runHygiene — fixture text-combining-diacritics (group B)', () => {
  it('both lines identical after NFC', async () => {
    const res = runHygiene(await textItemsOf(buildTextCombiningDiacritics()));
    expect(res.items).toHaveLength(2);
    expect(res.items[1]!.str).toBe('Siła');
  });
});

describe('runHygiene — fixture text-broken-tounicode (group B)', () => {
  it('unicodeConfidence < 0.3, merging doesn\'t blow up', async () => {
    const res = runHygiene(await textItemsOf(buildTextBrokenToUnicode()));
    expect(res.metrics.unicodeConfidence).toBeLessThan(0.3);
    expect(res.items.length).toBeGreaterThan(0);
  });
});
