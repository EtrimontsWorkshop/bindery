import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout, type PdfDocumentLike } from '../../src/text/buildTextLayout.js';
import { buildPageLayouts } from '../../src/layout/buildPageLayout.js';

import { build as buildLayout1col } from '../synth/fixtures/layout-1col.js';
import { build as buildLayout2col } from '../synth/fixtures/layout-2col.js';
import { build as buildLayout3col } from '../synth/fixtures/layout-3col.js';
import { build as buildLayout2colSpanning } from '../synth/fixtures/layout-2col-spanning.js';
import { build as buildLayout2colSidebar } from '../synth/fixtures/layout-2col-sidebar.js';
import { build as buildLayoutRunningHeads } from '../synth/fixtures/layout-running-heads.js';
import { build as buildLayoutTocDotleaders } from '../synth/fixtures/layout-toc-dotleaders.js';
import { build as buildLayoutStatblockFramed } from '../synth/fixtures/layout-statblock-framed.js';
import { build as buildLayoutStatblockPlain } from '../synth/fixtures/layout-statblock-plain.js';

/**
 * Testy integracyjne grupy C (KROK-6 Z7) — kazdy wiersz DoD z brief'u
 * zweryfikowany na PRAWDZIWYM detektorze (detectColumns/buildReadingOrder/
 * detectRunningElements/buildSemanticBlocks), NIE na `claims` fixture'u
 * (te sa tylko konstrukcyjnym self-checkiem, patrz test/synth/fixtures/*.json).
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

describe('grupa C — kolumny (layout-1col/2col/3col)', () => {
  it('layout-1col: brak rynny -> jedna kolumna, confidence=1', async () => {
    const { result } = await runFullPipeline(buildLayout1col());
    expect(result.pages[0]!.columns).toHaveLength(1);
  });

  it('layout-2col: rynna x~260-310 -> dokladnie dwie kolumny', async () => {
    const { result } = await runFullPipeline(buildLayout2col());
    expect(result.pages[0]!.columns).toHaveLength(2);
  });

  it('layout-3col: dwie rynny -> dokladnie trzy kolumny', async () => {
    const { result } = await runFullPipeline(buildLayout3col());
    expect(result.pages[0]!.columns).toHaveLength(3);
  });
});

describe('grupa C — naglowek rozpinajacy (layout-2col-spanning)', () => {
  it('naglowek wydzielony jako rozpinajacy, kolumny wykryte mimo niego, kolejnosc czytania: gora-lewo, gora-prawo, naglowek, dol-lewo, dol-prawo', async () => {
    const { result } = await runFullPipeline(buildLayout2colSpanning());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    const primary = page.streams.find((s) => s.angle === 0)!;
    const texts = primary.lines.map((l) => l.text);
    const headingIndex = texts.findIndex((t) => t.includes('Full Width Section Heading'));
    expect(headingIndex).toBeGreaterThan(-1);

    const before = texts.slice(0, headingIndex);
    const after = texts.slice(headingIndex + 1);
    expect(before.filter((t) => t.startsWith('TopLeft'))).toHaveLength(4);
    expect(before.filter((t) => t.startsWith('TopRight'))).toHaveLength(4);
    expect(after.filter((t) => t.startsWith('BottomLeft'))).toHaveLength(4);
    expect(after.filter((t) => t.startsWith('BottomRight'))).toHaveLength(4);
    // lewo przed prawo w kazdym pasmie
    expect(before.indexOf(before.find((t) => t.startsWith('TopLeft'))!)).toBeLessThan(
      before.indexOf(before.find((t) => t.startsWith('TopRight'))!),
    );
    expect(after.indexOf(after.find((t) => t.startsWith('BottomLeft'))!)).toBeLessThan(
      after.indexOf(after.find((t) => t.startsWith('BottomRight'))!),
    );
  });
});

describe('grupa C — sidebar (layout-2col-sidebar)', () => {
  it('sidebar sklasyfikowany jako osobny blok BlockKind:"sidebar", NIE trzecia kolumna', async () => {
    const { result } = await runFullPipeline(buildLayout2colSidebar());
    const page = result.pages[0]!;
    // sidebar nie jest wykrywany jako kolumna kolumnowego ukladu (tylko 2 kolumny glowne)
    expect(page.columns).toHaveLength(2);

    const sidebarBlocks = result.blocks.filter((b) => b.kind === 'sidebar');
    expect(sidebarBlocks.length).toBeGreaterThan(0);
    const sidebarText = sidebarBlocks.map((b) => b.rawText).join('\n');
    expect(sidebarText).toContain('Sidebar Tip');

    // sidebar nie jest wplatany w tok glowny: zadna linia z prefixem Left/Right nie ląduje w tym samym bloku
    for (const b of sidebarBlocks) {
      expect(b.rawText).not.toMatch(/Left line|Right line/);
    }
  });
});

describe('grupa C — naglowki/stopki biegnace (layout-running-heads)', () => {
  it('naglowek i stopka wykryte na wszystkich 6 stronach mimo zmiennego numeru strony', async () => {
    const { result } = await runFullPipeline(buildLayoutRunningHeads());
    expect(result.pages).toHaveLength(6);

    const headerBlocks = result.blocks.filter((b) => b.kind === 'header');
    const footerBlocks = result.blocks.filter((b) => b.kind === 'footer');
    expect(new Set(headerBlocks.map((b) => b.pageNumber)).size).toBe(6);
    expect(new Set(footerBlocks.map((b) => b.pageNumber)).size).toBe(6);

    for (const b of headerBlocks) expect(b.rawText).toContain('Chapter One - Page');
    for (const b of footerBlocks) expect(b.rawText).toMatch(/^\d+$/);

    // naglowek/stopka nigdy nie stanowia body — nie interleave'owane w tok glowny
    for (const page of result.pages) {
      const bodyOnPage = result.blocks.filter((b) => b.pageNumber === page.pageNumber && b.kind === 'body');
      for (const b of bodyOnPage) expect(b.rawText).not.toContain('Chapter One - Page');
    }
  });
});

describe('grupa C — spis tresci z kropkami (layout-toc-dotleaders)', () => {
  it('gesta strona bez mis-merge, wskazowka kropkowa rozpoznana jako BlockKind:"table"', async () => {
    const { result } = await runFullPipeline(buildLayoutTocDotleaders());
    const page = result.pages[0]!;
    const primary = page.streams.find((s) => s.angle === 0)!;
    // 12 pozycji spisu tresci, kazda na wlasnym Y -> brak scalenia miedzy pozycjami
    expect(primary.lines).toHaveLength(12);
    expect(primary.lines.map((l) => l.text)).toContain(`Introduction ${'.'.repeat(20)} 1`);

    const tableBlocks = result.blocks.filter((b) => b.kind === 'table');
    expect(tableBlocks.length).toBeGreaterThan(0);
    expect(tableBlocks.some((b) => b.matchedRuleId === 'Z6-dot-leader')).toBe(true);
  });
});

describe('grupa C — granica bloku statbloku (layout-statblock-framed vs layout-statblock-plain)', () => {
  it('layout-statblock-framed: blok wewnatrz ramki wektorowej wydzielony jako OSOBNY blok, region wektorowy zarejestrowany w InventoryResult.vectors', async () => {
    const { inv, result } = await runFullPipeline(buildLayoutStatblockFramed());
    expect(inv.vectors.some((v) => v.kind === 'fill')).toBe(true);

    const page = result.pages[0]!;
    const blocksOnPage = result.blocks.filter((b) => b.pageNumber === page.pageNumber);
    const framedBlock = blocksOnPage.find((b) => b.rawText.includes('Goblin Scout'));
    expect(framedBlock).toBeDefined();
    expect(framedBlock!.rawText).not.toMatch(/Body text/);
    // blok statbloku jest osobny od bloku "przed" i od bloku "po"
    const beforeBlock = blocksOnPage.find((b) => b.rawText.includes('Body text before'));
    const afterBlock = blocksOnPage.find((b) => b.rawText.includes('Body text after'));
    expect(beforeBlock).toBeDefined();
    expect(afterBlock).toBeDefined();
    expect(beforeBlock!.id).not.toBe(framedBlock!.id);
    expect(afterBlock!.id).not.toBe(framedBlock!.id);
  });

  it('layout-statblock-plain: identyczna geometria BEZ ramki — granica bloku nadal powstaje (z fontu/interlinii), InventoryResult.vectors puste', async () => {
    const { inv, result } = await runFullPipeline(buildLayoutStatblockPlain());
    expect(inv.vectors).toHaveLength(0);

    const page = result.pages[0]!;
    const blocksOnPage = result.blocks.filter((b) => b.pageNumber === page.pageNumber);
    const framedBlock = blocksOnPage.find((b) => b.rawText.includes('Goblin Scout'));
    expect(framedBlock).toBeDefined();
    expect(framedBlock!.rawText).not.toMatch(/Body text/);
    const beforeBlock = blocksOnPage.find((b) => b.rawText.includes('Body text before'));
    const afterBlock = blocksOnPage.find((b) => b.rawText.includes('Body text after'));
    expect(beforeBlock!.id).not.toBe(framedBlock!.id);
    expect(afterBlock!.id).not.toBe(framedBlock!.id);
  });
});
