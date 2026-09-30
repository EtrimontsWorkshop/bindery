import { describe, expect, it } from 'vitest';
import { castAndValidate, type FieldTypeConstraints } from '../../../src/statblock/extract/castAndValidate.js';

describe('castAndValidate — undefined passthrough', () => {
  it('undefined stays undefined, no diagnostics, for any dataType', () => {
    const result = castAndValidate(undefined, { dataType: 'number' });
    expect(result).toEqual({ value: undefined, diagnostics: [] });
  });
});

describe('castAndValidate — number', () => {
  it('accepts a valid number with no constraints', () => {
    expect(castAndValidate(5, { dataType: 'number' })).toEqual({ value: 5, diagnostics: [] });
  });

  it('rejects a non-number value as an error, dropping it', () => {
    const result = castAndValidate('not a number', { dataType: 'number' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code: 'STATBLOCK_CAST_NOT_NUMBER' });
  });

  it('rejects NaN', () => {
    expect(castAndValidate(Number.NaN, { dataType: 'number' }).value).toBeUndefined();
  });

  it('flags (but keeps) a value below min', () => {
    const constraints: FieldTypeConstraints = { dataType: 'number', min: 10 };
    const result = castAndValidate(5, constraints);
    expect(result.value).toBe(5);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'STATBLOCK_VALIDATE_BELOW_MIN' });
  });

  it('flags (but keeps) a value above max', () => {
    const result = castAndValidate(100, { dataType: 'number', max: 20 });
    expect(result.value).toBe(100);
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALIDATE_ABOVE_MAX');
  });

  it('flags a non-integer value when integer is required', () => {
    const result = castAndValidate(4.5, { dataType: 'number', integer: true });
    expect(result.value).toBe(4.5);
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALIDATE_NOT_INTEGER');
  });

  it('a value within all constraints produces no diagnostics', () => {
    const result = castAndValidate(15, { dataType: 'number', min: 0, max: 20, integer: true });
    expect(result.diagnostics).toEqual([]);
  });

  it('a value at exactly min or max is not flagged (inclusive bounds)', () => {
    expect(castAndValidate(10, { dataType: 'number', min: 10, max: 20 }).diagnostics).toEqual([]);
    expect(castAndValidate(20, { dataType: 'number', min: 10, max: 20 }).diagnostics).toEqual([]);
  });
});

describe('castAndValidate — string / html', () => {
  it('accepts a string for "string"', () => {
    expect(castAndValidate('hello', { dataType: 'string' }).value).toBe('hello');
  });

  it('accepts a string for "html"', () => {
    expect(castAndValidate('<p>hi</p>', { dataType: 'html' }).value).toBe('<p>hi</p>');
  });

  it('rejects a non-string value', () => {
    const result = castAndValidate(42, { dataType: 'string' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_CAST_NOT_STRING');
  });
});

describe('castAndValidate — boolean', () => {
  it('accepts a real boolean unchanged', () => {
    expect(castAndValidate(true, { dataType: 'boolean' }).value).toBe(true);
    expect(castAndValidate(false, { dataType: 'boolean' }).value).toBe(false);
  });

  it('coerces common truthy/falsy strings', () => {
    for (const truthy of ['true', 'yes', '1', 'x', 'TRUE']) expect(castAndValidate(truthy, { dataType: 'boolean' }).value).toBe(true);
    for (const falsy of ['false', 'no', '0', '']) expect(castAndValidate(falsy, { dataType: 'boolean' }).value).toBe(false);
  });

  it('rejects an unrecognized string', () => {
    const result = castAndValidate('maybe', { dataType: 'boolean' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_CAST_NOT_BOOLEAN');
  });
});

describe('castAndValidate — choices', () => {
  it('accepts a value present in the choices list, no diagnostics', () => {
    const result = castAndValidate('Large', { dataType: 'choices', choices: ['Small', 'Large'] });
    expect(result.value).toBe('Large');
    expect(result.diagnostics).toEqual([]);
  });

  it('flags (but keeps) a value not in the choices list', () => {
    const result = castAndValidate('Huge', { dataType: 'choices', choices: ['Small', 'Large'] });
    expect(result.value).toBe('Huge');
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_VALIDATE_NOT_IN_CHOICES');
  });

  it('with no choices list at all, anything passes through with no diagnostics', () => {
    expect(castAndValidate('anything', { dataType: 'choices' }).diagnostics).toEqual([]);
  });

  it('compares numeric and string choices by their string form', () => {
    expect(castAndValidate(5, { dataType: 'choices', choices: [5, 10] }).diagnostics).toEqual([]);
    expect(castAndValidate('5', { dataType: 'choices', choices: [5, 10] }).diagnostics).toEqual([]);
  });
});

describe('castAndValidate — array', () => {
  it('accepts an array', () => {
    expect(castAndValidate([1, 2, 3], { dataType: 'array' }).value).toEqual([1, 2, 3]);
  });

  it('rejects a non-array', () => {
    const result = castAndValidate('not an array', { dataType: 'array' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_CAST_NOT_ARRAY');
  });
});

describe('castAndValidate — object', () => {
  it('accepts a plain object', () => {
    expect(castAndValidate({ a: 1 }, { dataType: 'object' }).value).toEqual({ a: 1 });
  });

  it('rejects null even though typeof null === "object"', () => {
    const result = castAndValidate(null, { dataType: 'object' });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_CAST_NOT_OBJECT');
  });

  it('rejects an array (arrays are not "object" for this purpose)', () => {
    expect(castAndValidate([1, 2], { dataType: 'object' }).value).toBeUndefined();
  });
});
