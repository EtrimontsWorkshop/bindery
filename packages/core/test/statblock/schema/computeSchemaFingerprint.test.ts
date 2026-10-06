import { describe, expect, it } from 'vitest';
import { computeSchemaFingerprint } from '../../../src/statblock/schema/computeSchemaFingerprint.js';
import type { SchemaFieldDescriptor } from '../../../src/statblock/schema/types.js';

function leaf(path: string, type: SchemaFieldDescriptor['type'], extra: Partial<SchemaFieldDescriptor> = {}): SchemaFieldDescriptor {
  return { path, label: path, type, ...extra };
}

describe('computeSchemaFingerprint', () => {
  const tree = [leaf('groupA', 'object', { children: [leaf('groupA.valueB', 'number', { integer: true, min: 0 })] }), leaf('textC', 'string')];

  it('is a non-empty, deterministic string', () => {
    expect(computeSchemaFingerprint(tree)).toMatch(/^[0-9a-f]+$/);
    expect(computeSchemaFingerprint(tree)).toBe(computeSchemaFingerprint(structuredClone(tree)));
  });

  it('ignores labels and current values', () => {
    const relabelled = [leaf('groupA', 'object', { label: 'Other', children: [leaf('groupA.valueB', 'number', { integer: true, min: 0, label: 'X', currentValue: 5 })] }), leaf('textC', 'string')];
    expect(computeSchemaFingerprint(relabelled)).toBe(computeSchemaFingerprint(tree));
  });

  it('changes when a field is added, retyped or re-constrained', () => {
    const base = computeSchemaFingerprint(tree);
    expect(computeSchemaFingerprint([...tree, leaf('extraD', 'string')])).not.toBe(base);
    expect(computeSchemaFingerprint([tree[0]!, leaf('textC', 'html')])).not.toBe(base);
    expect(computeSchemaFingerprint([leaf('groupA', 'object', { children: [leaf('groupA.valueB', 'number', { integer: true, min: 1 })] }), tree[1]!])).not.toBe(base);
  });
});
