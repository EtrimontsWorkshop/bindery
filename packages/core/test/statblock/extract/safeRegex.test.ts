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
