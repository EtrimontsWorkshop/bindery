import { describe, expect, it } from 'vitest';
import { nthNumber, parseNumber } from '../../../../src/statblock/extract/transforms/numberTransforms.js';

describe('parseNumber — basics', () => {
  it('parses a plain integer', () => {
    expect(parseNumber('12').value).toBe(12);
  });

  it('parses a plain float', () => {
    expect(parseNumber('3.5').value).toBe(3.5);
  });

  it('parses the first number found within surrounding text', () => {
    expect(parseNumber('HP 12').value).toBe(12);
  });

  it('leading/trailing whitespace does not prevent parsing', () => {
    expect(parseNumber('  42  ').value).toBe(42);
  });
});

describe('parseNumber — edge case: weird minus signs', () => {
  it('a plain ASCII hyphen-minus is a negative number', () => {
    expect(parseNumber('-2').value).toBe(-2);
  });

  it('a plus sign is a positive number', () => {
    expect(parseNumber('+2').value).toBe(2);
  });

  it('U+2212 MINUS SIGN is treated as negative', () => {
    expect(parseNumber('−2').value).toBe(-2);
  });

  it('U+2013 EN DASH (used as a minus sign by some fonts/typesetting) is treated as negative', () => {
    expect(parseNumber('–2').value).toBe(-2);
  });

  it('a standalone dash with no digits at all does not parse as a number (no false zero)', () => {
    const result = parseNumber('–');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_PARSE_NUMBER_NOT_FOUND');
  });

  it('a dash used as a word separator, not a sign, does not turn the following number negative', () => {
    // e.g. "page 12-15": the hyphen belongs between two numbers, not as this number's sign.
    // Our simple first-match parser reads the FIRST number ("12") and ignores the trailing range -- documented behavior, not a dash-sign bug.
    expect(parseNumber('12-15').value).toBe(12);
  });
});

describe('parseNumber — edge case: fractions', () => {
  it('parses a standalone Unicode vulgar fraction', () => {
    expect(parseNumber('½').value).toBe(0.5); // ½
  });

  it('parses a mixed number (whole part + vulgar fraction)', () => {
    expect(parseNumber('1½').value).toBe(1.5); // 1½
  });

  it('a negative mixed number applies the sign to the whole magnitude', () => {
    expect(parseNumber('-1¼').value).toBe(-1.25); // -1¼
  });
});

describe('parseNumber — edge case: empty/no-number text', () => {
  it('empty string reports not-found, not zero', () => {
    const result = parseNumber('');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_PARSE_NUMBER_NOT_FOUND');
  });

  it('text with no digits at all reports not-found', () => {
    expect(parseNumber('none').value).toBeUndefined();
  });

  it('non-string input is an error diagnostic, not a crash', () => {
    const result = parseNumber(undefined);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_PARSE_NUMBER_NOT_STRING');
  });
});

describe('nthNumber', () => {
  it('extracts the 1st number as a string', () => {
    expect(nthNumber('12/20', 1).value).toBe('12');
  });

  it('extracts the 2nd number', () => {
    expect(nthNumber('12/20', 2).value).toBe('20');
  });

  it('reports not-found when there are fewer numbers than requested', () => {
    const result = nthNumber('12', 2);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_NTH_NUMBER_NOT_FOUND');
  });

  it('composes with parseNumber to get an actual numeric value', () => {
    const raw = nthNumber('current 12 / max 20', 2).value;
    expect(parseNumber(raw).value).toBe(20);
  });

  it('empty string reports not-found', () => {
    expect(nthNumber('', 1).value).toBeUndefined();
  });
});
