import { describe, expect, it } from 'vitest';
import { describeSchema, describeSchemaField } from '../../../src/statblock/schema/describeSchemaField.js';
import type { FoundryFieldLike } from '../../../src/statblock/schema/types.js';

// Hand-built mock "DataField-like" objects — deliberately abstract, not
// modeled on any real system's actual Actor shape (no real statblock/system content in fixtures, and the walker itself doesn't
// care about real field names anyway).

describe('describeSchemaField — kind classification', () => {
  it('classifies primitive field classes by className', () => {
    expect(describeSchemaField({ className: 'BooleanField' }, 'p1').type).toBe('boolean');
    expect(describeSchemaField({ className: 'NumberField' }, 'p2').type).toBe('number');
    expect(describeSchemaField({ className: 'StringField' }, 'p3').type).toBe('string');
    expect(describeSchemaField({ className: 'HTMLField' }, 'p4').type).toBe('html');
    expect(describeSchemaField({ className: 'ObjectField' }, 'p5').type).toBe('object');
  });

  it('falls back to "unsupported" for an unrecognized field class, instead of guessing', () => {
    expect(describeSchemaField({ className: 'SomeExoticFieldNobodyHasSeen' }, 'p6').type).toBe('unsupported');
  });

  it('a field with `choices` is reported as "choices", overriding its base primitive type', () => {
    const field: FoundryFieldLike = { className: 'NumberField', choices: [1, 2, 3] };
    expect(describeSchemaField(field, 'level').type).toBe('choices');
  });

  it('normalizes an array-of-values choices into {value,label} pairs', () => {
    const field: FoundryFieldLike = { className: 'StringField', choices: ['small', 'large'] };
    const result = describeSchemaField(field, 'size');
    expect(result.choices).toEqual([
      { value: 'small', label: 'small' },
      { value: 'large', label: 'large' },
    ]);
  });

  it('normalizes a record-of-value-to-label choices, keeping the human label', () => {
    const field: FoundryFieldLike = { className: 'NumberField', choices: { 1: 'Novice', 2: 'Expert' } };
    const result = describeSchemaField(field, 'rank');
    expect(result.choices).toEqual([
      { value: '1', label: 'Novice' },
      { value: '2', label: 'Expert' },
    ]);
  });
});

describe('describeSchemaField — label/metadata passthrough', () => {
  it('uses the field label when present, trimmed', () => {
    const result = describeSchemaField({ className: 'NumberField', label: '  Hit Points  ' }, 'hp');
    expect(result.label).toBe('Hit Points');
  });

  it('falls back to the path when the label is blank (common — many systems localize elsewhere)', () => {
    const result = describeSchemaField({ className: 'NumberField', label: '' }, 'attributes.hp.value');
    expect(result.label).toBe('attributes.hp.value');
  });

  it('carries min/max/integer/initial through unchanged', () => {
    const result = describeSchemaField({ className: 'NumberField', min: 0, max: 999, integer: true, initial: 10 }, 'hp');
    expect(result.min).toBe(0);
    expect(result.max).toBe(999);
    expect(result.integer).toBe(true);
    expect(result.initial).toBe(10);
  });
});

describe('describeSchemaField — nesting', () => {
  it('recurses into a schema-shaped field via `.fields`, building dot paths', () => {
    const field: FoundryFieldLike = {
      className: 'SchemaField',
      fields: {
        value: { className: 'NumberField' },
        max: { className: 'NumberField' },
      },
    };
    const result = describeSchemaField(field, 'attributes.hp');
    expect(result.type).toBe('object');
    expect(result.children?.map((c) => c.path)).toEqual(['attributes.hp.value', 'attributes.hp.max']);
  });

  it('starts fresh (no leading dot) when the parent path is empty', () => {
    const field: FoundryFieldLike = { className: 'SchemaField', fields: { hp: { className: 'NumberField' } } };
    expect(describeSchemaField(field, '').children?.[0]!.path).toBe('hp');
  });

  it('skips readonly children entirely (derived/computed data, never a write target)', () => {
    const field: FoundryFieldLike = {
      className: 'SchemaField',
      fields: {
        value: { className: 'NumberField' },
        derived: { className: 'NumberField', readonly: true },
      },
    };
    const result = describeSchemaField(field, 'attributes.hp');
    expect(result.children?.map((c) => c.path)).toEqual(['attributes.hp.value']);
  });

  it('represents an array field as "array" with one synthetic child describing the element shape', () => {
    const field: FoundryFieldLike = {
      className: 'ArrayField',
      element: {
        className: 'SchemaField',
        fields: { name: { className: 'StringField' }, damage: { className: 'StringField' } },
      },
    };
    const result = describeSchemaField(field, 'attacks');
    expect(result.type).toBe('array');
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.type).toBe('object');
    expect(result.children![0]!.children?.map((c) => c.path)).toEqual(['attacks.name', 'attacks.damage']);
  });

  it('nested SchemaFields build a multi-level dot path correctly', () => {
    const field: FoundryFieldLike = {
      className: 'SchemaField',
      fields: {
        attributes: {
          className: 'SchemaField',
          fields: { hp: { className: 'SchemaField', fields: { value: { className: 'NumberField' } } } },
        },
      },
    };
    const result = describeSchemaField(field, '');
    expect(result.children![0]!.children![0]!.children![0]!.path).toBe('attributes.hp.value');
  });
});

describe('describeSchema', () => {
  it('unwraps the synthetic root, returning children directly', () => {
    const field: FoundryFieldLike = { className: 'SchemaField', fields: { hp: { className: 'NumberField' } } };
    const result = describeSchema(field);
    expect(result).toEqual([{ path: 'hp', label: 'hp', type: 'number' }]);
  });

  it('a schema with no fields at all returns an empty list, not an error', () => {
    expect(describeSchema({ className: 'SchemaField', fields: {} })).toEqual([]);
  });
});
