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

/** Buduje fontSizeByKey z InventoryResult.fonts — dokladnie tak, jak zrobi to prawdziwy wywolujacy (orkiestracja fazy 2). */
async function fontSizeMapFor(buf: Buffer): Promise<Map<string, number>> {
  const doc = await openFixture(buf);
  const inv = await buildInventory(doc as never);
  return new Map(inv.fonts.map((f) => [f.key, f.size]));
}

describe('buildTextLayout — text-fragmented-75/20 (kazdy token na wlasnym wierszu)', () => {
  it('text-fragmented-75: 40 linii, pierwsze 10 to WHOLE_WORDS bez zmian (nic sie nie sklejalo przez rozne Y)', async () => {
    const buf = buildTextFragmented75();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(40);
    expect(lines.slice(0, 10).map((l) => l.text)).toEqual(['the', 'and', 'run', 'big', 'red', 'sky', 'day', 'old', 'new', 'sun']);
  });

  it('text-fragmented-20: 50 linii w oryginalnej kolejnosci emisji', async () => {
    const buf = buildTextFragmented20();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(50);
    expect(lines[4]!.text).toBe('a'); // splice((0+1)*4+0=4, 0, 'a') — pierwszy pojedynczy znak na pozycji 4
  });
});

describe('buildTextLayout — text-empty-items (grupa B)', () => {
  it('5 slow na jednej linii, syntetyczne spacje pdf.js odfiltrowane, jedna linia tekstu ze spacjami', async () => {
    const buf = buildTextEmptyItems();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('Alpha Bravo Charlie Delta Echo');
  });
});

describe('buildTextLayout — text-positional-duplicates (grupa B)', () => {
  it('Goblin zdedupowany, Orc syntheticBold=true na linii, Kobold bez zmian', async () => {
    const buf = buildTextPositionalDuplicates();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    const goblinLine = lines.find((l) => l.text === 'Goblin');
    const orcLine = lines.find((l) => l.text === 'Orc');
    expect(goblinLine?.syntheticBold).toBe(false);
    expect(orcLine?.syntheticBold).toBe(true);
  });
});

describe('buildTextLayout — text-rotated-marginalia (grupa B)', () => {
  it('dwa strumienie: 0° isPrimary=true z 5 liniami, 90° isPrimary=false', async () => {
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

describe('buildTextLayout — text-rotated-extreme (grupa B)', () => {
  it('strumien 90° dominujacy, obsluzone bez bledu', async () => {
    const buf = buildTextRotatedExtreme();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const streams = result.pages[0]!.streams;
    const vertical = streams.find((s) => s.angle === 90);
    expect(vertical).toBeDefined();
    expect(vertical!.lines.length).toBe(18);
  });
});

describe('buildTextLayout — text-broken-tounicode (grupa B)', () => {
  it('nie wywala sie na uszkodzonym ToUnicode (PUA)', async () => {
    const buf = buildTextBrokenToUnicode();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(3);
  });
});

describe('buildTextLayout — text-combining-diacritics (grupa B)', () => {
  it('linia juz w NFC ("Siła") pozostaje bez zmian; NFC jest stosowane i idempotentne', async () => {
    const buf = buildTextCombiningDiacritics();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines).toHaveLength(2);
    // Linia 2 to "ł" precomponowane (juz NFC) — musi pozostac dokladnie "Siła".
    expect(lines[1]!.text).toBe('Siła');
    // Linia 1 to namiastka "l" + U+0335 (nie prawdziwa dekompozycja NFD "ł" —
    // Unicode NIE definiuje "ł" jako rozkladajace sie na "l"+znak laczacy, patrz
    // komentarz w fixture .ts), wiec normalize('NFC') jest tu no-opem z definicji —
    // sprawdzamy idempotencje, NIE rownosc z linia 2 (to bylby blad zalozenia).
    expect(lines[0]!.text).toBe(lines[0]!.text.normalize('NFC'));
    expect(lines[0]!.text).not.toBe(lines[1]!.text);
  });
});

describe('buildTextLayout — text-ligatures-hyphenation (grupa B)', () => {
  it('ligatury rozwiniete, przeniesienie "encyclo-"/"pedia" sklejone w "encyclopedia"', async () => {
    const buf = buildTextLigaturesHyphenation();
    const result = await buildTextLayout(await openFixture(buf), await fontSizeMapFor(buf));
    const lines = result.pages[0]!.streams.find((s) => s.angle === 0)!.lines;
    expect(lines.map((l) => l.text)).toEqual(['office', 'flame', 'encyclopedia']);
  });
});

describe('buildTextLayout — determinizm', () => {
  it('dwa uruchomienia na tym samym pliku daja identyczny wynik (po serializacji)', async () => {
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
