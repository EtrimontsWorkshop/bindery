import { describe, expect, it } from 'vitest';
import { clusterIntoLines } from '../../src/layout/lineCluster.js';
import type { MergedToken } from '../../src/layout/wordMerge.js';
import type { WordBoundary } from '../../src/text/types.js';

function token(str: string, x: number, y: number, opts: Partial<MergedToken> = {}): MergedToken {
  const size = opts.height ?? 12;
  return {
    str,
    transform: opts.transform ?? [size, 0, 0, size, x, y],
    width: opts.width ?? str.length * (size * 0.5),
    height: size,
    fontKey: opts.fontKey ?? 'Body@12',
    fontName: opts.fontName ?? 'F1',
    syntheticBold: opts.syntheticBold ?? false,
    sourceIndices: opts.sourceIndices ?? [x], // unikalny placeholder wystarczajacy do testow
    mergeReason: opts.mergeReason ?? 'no-merge',
  };
}

describe('clusterIntoLines — grupowanie po cross-axis', () => {
  it('dwa tokeny na tej samej linii bazowej (ta sama Y) tworza jedna linie', () => {
    const tokens = [token('the', 72, 700), token('cat', 100, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
  });

  it('tokeny na znaczaco roznych Y tworza dwie osobne linie', () => {
    const tokens = [token('Line', 72, 700), token('Two', 72, 650)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
  });

  it('kolejnosc czytania: linie posortowane od gory (malejace Y) dla strumienia 0°', () => {
    const tokens = [token('Second', 72, 650), token('First', 72, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.crossAxisPosition).toBe(700);
    expect(lines[1]!.crossAxisPosition).toBe(650);
  });
});

describe('clusterIntoLines — indeksy gorne/dolne', () => {
  it('token mniejszego rozmiaru przesuniety mniej niz interlinia trafia do TEJ SAMEJ linii', () => {
    // font 12pt, indeks gorny 6pt (0.5x), przesuniety w gore o 5pt (< 12*1.35=16.2 interlinii)
    const tokens = [token('x', 72, 700, { height: 12 }), token('2', 100, 705, { height: 6, fontKey: 'Small@6' })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
  });

  it('token mniejszego rozmiaru przesuniety WIECEJ niz interlinia NIE trafia do tej samej linii (to nastepna linia, nie indeks)', () => {
    const tokens = [token('Body', 72, 700, { height: 12 }), token('Footnote', 72, 660, { height: 8, fontKey: 'Small@8' })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
  });
});

describe('clusterIntoLines — sklad tekstu z granicami wyrazow', () => {
  it('wstawia spacje TYLKO tam gdzie byla prawdziwa granica wyrazu', () => {
    const tokens = [
      token('the', 72, 700, { sourceIndices: [0] }),
      token('cat', 100, 700, { sourceIndices: [2] }),
    ];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 90, gapEnd: 100 }];
    const lines = clusterIntoLines(tokens, 0, boundaries, 1);
    expect(lines[0]!.text).toBe('the cat');
  });

  it('brak granicy miedzy tokenami -> sklejone bez spacji', () => {
    const tokens = [
      token('of', 72, 700, { sourceIndices: [0] }),
      token('fice', 90, 700, { sourceIndices: [1] }),
    ];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.text).toBe('office');
  });
});

describe('clusterIntoLines — fonts i dominantFont', () => {
  it('linia z dwoma fontami raportuje oba w fonts[], dominantFont = najwiekszy udzial znakow', () => {
    const tokens = [
      token('short', 72, 700, { fontKey: 'A@12', height: 12, sourceIndices: [0] }),
      token('muchlongertext', 130, 700, { fontKey: 'B@12', height: 12, sourceIndices: [1] }),
    ];
    // Zmiana fontu w polowie linii ma zwykle realna spacje miedzy sobą — granica
    // pdf.js potwierdza, ze to wciaz JEDNA linia mimo odstepu wiekszego niz tracking (KROK-6).
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 102, gapEnd: 130 }];
    const lines = clusterIntoLines(tokens, 0, boundaries, 1);
    expect(lines[0]!.fonts.map((f) => f.key).sort()).toEqual(['A@12', 'B@12']);
    expect(lines[0]!.dominantFont.key).toBe('B@12');
  });
});

describe('clusterIntoLines — sklejanie przeniesienia lacznikiem (koniec Z5)', () => {
  it('linia konczaca sie "-" + kontynuacja mala litera -> sklejone w jedno slowo', () => {
    const tokens = [token('encyclo-', 72, 700, { sourceIndices: [0] }), token('pedia', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('encyclopedia');
  });

  it('kontynuacja zaczynajaca sie WIELKA litera NIE jest sklejana (prawdziwy myslnik w tytule)', () => {
    const tokens = [token('Chapter One-', 72, 700, { sourceIndices: [0] }), token('Two', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe('Chapter One-');
    expect(lines[1]!.text).toBe('Two');
  });
});

describe('clusterIntoLines — [KROK-10] TextLine.tokens', () => {
  it('kazdy token oryginalny zachowany z wlasnym bboxem i tekstem, posortowany wzdluz osi czytania', () => {
    const tokens = [token('cat', 100, 700), token('the', 72, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.tokens).toHaveLength(2);
    expect(lines[0]!.tokens!.map((t) => t.text)).toEqual(['the', 'cat']); // posortowane po X (along), nie po kolejnosci wejscia
    expect(lines[0]!.tokens![0]!.bbox.minX).toBe(72);
    expect(lines[0]!.tokens![1]!.bbox.minX).toBe(100);
  });

  it('sklejenie przeniesienia lacznikiem zachowuje tokeny OBU linii razem', () => {
    const tokens = [token('encyclo-', 72, 700, { sourceIndices: [0] }), token('pedia', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.tokens).toHaveLength(2);
    expect(lines[0]!.tokens!.map((t) => t.text)).toEqual(['encyclo-', 'pedia']);
  });
});
