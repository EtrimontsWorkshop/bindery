import { unionRect } from '../../geometry.js';
import { reconstructLines } from '../extract/reconstructLines.js';
import type { ExtractionBlock, ReconstructedLine } from '../extract/types.js';
import { matchesTextPattern } from '../pdf/matchAnchor.js';
import type { CollectionSplitRule } from '../profile/schema.js';

export interface CollectionSplitResult {
  entries: ExtractionBlock[];
  /**
   * Whether the collection's own text was located at all: the section heading of a `sectionHeaderThenEntries` rule, or
   * at least one entry for the other rules. A collection that was not located says nothing about what the Actor should
   * hold — the statblock may simply not print it, or the rule may not fit this book — and must not be read as "empty".
   */
  sectionFound: boolean;
}

/** The entries of a collection and whether its section was found — see `splitCollectionEntries` below for the rules. */
export function splitCollectionEntriesDetailed(block: ExtractionBlock, splitRule: CollectionSplitRule): CollectionSplitResult {
  const lines = reconstructLines(block.elements);

  let startIndex = 0;
  let endIndex = lines.length;
  let headerFound = true;
  if (splitRule.kind === 'sectionHeaderThenEntries' && splitRule.sectionHeaderPattern !== undefined) {
    const headerIndex = lines.findIndex((line) => matchesTextPattern(line.text, splitRule.sectionHeaderPattern!, splitRule.sectionHeaderIsRegex));
    headerFound = headerIndex !== -1;
    startIndex = headerFound ? headerIndex + 1 : lines.length;
    if (headerFound && splitRule.sectionEndPattern !== undefined) {
      const relativeEnd = lines.slice(startIndex).findIndex((line) => matchesTextPattern(line.text, splitRule.sectionEndPattern!, splitRule.sectionEndIsRegex));
      if (relativeEnd !== -1) endIndex = startIndex + relativeEnd;
    }
  }
  const entryLines = lines.slice(startIndex, endIndex);
  if (entryLines.length === 0) return { entries: [], sectionFound: splitRule.kind === 'sectionHeaderThenEntries' && headerFound };

  const groups = splitRule.kind === 'fixedDelimiter' ? groupByDelimiterLines(entryLines, splitRule.entryBoundaryPattern, splitRule.entryBoundaryIsRegex) : groupByBoundaryLines(entryLines, splitRule.entryBoundaryPattern, splitRule.entryBoundaryIsRegex);

  const entries = groups.map(linesToBlock);
  return { entries, sectionFound: entries.length > 0 };
}

/**
 * Splits a
 * collection's own already-located text span into one `ExtractionBlock` per
 * entry, using `reconstructLines` (reused rather than re-clustering
 * elements into rows here) as the atomic unit: every split kind below marks
 * boundaries at WHOLE LINES, never mid-line, since `PageTextElement`s are
 * already discrete tokens grouped into rows by that same pass.
 *
 * `sectionHeaderThenEntries` first skips past the line matching
 * `sectionHeaderPattern` (e.g. the "ATTACKS" heading itself never becomes
 * part of any entry) and stops at the first later line matching
 * `sectionEndPattern`, if there is one (the next heading, which belongs to no entry); `repeatingLinePattern` has no such heading to skip.
 * Both then delimit entries the same way: a line matching
 * `entryBoundaryPattern` STARTS a new entry (inclusive — e.g. "1. Bite" is
 * itself the first line of that entry). `fixedDelimiter` differs: a
 * matching line is a pure SEPARATOR (e.g. a horizontal rule between
 * entries) and is excluded from both the entry before and after it.
 *
 * Degradation, never a thrown error or a silently empty result: with no
 * `entryBoundaryPattern` configured at all, every line becomes its OWN
 * entry (the closest sane fallback: still splits into "something" rather
 * than treating the whole block as one entry, or none). Leading lines
 * before the FIRST boundary match (only possible for
 * `repeatingLinePattern`, since a header pattern already consumes any
 * preamble) become their own leading, likely-malformed entry rather than
 * being dropped — `import/extractInstance.ts`'s per-entry field extraction
 * naturally reports "nothing found" for it instead of losing it silently.
 */
export function splitCollectionEntries(block: ExtractionBlock, splitRule: CollectionSplitRule): ExtractionBlock[] {
  return splitCollectionEntriesDetailed(block, splitRule).entries;
}

function groupByBoundaryLines(lines: readonly ReconstructedLine[], pattern: string | undefined, isRegex: boolean | undefined): ReconstructedLine[][] {
  if (pattern === undefined) return lines.map((line) => [line]);
  const groups: ReconstructedLine[][] = [];
  let current: ReconstructedLine[] = [];
  for (const line of lines) {
    if (matchesTextPattern(line.text, pattern, isRegex) && current.length > 0) {
      groups.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function groupByDelimiterLines(lines: readonly ReconstructedLine[], pattern: string | undefined, isRegex: boolean | undefined): ReconstructedLine[][] {
  if (pattern === undefined) return lines.map((line) => [line]);
  const groups: ReconstructedLine[][] = [];
  let current: ReconstructedLine[] = [];
  for (const line of lines) {
    if (matchesTextPattern(line.text, pattern, isRegex)) {
      if (current.length > 0) groups.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function linesToBlock(lines: readonly ReconstructedLine[]): ExtractionBlock {
  return {
    bbox: lines.map((line) => line.bbox).reduce((a, b) => unionRect(a, b)),
    elements: lines.flatMap((line) => line.elements),
  };
}
