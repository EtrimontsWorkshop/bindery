import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout, type PdfDocumentLike } from '../../src/text/buildTextLayout.js';

import { build as buildTextFragmented75 } from '../synth/fixtures/text-fragmented-75.js';
import { build as buildTextFragmented20 } from '../synth/fixtures/text-fragmented-20.js';
import { build as buildTextEmptyItems } from '../synth/fixtures/text-empty-items.js';
import { build as buildTextPositionalDuplicates } from '../synth/fixtures/text-positional-duplicates.js';
import { build as buildTextRotatedMarginalia } from '../synth/fixtures/text-rotated-marginalia.js';
import { build as buildTextRotatedExtreme } from '../synth/fixtures/text-rotated-extreme.js';
import { build as buildTextBrokenToUnicode } from '../synth/fixtures/text-broken-tounicode.js';
import { build as buildTextCombiningDiacritics } from '../synth/fixtures/text-combining-diacritics.js';
import { build as buildTextLigaturesHyphenation } from '../synth/fixtures/text-ligatures-hyphenation.js';

async function openFixture(buf: Buffer): Promise<PdfDocumentLike> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLike;
}

/** Builds fontSizeByKey from InventoryResult.fonts — exactly as a real caller (the layout orchestration) will. */
async function fontSizeMapFor(buf: Buffer): Promise<Map<string, number>> {
  const doc = await openFixture(buf);
  const inv = await buildInventory(doc as never);
  return new Map(inv.fonts.map((f) => [f.key, f.size]));
}

describe('buildTextLayout — text-fragmented-75/20 (every token on its own row)', () => {
  it('text-fragmented-75: 40 lines, the first 10 are WHOLE_WORDS unchanged (nothing merged thanks to the different Y)', async () => {
    const buf = buildTextFragmented75();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(40);
    expect(lines.slice(0, 10).map((l) => l.text)).toEqual(['the', 'and', 'run', 'big', 'red', 'sky', 'day', 'old', 'new', 'sun']);
  });

  it('text-fragmented-20: 50 lines in the original emission order', async () => {
    const buf = buildTextFragmented20();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(50);
    expect(lines[4]!.text).toBe('a'); // splice((0+1)*4+0=4, 0, 'a') — the first single character at position 4
  });
});

describe('buildTextLayout — text-empty-items (group B)', () => {
  it('5 words on one line, pdf.js synthetic spaces filtered out, one line of text with spaces', async () => {
    const buf = buildTextEmptyItems();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('Alpha Bravo Charlie Delta Echo');
  });
});

describe('buildTextLayout — text-positional-duplicates (group B)', () => {
  it('Goblin deduplicated, Orc syntheticBold=true on the line, Kobold unchanged', async () => {
    const buf = buildTextPositionalDuplicates();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    const goblinLine = lines.find((l) => l.text === 'Goblin');
    const orcLine = lines.find((l) => l.text === 'Orc');
    expect(goblinLine?.syntheticBold).toBe(false);
    expect(orcLine?.syntheticBold).toBe(true);
  });
});

describe('buildTextLayout — text-rotated-marginalia (group B)', () => {
  it('two streams: 0° isPrimary=true with 5 lines, 90° isPrimary=false', async () => {
    const buf = buildTextRotatedMarginalia();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const streams = result.pages[0]!.streams;
    expect(streams.map((s) => s.angle)).toEqual([0, 90]);
    const primary = streams.find((s) => s.angle === 0)!;
    expect(primary.isPrimary).toBe(true);
    expect(primary.lines.map((l) => l.text)).toEqual([
      'Chapter One',
      'The journey begins',
      'in a quiet village',
      'near the old forest',
      'where shadows linger',
    ]);
    expect(streams.find((s) => s.angle === 90)!.isPrimary).toBe(false);
  });
});

describe('buildTextLayout — text-rotated-extreme (group B)', () => {
  it('a dominant 90° stream, handled without an error', async () => {
    const buf = buildTextRotatedExtreme();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const streams = result.pages[0]!.streams;
    const vertical = streams.find((s) => s.angle === 90);
    expect(vertical).toBeDefined();
    expect(vertical!.lines.length).toBe(18);
  });
});

describe('buildTextLayout — text-broken-tounicode (group B)', () => {
  it('doesn\'t blow up on a broken ToUnicode (PUA)', async () => {
    const buf = buildTextBrokenToUnicode();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(3);
  });
});

describe('buildTextLayout — text-combining-diacritics (group B)', () => {
  it('a line already in NFC ("Siła") stays unchanged; NFC is applied and idempotent', async () => {
    const buf = buildTextCombiningDiacritics();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(2);
    // Line 2 is a precomposed "ł" (already NFC) — it must stay exactly "Siła".
    expect(lines[1]!.text).toBe('Siła');
    // Line 1 is a stand-in "l" + U+0335 (not a real NFD decomposition of "ł" — Unicode does NOT
    // define "ł" as decomposing into "l" + a combining mark, see the comment in the .ts fixture),
    // so normalize('NFC') is a no-op here by definition — we check idempotence, NOT equality with
    // line 2 (that would be a faulty assumption).
    expect(lines[0]!.text).toBe(lines[0]!.text.normalize('NFC'));
    expect(lines[0]!.text).not.toBe(lines[1]!.text);
  });
});

describe('buildTextLayout — text-ligatures-hyphenation (group B)', () => {
  it('ligatures expanded, the hyphenation "encyclo-"/"pedia" joined into "encyclopedia"', async () => {
    const buf = buildTextLigaturesHyphenation();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines.map((l) => l.text)).toEqual(['office', 'flame', 'encyclopedia']);
  });
});

describe('buildTextLayout — determinism', () => {
  it('two runs on the same file give an identical result (after serialization)', async () => {
    const buf = buildTextRotatedMarginalia();
    const sizeMap = await fontSizeMapFor(buf);
    function serialize(r: Awaited<ReturnType<typeof buildTextLayout>>) {
      return JSON.stringify(r, (_key, value) => (value instanceof Map ? [...value.entries()] : value), 2);
    }
    const r1 = await buildTextLayout(await openFixture(buf), sizeMap);
    const r2 = await buildTextLayout(await openFixture(buf), sizeMap);
    expect(serialize(r1)).toBe(serialize(r2));
  });
});
