import { describe, expect, it } from 'vitest';
import { extractField } from '../../../src/statblock/extract/extractField.js';
import type { ExtractionBlock } from '../../../src/statblock/extract/types.js';

const block: ExtractionBlock = { bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, elements: [] };

describe('extractField — literal source', () => {
  it('yields the fixed value even on an empty block, cast to the field type', () => {
    const asString = extractField(block, { kind: 'literal', value: 'flat' }, [], { dataType: 'string' });
    expect(asString).toMatchObject({ found: true, value: 'flat' });
    const asNumber = extractField(block, { kind: 'literal', value: 12 }, [], { dataType: 'number' });
    expect(asNumber).toMatchObject({ found: true, value: 12 });
    const asBoolean = extractField(block, { kind: 'literal', value: true }, [], { dataType: 'boolean' });
    expect(asBoolean).toMatchObject({ found: true, value: true });
  });
});
