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
    sourceIndices: opts.sourceIndices ?? [x], // a unique placeholder sufficient for tests
    mergeReason: opts.mergeReason ?? 'no-merge',
  };
}

describe('clusterIntoLines — grouping by cross-axis', () => {
  it('two tokens on the same baseline (the same Y) form one line', () => {
    const tokens = [token('the', 72, 700), token('cat', 100, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
  });

  it('tokens on significantly different Y form two separate lines', () => {
    const tokens = [token('Line', 72, 700), token('Two', 72, 650)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
  });

  it('reading order: lines sorted from the top (descending Y) for the 0° stream', () => {
    const tokens = [token('Second', 72, 650), token('First', 72, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.crossAxisPosition).toBe(700);
    expect(lines[1]!.crossAxisPosition).toBe(650);
  });
});

describe('clusterIntoLines — superscripts/subscripts', () => {
  it('a smaller-size token shifted less than the line spacing ends up in THE SAME line', () => {
    // font 12pt, a superscript of 6pt (0.5x), shifted up by 5pt (< 12*1.35=16.2 of line spacing)
    const tokens = [token('x', 72, 700, { height: 12 }), token('2', 100, 705, { height: 6, fontKey: 'Small@6' })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
  });

  it('a smaller-size token shifted MORE than the line spacing does NOT end up in the same line (it is the next line, not a superscript)', () => {
    const tokens = [token('Body', 72, 700, { height: 12 }), token('Footnote', 72, 660, { height: 8, fontKey: 'Small@8' })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
  });
});

describe('clusterIntoLines — text composition with word boundaries', () => {
  it('inserts a space ONLY where there was a real word boundary', () => {
    const tokens = [
      token('the', 72, 700, { sourceIndices: [0] }),
      token('cat', 100, 700, { sourceIndices: [2] }),
    ];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 90, gapEnd: 100 }];
    const lines = clusterIntoLines(tokens, 0, boundaries, 1);
    expect(lines[0]!.text).toBe('the cat');
  });

  it('no boundary between tokens -> joined without a space', () => {
    const tokens = [
      token('of', 72, 700, { sourceIndices: [0] }),
      token('fice', 90, 700, { sourceIndices: [1] }),
    ];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.text).toBe('office');
  });
});

describe('clusterIntoLines — fonts i dominantFont', () => {
  it('a line with two fonts reports both in fonts[], dominantFont = the largest share of characters', () => {
    const tokens = [
      token('short', 72, 700, { fontKey: 'A@12', height: 12, sourceIndices: [0] }),
      token('muchlongertext', 130, 700, { fontKey: 'B@12', height: 12, sourceIndices: [1] }),
    ];
    // A font change in the middle of a line usually has a real space between the parts — the pdf.js
    // boundary confirms it is still ONE line despite a gap larger than the tracking.
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 102, gapEnd: 130 }];
    const lines = clusterIntoLines(tokens, 0, boundaries, 1);
    expect(lines[0]!.fonts.map((f) => f.key).sort()).toEqual(['A@12', 'B@12']);
    expect(lines[0]!.dominantFont.key).toBe('B@12');
  });
});

describe('clusterIntoLines — joining a hyphenation break (the end of line clustering)', () => {
  it('a line ending with "-" + a lowercase continuation -> joined into one word', () => {
    const tokens = [token('encyclo-', 72, 700, { sourceIndices: [0] }), token('pedia', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('encyclopedia');
  });

  it('a continuation starting with a CAPITAL letter is NOT joined (a real hyphen in a title)', () => {
    const tokens = [token('Chapter One-', 72, 700, { sourceIndices: [0] }), token('Two', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe('Chapter One-');
    expect(lines[1]!.text).toBe('Two');
  });
});

describe('clusterIntoLines — TextLine.tokens', () => {
  it('every original token kept with its own bbox and text, sorted along the reading axis', () => {
    const tokens = [token('cat', 100, 700), token('the', 72, 700)];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.tokens).toHaveLength(2);
    expect(lines[0]!.tokens!.map((t) => t.text)).toEqual(['the', 'cat']); // sorted by X (along), not by input order
    expect(lines[0]!.tokens![0]!.bbox.minX).toBe(72);
    expect(lines[0]!.tokens![1]!.bbox.minX).toBe(100);
  });

  it('joining a hyphenation break keeps the tokens of BOTH lines together', () => {
    const tokens = [token('encyclo-', 72, 700, { sourceIndices: [0] }), token('pedia', 72, 680, { sourceIndices: [1] })];
    const lines = clusterIntoLines(tokens, 0, [], 1);
    expect(lines[0]!.tokens).toHaveLength(2);
    expect(lines[0]!.tokens!.map((t) => t.text)).toEqual(['encyclo-', 'pedia']);
  });
});
