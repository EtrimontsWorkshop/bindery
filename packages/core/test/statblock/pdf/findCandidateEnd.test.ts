import { describe, expect, it } from 'vitest';
import { findCandidateEnd } from '../../../src/statblock/pdf/findCandidateEnd.js';
import { buildStatblockReadingOrder } from '../../../src/statblock/pdf/readingOrder.js';
import { el, page } from './testHelpers.js';

function order(elements: ReturnType<typeof el>[], columns?: { minX: number; minY: number; maxX: number; maxY: number }[]) {
  return buildStatblockReadingOrder([page(1, elements, columns ? { columns } : {})]);
}

describe('findCandidateEnd — nextAnchor', () => {
  it('ends right before the next anchor', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 90), el('Orc', 0, 80)]);
    const end = findCandidateEnd(ro, 0, 2, { kind: 'nextAnchor' });
    expect(end).toBe(2);
  });

  it('with no next anchor, runs to the end of the reading order', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 90)]);
    const end = findCandidateEnd(ro, 0, null, { kind: 'nextAnchor' });
    expect(end).toBe(2);
  });
});

describe('findCandidateEnd — endOfColumnOrPage', () => {
  it('stops at the bottom of the current column even with no next anchor', () => {
    const columns = [
      { minX: 0, minY: 0, maxX: 280, maxY: 800 },
      { minX: 300, minY: 0, maxX: 600, maxY: 800 },
    ];
    const ro = order([el('Goblin', 10, 100), el('HP: 7', 10, 90), el('Orc', 310, 100)], columns);
    // index 0 = Goblin (col 0), 1 = HP:7 (col 0), 2 = Orc (col 1)
    const end = findCandidateEnd(ro, 0, null, { kind: 'endOfColumnOrPage' });
    expect(end).toBe(2); // stops before crossing into column 1
  });

  it('the next anchor still caps it even tighter, if it arrives before the column ends', () => {
    const ro = order([el('Goblin', 0, 100), el('Orc', 0, 90), el('More', 0, 80)]);
    const end = findCandidateEnd(ro, 0, 1, { kind: 'endOfColumnOrPage' });
    expect(end).toBe(1);
  });
});

describe('findCandidateEnd — verticalGap', () => {
  it('stops at a gap wider than the threshold', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 85), el('Far below', 0, 20)]);
    // gap between HP:7 (minY=85) and Far below (maxY=30) = 55, threshold 30 -> stop before "Far below"
    const end = findCandidateEnd(ro, 0, null, { kind: 'verticalGap', gapThreshold: 30 });
    expect(end).toBe(2);
  });

  it('does NOT stop when the gap is within the threshold', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 85)]);
    const end = findCandidateEnd(ro, 0, null, { kind: 'verticalGap', gapThreshold: 30 });
    expect(end).toBe(2);
  });

  it('a column/page crossing is NEVER itself counted as a gap violation', () => {
    const columns = [
      { minX: 0, minY: 0, maxX: 280, maxY: 800 },
      { minX: 300, minY: 0, maxX: 600, maxY: 800 },
    ];
    // Goblin near the BOTTOM of column 0 (y=5), continuation starts near the TOP of column 1 (y=790) -- a huge raw Y gap, but it's a column crossing, so verticalGap must ignore it.
    const ro = order([el('Goblin', 10, 5), el('continues here', 310, 790)], columns);
    const end = findCandidateEnd(ro, 0, null, { kind: 'verticalGap', gapThreshold: 30 });
    expect(end).toBe(2);
  });
});

describe('findCandidateEnd — endLabel', () => {
  it('stops at (and excludes) the first line matching the end-label pattern', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 90), el('END', 0, 80), el('Orc', 0, 70)]);
    const end = findCandidateEnd(ro, 0, null, { kind: 'endLabel', endLabelPattern: 'END', endLabelIsRegex: false });
    expect(end).toBe(2);
  });

  it('falls through to the hard cap when the end label never appears', () => {
    const ro = order([el('Goblin', 0, 100), el('HP: 7', 0, 90)]);
    const end = findCandidateEnd(ro, 0, null, { kind: 'endLabel', endLabelPattern: 'END', endLabelIsRegex: false });
    expect(end).toBe(2);
  });

  it('supports a regex end-label pattern', () => {
    const ro = order([el('Goblin', 0, 100), el('---END---', 0, 90), el('Orc', 0, 80)]);
    const end = findCandidateEnd(ro, 0, null, { kind: 'endLabel', endLabelPattern: '^-+END-+$', endLabelIsRegex: true });
    expect(end).toBe(1);
  });
});
