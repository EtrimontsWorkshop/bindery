import { describe, expect, it } from 'vitest';
import { buildCIFDocument } from '../../src/cif/buildCIFDocument.js';
import type { ResolvedOutlineNode } from '../../src/cif/outline.js';
import type { BlockKind, SemanticBlock } from '../../src/semantic/blockBuilder.js';
import type { TextLine } from '../../src/layout/lineCluster.js';
import type { FinalizedImage } from '../../src/images/finalize.js';
import type { EncodedImage } from '../../src/images/encodeImage.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';

function line(text: string, fontKey = 'Body@10', size = 10): TextLine {
  return {
    id: `l-${text}`,
    text,
    bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 },
    columnIndex: 0,
    crossAxisPosition: 700,
    fonts: [{ key: fontKey, size }],
    dominantFont: { key: fontKey, size },
    syntheticBold: false,
  };
}

function block(id: string, kind: BlockKind, rawText: string, pageNumber: number, fontSize = 10): SemanticBlock {
  return {
    id,
    kind,
    confidence: 0.8,
    pageNumber,
    bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 },
    angle: 0,
    lines: [line(rawText, kind === 'heading' ? `Heading@${fontSize}` : 'Body@10', fontSize)],
    rawText,
  };
}

function finalizedImage(objId: string, page: number, overrides: Partial<ImageEntry> = {}): FinalizedImage<EncodedImage> {
  const entry: ImageEntry = {
    objId,
    occurrences: [{ page, bbox: { minX: 100, minY: 400, maxX: 300, maxY: 600 }, index: 0 }],
    pageRefs: [page],
    maxRelativeArea: 0.3,
    isMaskLayer: false,
    maskEvidence: null,
    ...overrides,
  };
  return {
    entry,
    classification: 'content',
    confidence: 0.9,
    extractSource: 'direct',
    contentHash: `hash-${objId}`,
    width: 800,
    height: 600,
    targetKind: 'handout',
    payload: { format: 'webp', bytes: new Uint8Array([1, 2, 3]) },
  };
}

describe('buildCIFDocument', () => {
  it('caly dokument bez zakladek i bez naglowkow -> jeden journal, jedna strona, nic nie ginie (A3)', () => {
    const blocks = [block('b0', 'body', 'Jedyny akapit calego dokumentu', 1)];
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'abc123',
      pageCount: 1,
      blocks,
      outline: [],
      images: [],
      diagnostics: [],
    });
    expect(document.schemaVersion).toBe(1);
    expect(document.journals).toHaveLength(1);
    expect(document.journals[0]!.name).toBe('plik.pdf');
    expect(document.journals[0]!.pages).toHaveLength(1);
    expect(document.journals[0]!.pages[0]!.html).toContain('Jedyny akapit calego dokumentu');
  });

  it('KAZDY CIFJournal, CIFJournalPage i CIFImage ma niepuste provenance i (gdzie oczekiwane) rawText — DoD', () => {
    const blocks = [
      block('h0', 'heading', 'Rozdzial 1', 1, 20),
      block('b0', 'body', 'Tresc rozdzialu pierwszego', 1),
      block('h1', 'heading', 'Rozdzial 2', 2, 20),
      block('b1', 'body', 'Tresc rozdzialu drugiego', 2),
    ];
    const outline: ResolvedOutlineNode[] = [
      { title: 'Rozdzial 1', pageNumber: 1, depth: 1, children: [] },
      { title: 'Rozdzial 2', pageNumber: 2, depth: 1, children: [] },
    ];
    const images = [finalizedImage('img1', 2)];
    const { document, imageBytesById } = buildCIFDocument({
      fileName: 'ksiazka.pdf',
      fileHash: 'hash',
      pageCount: 2,
      blocks,
      outline,
      images,
      diagnostics: [],
    });

    expect(document.journals.length).toBeGreaterThan(0);
    for (const journal of document.journals) {
      expect(journal.provenance.blockIds.length).toBeGreaterThan(0);
      expect(journal.rawText.length).toBeGreaterThan(0);
      for (const page of journal.pages) {
        expect(page.provenance.pageNumber).toBeGreaterThan(0);
        expect(page.provenance.blockIds.length).toBeGreaterThan(0);
        expect(page.rawText.length).toBeGreaterThan(0);
      }
    }
    expect(document.images).toHaveLength(1);
    for (const img of document.images) {
      expect(img.provenance.pageNumber).toBeGreaterThan(0);
      expect(img.provenance.bbox).toBeDefined();
      expect(typeof img.rawText).toBe('string'); // ZAWSZE string (moze byc pusty, ale nigdy undefined — A3)
    }
    expect(imageBytesById.get('img1')).toBeDefined();
    expect(imageBytesById.get('img1')!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('obraz osadzony w tresci strony (imageRefs + <figure> w html)', () => {
    const blocks = [block('b0', 'body', 'Tekst przed obrazkiem', 2, 10)];
    const images = [finalizedImage('img1', 2)];
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'h',
      pageCount: 2,
      blocks,
      outline: [],
      images,
      diagnostics: [],
    });
    const page = document.journals[0]!.pages[0]!;
    expect(page.imageRefs).toContain('img1');
    expect(page.html).toContain('<figure>');
    expect(page.html).toContain('src="img1"'); // placeholder = wlasne id, podmieniane pozniej przez warstwe Foundry
  });

  it('[regresja] obraz NIE wycieka na strony journala, do ktorych fizycznie nie nalezy', () => {
    const blocks = [
      block('h0', 'heading', 'Rozdzial 1', 1, 20),
      block('b0', 'body', 'tresc rozdzialu 1', 1),
      block('h1', 'heading', 'Rozdzial 2', 2, 20),
      block('b1', 'body', 'tresc rozdzialu 2 BEZ obrazka', 2),
    ];
    const outline: ResolvedOutlineNode[] = [
      { title: 'Rozdzial 1', pageNumber: 1, depth: 1, children: [] },
      { title: 'Rozdzial 2', pageNumber: 2, depth: 1, children: [] },
    ];
    const images = [finalizedImage('img-strona-1', 1)];
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'h',
      pageCount: 2,
      blocks,
      outline,
      images,
      diagnostics: [],
    });
    const journal1 = document.journals.find((j) => j.name === 'Rozdzial 1')!;
    const journal2 = document.journals.find((j) => j.name === 'Rozdzial 2')!;
    expect(journal1.pages[0]!.imageRefs).toEqual(['img-strona-1']);
    expect(journal2.pages[0]!.imageRefs).toEqual([]);
    expect(journal2.pages[0]!.html).not.toContain('<figure>');
  });

  it('obrazy decoration/mask NIE trafiaja do CIFImage[]', () => {
    const contentImg = finalizedImage('img-content', 1);
    const decorationImg = { ...finalizedImage('img-decoration', 1), classification: 'decoration' as const };
    const maskImg = { ...finalizedImage('img-mask', 1), classification: 'mask' as const };
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'h',
      pageCount: 1,
      blocks: [block('b0', 'body', 'tresc', 1)],
      outline: [],
      images: [contentImg, decorationImg, maskImg],
      diagnostics: [],
    });
    expect(document.images.map((i) => i.id)).toEqual(['img-content']);
  });

  it('[KROK-11 Z4] obrazy undecided TRAFIAJA do CIFImage[] (ekran przegladu musi je zobaczyc), z zachowanymi classification/confidence', () => {
    const contentImg = { ...finalizedImage('img-content', 1), confidence: 0.9 };
    const undecidedImg = { ...finalizedImage('img-undecided', 1), classification: 'undecided' as const, confidence: 0.2 };
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'h',
      pageCount: 1,
      blocks: [block('b0', 'body', 'tresc', 1)],
      outline: [],
      images: [contentImg, undecidedImg],
      diagnostics: [],
    });
    expect(document.images.map((i) => i.id).sort()).toEqual(['img-content', 'img-undecided']);
    const found = document.images.find((i) => i.id === 'img-undecided')!;
    expect(found.classification).toBe('undecided');
    expect(found.confidence).toBe(0.2);
    const contentFound = document.images.find((i) => i.id === 'img-content')!;
    expect(contentFound.classification).toBe('content');
    expect(contentFound.confidence).toBe(0.9);
  });

  it('diagnostics przekazane wprost bez zmian (zbierane po drodze przez wywolujacego)', () => {
    const { document } = buildCIFDocument({
      fileName: 'plik.pdf',
      fileHash: 'h',
      pageCount: 1,
      blocks: [block('b0', 'body', 'tresc', 1)],
      outline: [],
      images: [],
      diagnostics: [{ severity: 'warning', code: 'TEST_CODE', params: { detail: 'test' } }],
    });
    expect(document.diagnostics).toEqual([{ severity: 'warning', code: 'TEST_CODE', params: { detail: 'test' } }]);
  });

  it('schemaVersion zawsze 1, source wypelniony z inputu', () => {
    const { document } = buildCIFDocument({
      fileName: 'moj-plik.pdf',
      fileHash: 'deadbeef',
      pageCount: 42,
      detectedLanguage: 'pl',
      blocks: [block('b0', 'body', 'tresc', 1)],
      outline: [],
      images: [],
      diagnostics: [],
    });
    expect(document.schemaVersion).toBe(1);
    expect(document.source.fileName).toBe('moj-plik.pdf');
    expect(document.source.fileHash).toBe('deadbeef');
    expect(document.source.pageCount).toBe(42);
    expect(document.source.detectedLanguage).toBe('pl');
    expect(document.source.detectedProfileId).toBeNull();
    expect(() => new Date(document.source.extractedAt).toISOString()).not.toThrow();
  });
});
