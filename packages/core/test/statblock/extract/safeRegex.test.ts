import { describe, expect, it } from 'vitest';
import { MAX_PATTERN_LENGTH, MAX_TEXT_LENGTH, boundedText, compileProfileRegex, isRegexRisky, testProfileRegex } from '../../../src/statblock/extract/safeRegex.js';

describe('isRegexRisky', () => {
  it.each(['^(a+)+$', '(a*)*', '(\\d+)*x', '((ab)+c*)+', '(.*)+', '(a|a)*', '(a|aa)+b', '(\\w|\\d)+', '([a-z]+\\s?)+$', '(?:a+)+'])('refuses %s', (pattern) => {
    expect(isRegexRisky(pattern)).toBe(true);
  });

  it.each(['^HP:?\\s*(\\d+)$', '(Bite|Claw)+', '\\d+\\s*(?:hp|HP)', '^(?:Attack|Action)s?$', '(\\d{1,3})', '[a-z]+(\\d+)?', 'a{2,4}', '(ab){2}', '(?<name>\\w+): (\\d+)', '(foo|bar)?baz', '\\(a+\\)+'])('accepts %s', (pattern) => {
    expect(isRegexRisky(pattern)).toBe(false);
  });
});

describe('compileProfileRegex', () => {
  it('compiles an ordinary pattern', () => {
    const result = compileProfileRegex('^HP:?$');
    expect(result.ok).toBe(true);
  });

  it('reports a pattern that cannot be compiled, one that is too long and one that is too complex', () => {
    expect(compileProfileRegex('(')).toEqual({ ok: false, problem: 'invalid' });
    expect(compileProfileRegex('a'.repeat(MAX_PATTERN_LENGTH + 1))).toEqual({ ok: false, problem: 'tooLong' });
    expect(compileProfileRegex('^(a+)+$')).toEqual({ ok: false, problem: 'tooComplex' });
  });
});

describe('compileProfileRegex — repeats in a row over the same characters', () => {
  it.each(['\\w*\\w*\\w*\\w*!', '.*.*.*=', '\\d+\\s*\\d+\\s*\\d+\\s*\\d+x', '(\\w*)(\\w*)(\\w*)$', 'a+a+a+b', '[a-z]+\\w*.*:', '\\w+?\\w+?\\w+?!', '\\S+\\w*\\d+z', '.*\\d+.*x', '.*\\d+x', '^\\w*\\w*\\w*$', '\\w+\\s*\\w+!'])('refuses %s', (pattern) => {
    expect(compileProfileRegex(pattern)).toEqual({ ok: false, problem: 'tooComplex' });
  });

  it.each([
    '^HP:?\\s*(\\d+)$',
    '\\d+\\s*(?:hp|HP)',
    '(\\d+)\\s*/\\s*(\\d+)\\s*/\\s*(\\d+)',
    '\\w+:\\s*\\w+:\\s*\\w+',
    '\\d+\\s+\\d+\\s+\\d+\\s+\\d+',
    '^(\\w+)\\s+(\\d+)\\s*\\((.*)\\)$',
    '\\d+d\\d+\\s*[+-]\\s*\\d+',
    'a+|a+|a+|a+',
    '.*\\d+.*',
    '(.+):\\s*(.+)',
    '^.*\\d+x',
    '\\w+\\s*\\d+',
    '[A-Z][a-z]+\\s+\\d+ ft\\.',
    '[a-z]+(\\d+)?',
  ])('accepts %s', (pattern) => {
    expect(compileProfileRegex(pattern).ok).toBe(true);
  });

  it('a pattern that is accepted answers at once on the longest text it is given', () => {
    const result = compileProfileRegex('^.*\\d+x');
    if (!result.ok) throw new Error('unexpected');
    const started = Date.now();
    testProfileRegex(result.regex, '1'.repeat(MAX_TEXT_LENGTH));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('testProfileRegex', () => {
  it('cuts the text it runs against', () => {
    expect(boundedText('x'.repeat(MAX_TEXT_LENGTH + 5))).toHaveLength(MAX_TEXT_LENGTH);
    const result = compileProfileRegex('end$');
    if (!result.ok) throw new Error('unexpected');
    expect(testProfileRegex(result.regex, `${'x'.repeat(MAX_TEXT_LENGTH)}end`)).toBe(false);
    expect(testProfileRegex(result.regex, 'the end')).toBe(true);
  });

  it('gives the same answer for a global pattern on repeated calls', () => {
    const result = compileProfileRegex('a', 'g');
    if (!result.ok) throw new Error('unexpected');
    expect(testProfileRegex(result.regex, 'a')).toBe(true);
    expect(testProfileRegex(result.regex, 'a')).toBe(true);
  });
});
