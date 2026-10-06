import { describe, expect, it } from 'vitest';
import { attachCurrentValues } from '../../../src/statblock/schema/attachCurrentValues.js';
import type { SchemaFieldDescriptor } from '../../../src/statblock/schema/types.js';

function descriptor(path: string, type: SchemaFieldDescriptor['type'], children?: SchemaFieldDescriptor[]): SchemaFieldDescriptor {
  const d: SchemaFieldDescriptor = { path, label: path, type };
  if (children) d.children = children;
  return d;
}

describe('attachCurrentValues', () => {
  it('reads a top-level scalar path from the system data', () => {
    const tree = [descriptor('hp', 'number')];
    attachCurrentValues(tree, { hp: 12 });
    expect(tree[0]!.currentValue).toBe(12);
  });

  it('reads a nested dot path', () => {
    const tree = [descriptor('attributes.hp.value', 'number')];
    attachCurrentValues(tree, { attributes: { hp: { value: 7 } } });
    expect(tree[0]!.currentValue).toBe(7);
  });

  it('recurses into children, attaching each their own value at their own absolute path', () => {
    const tree = [descriptor('attributes.hp', 'object', [descriptor('attributes.hp.value', 'number'), descriptor('attributes.hp.max', 'number')])];
    attachCurrentValues(tree, { attributes: { hp: { value: 3, max: 10 } } });
    expect(tree[0]!.children![0]!.currentValue).toBe(3);
    expect(tree[0]!.children![1]!.currentValue).toBe(10);
  });

  it('a missing path resolves to undefined, never throws', () => {
    const tree = [descriptor('attributes.sanity.value', 'number')];
    attachCurrentValues(tree, { attributes: { hp: { value: 1 } } });
    expect(tree[0]!.currentValue).toBeUndefined();
  });

  it('a path through a non-object value (e.g. a primitive standing where an object is expected) resolves to undefined, not a crash', () => {
    const tree = [descriptor('attributes.hp.value', 'number')];
    attachCurrentValues(tree, { attributes: { hp: 5 } });
    expect(tree[0]!.currentValue).toBeUndefined();
  });

  it('the empty root path resolves to the whole data object', () => {
    const tree = [descriptor('', 'object')];
    const data = { anything: true };
    attachCurrentValues(tree, data);
    expect(tree[0]!.currentValue).toBe(data);
  });

  it('returns the same array reference it was given (mutated in place)', () => {
    const tree = [descriptor('hp', 'number')];
    const result = attachCurrentValues(tree, { hp: 1 });
    expect(result).toBe(tree);
  });
});
