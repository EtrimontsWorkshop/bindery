import { describe, expect, it } from 'vitest';
import { descriptorToConstraints, flattenLeafDescriptors } from '../../../src/statblock/import/descriptorLookup.js';
import { descriptor } from './testHelpers.js';

describe('descriptorToConstraints', () => {
  it('carries dataType/min/max/integer straight through', () => {
    const d = descriptor('attributes.hp.value', 'number', { min: 0, max: 999, integer: true });
    expect(descriptorToConstraints(d)).toEqual({ dataType: 'number', min: 0, max: 999, integer: true, choices: undefined });
  });

  it('unpacks choices to bare values, dropping their labels', () => {
    const d = descriptor('size', 'choices', { choices: [{ value: 'sm', label: 'Small' }, { value: 'lg', label: 'Large' }] });
    expect(descriptorToConstraints(d).choices).toEqual(['sm', 'lg']);
  });

  it('leaves min/max/integer/choices undefined when the descriptor has none', () => {
    const d = descriptor('name', 'string');
    expect(descriptorToConstraints(d)).toEqual({ dataType: 'string', min: undefined, max: undefined, integer: undefined, choices: undefined });
  });
});

describe('flattenLeafDescriptors', () => {
  it('returns a flat tree unchanged (every node is already a leaf)', () => {
    const tree = [descriptor('a', 'number'), descriptor('b', 'string')];
    expect(flattenLeafDescriptors(tree)).toEqual(tree);
  });

  it('descends into children, returning only the leaves', () => {
    const tree = [descriptor('hp', 'object', { children: [descriptor('hp.value', 'number'), descriptor('hp.max', 'number')] })];
    const leaves = flattenLeafDescriptors(tree);
    expect(leaves.map((d) => d.path)).toEqual(['hp.value', 'hp.max']);
  });

  it('treats a node with an empty children array as a leaf itself, not as contributing zero leaves', () => {
    const tree = [descriptor('emptyList', 'array', { children: [] })];
    expect(flattenLeafDescriptors(tree).map((d) => d.path)).toEqual(['emptyList']);
  });

  it('handles several levels of nesting', () => {
    const tree = [
      descriptor('a', 'object', {
        children: [descriptor('a.b', 'object', { children: [descriptor('a.b.c', 'string')] })],
      }),
    ];
    expect(flattenLeafDescriptors(tree).map((d) => d.path)).toEqual(['a.b.c']);
  });
});
