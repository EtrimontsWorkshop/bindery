import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout, type PdfDocumentLike } from '../../src/text/buildTextLayout.js';
import { buildPageLayouts } from '../../src/layout/buildPageLayout.js';

import { build as buildTextRotatedMarginalia } from '../synth/fixtures/text-rotated-marginalia.js';
import { build as buildTextFragmented75 } from '../synth/fixtures/text-fragmented-75.js';

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

describe('buildPageLayouts — pipeline end-to-end na prawdziwych fixturach', () => {
  it('text-rotated-marginalia: strumien 0° i 90° obecne, marginalia sklasyfikowane, kolejnosc czytania zachowana', async () => {
    const { result } = await runFullPipeline(buildTextRotatedMarginalia());
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.streams.map((s) => s.angle).sort()).toEqual([0, 90]);
    const primary = page.streams.find((s) => s.angle === 0)!;
    expect(primary.lines.map((l) => l.text)).toEqual([
      'Chapter One',
      'The journey begins',
      'in a quiet village',
      'near the old forest',
      'where shadows linger',
    ]);
    const marginaliaBlocks = result.blocks.filter((b) => b.kind === 'marginalia');
    expect(marginaliaBlocks.length).toBeGreaterThan(0);
    expect(result.blocks.every((b) => typeof b.matchedRuleId === 'string')).toBe(true);
  });

  it('text-fragmented-75: 40 linie oddzielne (rozne Y) -> jedna kolumna, brak wyjatku', async () => {
    const { result } = await runFullPipeline(buildTextFragmented75());
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.columns.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('determinizm: dwa uruchomienia na tym samym pliku daja identyczny wynik', async () => {
    const buf = buildTextRotatedMarginalia();
    function serialize(r: Awaited<ReturnType<typeof runFullPipeline>>['result']) {
      return JSON.stringify(r);
    }
    const r1 = (await runFullPipeline(buf)).result;
    const r2 = (await runFullPipeline(buf)).result;
    expect(serialize(r1)).toBe(serialize(r2));
  });
});
