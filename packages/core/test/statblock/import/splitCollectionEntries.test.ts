import { describe, expect, it } from 'vitest';
import { splitCollectionEntries } from '../../../src/statblock/import/splitCollectionEntries.js';
import type { ExtractionBlock } from '../../../src/statblock/extract/types.js';
import { el } from './testHelpers.js';

const bbox = { minX: 0, minY: 0, maxX: 500, maxY: 500 };

function block(...elements: ReturnType<typeof el>[]): ExtractionBlock {
  return { bbox, elements };
}

function texts(blocks: ExtractionBlock[]): string[][] {
  return blocks.map((b) => b.elements.map((e) => e.text));
}

describe('splitCollectionEntries — repeatingLinePattern', () => {
  it('starts a new entry at each line matching entryBoundaryPattern, inclusive', () => {
    const b = block(el('1. Bite', 0, 100), el('Damage 5', 0, 90), el('2. Claw', 0, 80), el('Damage 3', 0, 70));
    const entries = splitCollectionEntries(b, { kind: 'repeatingLinePattern', entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true });
    expect(texts(entries)).toEqual([['1. Bite', 'Damage 5'], ['2. Claw', 'Damage 3']]);
  });

  it('with no entryBoundaryPattern, degrades to one entry per line', () => {
    const b = block(el('Bite', 0, 100), el('Claw', 0, 90));
    const entries = splitCollectionEntries(b, { kind: 'repeatingLinePattern' });
    expect(texts(entries)).toEqual([['Bite'], ['Claw']]);
  });

  it('groups leading lines before the first boundary match into their own leading entry, never dropping them', () => {
    const b = block(el('preamble', 0, 100), el('1. Bite', 0, 90), el('Damage 5', 0, 80));
    const entries = splitCollectionEntries(b, { kind: 'repeatingLinePattern', entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true });
    expect(texts(entries)).toEqual([['preamble'], ['1. Bite', 'Damage 5']]);
  });

  it('returns an empty list for an empty block', () => {
    expect(splitCollectionEntries(block(), { kind: 'repeatingLinePattern', entryBoundaryPattern: 'X' })).toEqual([]);
  });
});

describe('splitCollectionEntries — sectionHeaderThenEntries', () => {
  it('skips the header line and splits the remaining lines by entryBoundaryPattern', () => {
    const b = block(el('ATTACKS', 0, 100), el('1. Bite', 0, 90), el('Damage 5', 0, 80), el('2. Claw', 0, 70));
    const entries = splitCollectionEntries(b, { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: '^ATTACKS$', sectionHeaderIsRegex: true, entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true });
    expect(texts(entries)).toEqual([['1. Bite', 'Damage 5'], ['2. Claw']]);
  });

  it('with no sectionHeaderPattern, treats every line as content from the start (nothing to skip)', () => {
    const b = block(el('1. Bite', 0, 100), el('2. Claw', 0, 90));
    const entries = splitCollectionEntries(b, { kind: 'sectionHeaderThenEntries', entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true });
    expect(texts(entries)).toEqual([['1. Bite'], ['2. Claw']]);
  });

  it('returns an empty list when the header pattern never matches (nothing after a header that is not there)', () => {
    const b = block(el('some other text', 0, 100), el('more text', 0, 90));
    const entries = splitCollectionEntries(b, { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: '^ATTACKS$', sectionHeaderIsRegex: true, entryBoundaryPattern: '^\\d+\\.', entryBoundaryIsRegex: true });
    expect(entries).toEqual([]);
  });

  it('with no entryBoundaryPattern (but a header present), degrades to one entry per remaining line', () => {
    const b = block(el('ATTACKS', 0, 100), el('Bite', 0, 90), el('Claw', 0, 80));
    const entries = splitCollectionEntries(b, { kind: 'sectionHeaderThenEntries', sectionHeaderPattern: 'ATTACKS' });
    expect(texts(entries)).toEqual([['Bite'], ['Claw']]);
  });
});

describe('splitCollectionEntries — fixedDelimiter', () => {
  it('excludes delimiter lines from both the entry before and after them', () => {
    const b = block(el('Bite', 0, 100), el('---', 0, 90), el('Claw', 0, 80));
    const entries = splitCollectionEntries(b, { kind: 'fixedDelimiter', entryBoundaryPattern: '---', entryBoundaryIsRegex: false });
    expect(texts(entries)).toEqual([['Bite'], ['Claw']]);
  });

  it('with no entryBoundaryPattern, degrades to one entry per line, same as the other split kinds', () => {
    const b = block(el('Bite', 0, 100), el('Claw', 0, 90));
    const entries = splitCollectionEntries(b, { kind: 'fixedDelimiter' });
    expect(texts(entries)).toEqual([['Bite'], ['Claw']]);
  });

  it('a delimiter at the very start produces no leading empty entry', () => {
    const b = block(el('---', 0, 100), el('Bite', 0, 90));
    const entries = splitCollectionEntries(b, { kind: 'fixedDelimiter', entryBoundaryPattern: '---', entryBoundaryIsRegex: false });
    expect(texts(entries)).toEqual([['Bite']]);
  });
});
