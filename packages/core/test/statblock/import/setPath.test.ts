import { describe, expect, it } from 'vitest';
import { setPath } from '../../../src/statblock/import/setPath.js';

describe('setPath', () => {
  it('sets a shallow key', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'name', 'Goblin');
    expect(target).toEqual({ name: 'Goblin' });
  });

  it('creates intermediate objects for a nested path', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'attributes.hp.value', 7);
    expect(target).toEqual({ attributes: { hp: { value: 7 } } });
  });

  it('preserves sibling keys already present at an intermediate level', () => {
    const target: Record<string, unknown> = { attributes: { hp: { max: 10 } } };
    setPath(target, 'attributes.hp.value', 7);
    expect(target).toEqual({ attributes: { hp: { max: 10, value: 7 } } });
  });

  it('overwrites a non-object value found where it needs to descend, rather than throwing', () => {
    const target: Record<string, unknown> = { attributes: 'not an object' };
    setPath(target, 'attributes.hp.value', 7);
    expect(target).toEqual({ attributes: { hp: { value: 7 } } });
  });

  it('overwrites an array found where it needs to descend (arrays are objects but never a sane intermediate)', () => {
    const target: Record<string, unknown> = { attributes: [1, 2, 3] };
    setPath(target, 'attributes.hp.value', 7);
    expect(target).toEqual({ attributes: { hp: { value: 7 } } });
  });

  it('overwrites an existing scalar leaf', () => {
    const target: Record<string, unknown> = { attributes: { hp: { value: 1 } } };
    setPath(target, 'attributes.hp.value', 99);
    expect(target).toEqual({ attributes: { hp: { value: 99 } } });
  });
});
