import { describe, expect, it } from 'vitest';
import {
  assignHeadingLevels,
  buildJournalDrafts,
  headingsToMarkers,
  outlineToMarkers,
} from '../../src/cif/buildJournalHierarchy.js';
import type { ResolvedOutlineNode } from '../../src/cif/outline.js';
import type { BlockKind, SemanticBlock } from '../../src/semantic/blockBuilder.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

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

describe('assignHeadingLevels', () => {
  it('ranguje rozmiary fontow naglowkow malejaco -> poziomy 1..N', () => {
    const blocks = [
      block('h1', 'heading', 'Wielki tytul', 1, 24),
      block('h2', 'heading', 'Sredni tytul', 2, 18),
      block('h3', 'heading', 'Maly tytul', 3, 14),
    ];
    const levels = assignHeadingLevels(blocks);
    expect(levels.get('h1')).toBe(1);
    expect(levels.get('h2')).toBe(2);
    expect(levels.get('h3')).toBe(3);
  });

  it('ten sam rozmiar fontu -> ten sam poziom', () => {
    const blocks = [block('a', 'heading', 'A', 1, 18), block('b', 'heading', 'B', 2, 18)];
    const levels = assignHeadingLevels(blocks);
    expect(levels.get('a')).toBe(levels.get('b'));
  });

  it('wiecej niz 6 odrebnych rozmiarow -> przycina do poziomu 6 (Foundry title.level max 6)', () => {
    const blocks = Array.from({ length: 8 }, (_, i) => block(`h${i}`, 'heading', `T${i}`, i + 1, 30 - i));
    const levels = assignHeadingLevels(blocks);
    expect(levels.get('h7')).toBe(6);
    expect(levels.get('h6')).toBe(6);
    expect(levels.get('h5')).toBe(6);
  });

  it('brak blokow heading -> pusta mapa', () => {
    const blocks = [block('b0', 'body', 'Tresc', 1)];
    expect(assignHeadingLevels(blocks).size).toBe(0);
  });
});

describe('headingsToMarkers (Z4b fallback)', () => {
  it('generuje znacznik dla kazdego bloku heading, z poziomem z rankingu rozmiaru', () => {
    const blocks = [
      block('h0', 'heading', 'Rozdzial 1', 1, 24),
      block('b0', 'body', 'Tresc', 1),
      block('h1', 'heading', 'Sekcja 1.1', 2, 14),
    ];
    const markers = headingsToMarkers(blocks);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ title: 'Rozdzial 1', level: 1, startBlockIndex: 0 });
    expect(markers[1]).toMatchObject({ title: 'Sekcja 1.1', level: 2, startBlockIndex: 2 });
  });

  it('brak zadnego naglowka w calym dokumencie -> []', () => {
    const blocks = [block('b0', 'body', 'Tresc bez naglowkow', 1)];
    expect(headingsToMarkers(blocks)).toEqual([]);
  });
});

describe('outlineToMarkers', () => {
  it('mapuje numer strony zakladki na indeks PIERWSZEGO bloku tej lub pozniejszej strony', () => {
    const blocks = [block('b0', 'body', 'str1', 1), block('b1', 'body', 'str2', 2), block('b2', 'body', 'str3', 3)];
    const outline: ResolvedOutlineNode[] = [{ title: 'Rozdzial', pageNumber: 2, depth: 1, children: [] }];
    const markers = outlineToMarkers(outline, blocks);
    expect(markers).toEqual([{ title: 'Rozdzial', level: 1, startBlockIndex: 1 }]);
  });

  it('zakladka na strone BEZ zadnego bloku (np. mapa) -> pierwszy DOSTEPNY nastepny blok (degradacja A7)', () => {
    const blocks = [block('b0', 'body', 'str1', 1), block('b1', 'body', 'str3', 3)];
    const outline: ResolvedOutlineNode[] = [{ title: 'Rozdzial na str 2', pageNumber: 2, depth: 1, children: [] }];
    const markers = outlineToMarkers(outline, blocks);
    expect(markers[0]!.startBlockIndex).toBe(1); // pierwszy blok >= strona 2 to b1 (str 3)
  });

  it('zakladka bez rozwiazanego numeru strony (pageNumber null) jest pomijana, nie failuje', () => {
    const blocks = [block('b0', 'body', 'str1', 1)];
    const outline: ResolvedOutlineNode[] = [
      { title: 'Link zewnetrzny', pageNumber: null, depth: 1, children: [] },
      { title: 'Prawdziwy rozdzial', pageNumber: 1, depth: 1, children: [] },
    ];
    const markers = outlineToMarkers(outline, blocks);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.title).toBe('Prawdziwy rozdzial');
  });
});

describe('buildJournalDrafts', () => {
  it('brak blokow -> []', () => {
    expect(buildJournalDrafts([], [], 'Plik')).toEqual([]);
  });

  it('brak znacznikow (fallback ostateczny) -> JEDEN journal, JEDNA strona z WSZYSTKIMI blokami', () => {
    const blocks = [block('b0', 'body', 'a', 1), block('b1', 'body', 'b', 2)];
    const drafts = buildJournalDrafts(blocks, [], 'Moj Plik');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe('Moj Plik');
    expect(drafts[0]!.pages).toHaveLength(1);
    expect(drafts[0]!.pages[0]!.blocks).toHaveLength(2);
  });

  it('outline plaski (glebokosc 1, jak CP-RED) -> N journali, kazdy z JEDNA strona', () => {
    const blocks = [
      block('h0', 'heading', 'Wprowadzenie', 1),
      block('b0', 'body', 'tresc 1', 1),
      block('h1', 'heading', 'Rozdzial 2', 3),
      block('b1', 'body', 'tresc 2', 3),
    ];
    const markers = [
      { title: 'Wprowadzenie', level: 1, startBlockIndex: 0 },
      { title: 'Rozdzial 2', level: 1, startBlockIndex: 2 },
    ];
    const drafts = buildJournalDrafts(blocks, markers, 'Plik');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.title).toBe('Wprowadzenie');
    expect(drafts[0]!.pages).toHaveLength(1);
    expect(drafts[0]!.pages[0]!.blocks.map((b) => b.id)).toEqual(['h0', 'b0']);
    expect(drafts[1]!.title).toBe('Rozdzial 2');
    expect(drafts[1]!.pages[0]!.blocks.map((b) => b.id)).toEqual(['h1', 'b1']);
  });

  it('dwupoziomowa hierarchia (poziom 1 = journal, poziom 2 = strona)', () => {
    const blocks = [
      block('h0', 'heading', 'Czesc I', 1),
      block('h1', 'heading', 'Rozdzial 1', 1),
      block('b0', 'body', 'tresc rozdzialu 1', 1),
      block('h2', 'heading', 'Rozdzial 2', 2),
      block('b1', 'body', 'tresc rozdzialu 2', 2),
    ];
    const markers = [
      { title: 'Czesc I', level: 1, startBlockIndex: 0 },
      { title: 'Rozdzial 1', level: 2, startBlockIndex: 1 },
      { title: 'Rozdzial 2', level: 2, startBlockIndex: 3 },
    ];
    const drafts = buildJournalDrafts(blocks, markers, 'Plik');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe('Czesc I');
    expect(drafts[0]!.pages).toHaveLength(2);
    expect(drafts[0]!.pages[0]!.title).toBe('Rozdzial 1');
    expect(drafts[0]!.pages[1]!.title).toBe('Rozdzial 2');
  });

  it('glebokosc >2 (poziom 3+) NIE tworzy kolejnej struktury — zostaje w blokach strony (Foundry: tylko 2 poziomy)', () => {
    const blocks = [
      block('h0', 'heading', 'Rozdzial 1', 1),
      block('h1', 'heading', 'Podsekcja 1.1', 1), // poziom 3, w tym samym bloku strony
      block('b0', 'body', 'tresc', 1),
    ];
    const markers = [
      { title: 'Rozdzial 1', level: 1, startBlockIndex: 0 },
      { title: 'Podsekcja 1.1', level: 3, startBlockIndex: 1 },
    ];
    const drafts = buildJournalDrafts(blocks, markers, 'Plik');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.pages).toHaveLength(1); // NIE 2 — poziom 3 nie tworzy strony
    expect(drafts[0]!.pages[0]!.blocks.map((b) => b.id)).toEqual(['h0', 'h1', 'b0']);
  });

  it('bloki PRZED pierwszym znacznikiem journala (np. strona tytulowa bez zakladki) nie gina (A3)', () => {
    const blocks = [block('preface', 'body', 'Strona tytulowa', 1), block('h0', 'heading', 'Rozdzial 1', 2), block('b0', 'body', 'tresc', 2)];
    const markers = [{ title: 'Rozdzial 1', level: 1, startBlockIndex: 1 }];
    const drafts = buildJournalDrafts(blocks, markers, 'Plik');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.pages[0]!.blocks.map((b) => b.id)).toEqual(['preface']);
    expect(drafts[1]!.title).toBe('Rozdzial 1');
  });
});
