import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { PDF_OPEN_OPTIONS } from '../../src/pdfDocument.js';
import { buildTextLayout, createTextLayoutCollector } from '../../src/text/buildTextLayout.js';

import { build as buildTextFragmented75 } from '../synth/fixtures/text-fragmented-75.js';
import { build as buildTextRotatedMarginalia } from '../synth/fixtures/text-rotated-marginalia.js';
import { build as buildTextCombiningDiacritics } from '../synth/fixtures/text-combining-diacritics.js';
import { build as buildTextLigaturesHyphenation } from '../synth/fixtures/text-ligatures-hyphenation.js';
import { build as buildTextBrokenToUnicode } from '../synth/fixtures/text-broken-tounicode.js';
import { build as buildImagesDecorated } from '../synth/fixtures/images-decorated.js';
import { build as buildFontsSubsetPrefix } from '../synth/fixtures/fonts-subset-prefix.js';

async function open(buf: Buffer): Promise<never> {
  return (await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buf) }).promise) as never;
}

/**
 * The analysis no longer opens the PDF a second time for the text: the inventory hands every page's text to a
 * collector while it walks. The result must be what the text layout gives when it walks a fresh document itself.
 */
describe('text layout gathered during the inventory walk', () => {
  it.each([
    ['text-fragmented-75', buildTextFragmented75],
    ['text-rotated-marginalia', buildTextRotatedMarginalia],
    ['text-combining-diacritics', buildTextCombiningDiacritics],
    ['text-ligatures-hyphenation', buildTextLigaturesHyphenation],
    ['text-broken-tounicode', buildTextBrokenToUnicode],
    ['images-decorated', buildImagesDecorated],
    ['fonts-subset-prefix', buildFontsSubsetPrefix],
  ])('%s: the same as a walk of its own', async (_name, build) => {
    const buf = build();
    const collector = createTextLayoutCollector();
    const inv = await buildInventory(await open(buf), { onPageText: collector.addPage });
    const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));

    const gathered = collector.finish(fontSizeByKey);
    const separate = await buildTextLayout(await open(buf), fontSizeByKey);

    expect(gathered.pages.length).toBe(inv.pageCount);
    expect(gathered).toEqual(separate);
  });
});
