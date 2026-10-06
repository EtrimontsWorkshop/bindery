import { describe, expect, it } from 'vitest';
import { resolveDuplicateAction } from '../../../src/statblock/import/resolveDuplicateAction.js';

describe('resolveDuplicateAction', () => {
  it('always creates when nothing existing was found, regardless of policy', () => {
    expect(resolveDuplicateAction(false, 'skip')).toBe('create');
    expect(resolveDuplicateAction(false, 'overwrite')).toBe('create');
    expect(resolveDuplicateAction(false, 'copy')).toBe('create');
  });

  it('skips when a duplicate was found and the policy is "skip"', () => {
    expect(resolveDuplicateAction(true, 'skip')).toBe('skip');
  });

  it('updates when a duplicate was found and the policy is "overwrite"', () => {
    expect(resolveDuplicateAction(true, 'overwrite')).toBe('update');
  });

  it('creates a copy when a duplicate was found and the policy is "copy"', () => {
    expect(resolveDuplicateAction(true, 'copy')).toBe('create');
  });
});
