import { describe, expect, it } from 'vitest';
import { lineMatchesAnchor } from '../../../src/statblock/pdf/matchAnchor.js';
import { reconstructLines } from '../../../src/statblock/extract/reconstructLines.js';
import { el } from './testHelpers.js';

function lineFrom(...elements: ReturnType<typeof el>[]) {
  return reconstructLines(elements)[0]!;
}

describe('lineMatchesAnchor — textPattern', () => {
  it('matches a line whose full text matches the pattern', () => {
    const line = lineFrom(el('Goblin', 0, 0));
    const anchor = { kind: 'textPattern' as const, pattern: '^[A-Z][a-z]+$', patternIsRegex: true };
    expect(lineMatchesAnchor(line, anchor, 0)).toBe(true);
  });

  it('does not match a line that fails the pattern', () => {
    const line = lineFrom(el('HP: 12', 0, 0));
    const anchor = { kind: 'textPattern' as const, pattern: '^[A-Z][a-z]+$', patternIsRegex: true };
    expect(lineMatchesAnchor(line, anchor, 0)).toBe(false);
  });

  it('plain text matches when the line merely contains it', () => {
    const line = lineFrom(el('HP:', 0, 0), el('7', 40, 0), el('AC:', 80, 0), el('15', 120, 0));
    expect(lineMatchesAnchor(line, { kind: 'textPattern' as const, pattern: 'HP:', patternIsRegex: false }, 0)).toBe(true);
    expect(lineMatchesAnchor(line, { kind: 'textPattern' as const, pattern: 'Goblin', patternIsRegex: false }, 0)).toBe(false);
    expect(lineMatchesAnchor(line, { kind: 'textPattern' as const, pattern: '  ', patternIsRegex: false }, 0)).toBe(false);
  });

  it('supports plain-text (non-regex) exact matching', () => {
    const line = lineFrom(el('ATTACKS', 0, 0));
    const anchor = { kind: 'textPattern' as const, pattern: 'ATTACKS', patternIsRegex: false };
    expect(lineMatchesAnchor(line, anchor, 0)).toBe(true);
  });
});

describe('lineMatchesAnchor — headingStyle', () => {
  it('matches when every element on the line satisfies the style filter', () => {
    const line = lineFrom(el('Goblin', 0, 0, { bold: true, fontSize: 16 }), el('Warrior', 40, 0, { bold: true, fontSize: 16 }));
    const anchor = { kind: 'headingStyle' as const, styleFilter: { bold: true, minFontSize: 14 } };
    expect(lineMatchesAnchor(line, anchor, 0)).toBe(true);
  });

  it('does NOT match when only SOME elements on the line satisfy the style (mixed-style line is not a clean heading)', () => {
    const line = lineFrom(el('Goblin', 0, 0, { bold: true }), el('normal', 40, 0, { bold: false }));
    const anchor = { kind: 'headingStyle' as const, styleFilter: { bold: true } };
    expect(lineMatchesAnchor(line, anchor, 0)).toBe(false);
  });

  it('largestFontInBlock is reinterpreted as "largest on the page" at detection time', () => {
    const line = lineFrom(el('Goblin', 0, 0, { fontSize: 20 }));
    const anchor = { kind: 'headingStyle' as const, styleFilter: { largestFontInBlock: true } };
    expect(lineMatchesAnchor(line, anchor, 20)).toBe(true);
    expect(lineMatchesAnchor(line, anchor, 24)).toBe(false);
  });

  it('an additional pattern further narrows which heading-styled line counts', () => {
    const headingA = lineFrom(el('Goblin', 0, 0, { bold: true }));
    const headingB = lineFrom(el('ATTACKS', 0, 0, { bold: true }));
    const anchor = { kind: 'headingStyle' as const, styleFilter: { bold: true }, pattern: '^[A-Z][a-z]+$', patternIsRegex: true };
    expect(lineMatchesAnchor(headingA, anchor, 0)).toBe(true);
    expect(lineMatchesAnchor(headingB, anchor, 0)).toBe(false);
  });

  it('a headingStyle anchor with no styleFilter never matches (invalid config, degrades safely)', () => {
    const line = lineFrom(el('Goblin', 0, 0));
    expect(lineMatchesAnchor(line, { kind: 'headingStyle' }, 0)).toBe(false);
  });
});
