import { describe, expect, it } from 'vitest';
import { resolveTransformChain } from '../../../src/statblock/import/resolveTransformChain.js';

describe('resolveTransformChain', () => {
  it('passes through a field with no transforms and no valueMapId as an empty chain', () => {
    const result = resolveTransformChain({ transforms: [], valueMapId: undefined }, { valueMaps: [] });
    expect(result.chain).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps the configured transforms in order', () => {
    const transforms = [{ kind: 'trim' as const }, { kind: 'normalizeWhitespace' as const }];
    const result = resolveTransformChain({ transforms, valueMapId: undefined }, { valueMaps: [] });
    expect(result.chain).toEqual(transforms);
  });

  it('appends the resolved valueMap as the final step, after configured transforms', () => {
    const valueMap = { id: 'vm1', kind: 'lookupTable' as const, params: {} };
    const result = resolveTransformChain({ transforms: [{ kind: 'trim' }], valueMapId: 'vm1' }, { valueMaps: [valueMap] });
    expect(result.chain).toEqual([{ kind: 'trim' }, { kind: 'valueMap', valueMap }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('emits a warning and omits the step when valueMapId references a map that does not exist', () => {
    const result = resolveTransformChain({ transforms: [], valueMapId: 'missing' }, { valueMaps: [] });
    expect(result.chain).toEqual([]);
    expect(result.diagnostics).toEqual([{ severity: 'warning', code: 'STATBLOCK_VALUE_MAP_NOT_FOUND', params: { valueMapId: 'missing' } }]);
  });
});
