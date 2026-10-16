import { describe, expect, it } from 'vitest';
import { splitCollectionEntries, splitCollectionEntriesDetailed } from '../../../src/statblock/import/splitCollectionEntries.js';
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

describe('splitCollectionEntries — the end of a section', () => {
  const lines = (texts: string[]): ExtractionBlock => ({ bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: texts.map((t, i) => el(t, 10, 400 - i * 20)) });
  const rule = { kind: 'sectionHeaderThenEntries' as const, sectionHeaderPattern: 'ATTACKS' };

  it('without an end rule the section runs to the end of the statblock, as before', () => {
    const entries = splitCollectionEntries(lines(['ATTACKS', 'Bite', 'TRAITS', 'Darkvision']), rule);
    expect(entries.map((e) => e.elements[0]!.text)).toEqual(['Bite', 'TRAITS', 'Darkvision']);
  });

  it('stops at the line that ends the section, which belongs to no entry', () => {
    const entries = splitCollectionEntries(lines(['ATTACKS', 'Bite', 'TRAITS', 'Darkvision']), { ...rule, sectionEndPattern: 'TRAITS' });
    expect(entries.map((e) => e.elements[0]!.text)).toEqual(['Bite']);
  });

  it('accepts an end rule that is a regular expression, and an end that never comes', () => {
    const block = lines(['ATTACKS', 'Bite', 'Claw', 'TRAITS', 'Darkvision']);
    expect(splitCollectionEntries(block, { ...rule, sectionEndPattern: '^[A-Z]{4,}$', sectionEndIsRegex: true }).map((e) => e.elements[0]!.text)).toEqual(['Bite', 'Claw']);
    expect(splitCollectionEntries(block, { ...rule, sectionEndPattern: 'NOWHERE' })).toHaveLength(4);
  });
});

describe('splitCollectionEntriesDetailed — was the section found', () => {
  const lines = (texts: string[]): ExtractionBlock => ({ bbox: { minX: 0, minY: 0, maxX: 500, maxY: 500 }, elements: texts.map((t, i) => el(t, 10, 400 - i * 20)) });
  const rule = { kind: 'sectionHeaderThenEntries' as const, sectionHeaderPattern: 'ATTACKS' };

  it('a missing heading is a section that was not found, not an empty one', () => {
    expect(splitCollectionEntriesDetailed(lines(['Goblin', 'HP: 7']), rule)).toEqual({ entries: [], sectionFound: false });
  });

  it('a heading with nothing under it is a section that was found and is empty', () => {
    expect(splitCollectionEntriesDetailed(lines(['Goblin', 'ATTACKS']), rule)).toEqual({ entries: [], sectionFound: true });
    expect(splitCollectionEntriesDetailed(lines(['ATTACKS', 'TRAITS', 'Darkvision']), { ...rule, sectionEndPattern: 'TRAITS' })).toEqual({ entries: [], sectionFound: true });
  });

  it('a heading with entries is found', () => {
    const result = splitCollectionEntriesDetailed(lines(['ATTACKS', 'Bite']), rule);
    expect(result.sectionFound).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it('the other rules have found their section when they have entries', () => {
    const repeating = { kind: 'repeatingLinePattern' as const, entryBoundaryPattern: 'Attack' };
    expect(splitCollectionEntriesDetailed(lines(['Attack 1', 'Attack 2']), repeating).sectionFound).toBe(true);
    expect(splitCollectionEntriesDetailed(lines([]), repeating)).toEqual({ entries: [], sectionFound: false });
  });
});
