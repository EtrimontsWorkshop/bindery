import { describe, expect, it } from 'vitest';
import { runTransformChain } from '../../../../src/statblock/extract/transforms/runChain.js';
import type { TransformStep } from '../../../../src/statblock/extract/transforms/types.js';
import type { PageTextElement } from '../../../../src/statblock/extract/types.js';

function el(text: string, x = 0): PageTextElement {
  return { text, x, y: 0, w: text.length * 6, h: 10, fontName: 'Body', fontSize: 10, bold: false, italic: false };
}

describe('runTransformChain', () => {
  it('threads each step output into the next', () => {
    const steps: TransformStep[] = [{ kind: 'trim' }, { kind: 'regexExtract', pattern: '\\d+' }, { kind: 'parseNumber' }];
    const result = runTransformChain(steps, '  HP 12  ', { elements: [] });
    expect(result.value).toBe(12);
  });

  it('an empty chain returns the initial value unchanged', () => {
    const result = runTransformChain([], 'unchanged', { elements: [] });
    expect(result.value).toBe('unchanged');
  });

  it('collects diagnostics from every step, in order', () => {
    const steps: TransformStep[] = [{ kind: 'regexExtract', pattern: '\\d+' }, { kind: 'nthNumber', n: 5 }];
    const result = runTransformChain(steps, 'no digits', { elements: [] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(['STATBLOCK_REGEX_NO_MATCH', 'STATBLOCK_NTH_NUMBER_NOT_STRING']);
  });

  it('defaultValue catches a failure from an earlier step in the chain', () => {
    const steps: TransformStep[] = [{ kind: 'regexExtract', pattern: '\\d+' }, { kind: 'defaultValue', value: 0 }];
    const result = runTransformChain(steps, 'no digits here', { elements: [] });
    expect(result.value).toBe(0);
  });

  it('defaultValue does NOT override a genuinely found value', () => {
    const steps: TransformStep[] = [{ kind: 'regexExtract', pattern: '\\d+' }, { kind: 'defaultValue', value: 0 }];
    const result = runTransformChain(steps, 'value: 42', { elements: [] });
    expect(result.value).toBe('42');
  });

  it('defaultValue treats an empty string as failure too', () => {
    const steps: TransformStep[] = [{ kind: 'trim' }, { kind: 'defaultValue', value: 'N/A' }];
    const result = runTransformChain(steps, '   ', { elements: [] });
    expect(result.value).toBe('N/A');
  });

  it('textToHtml uses the context elements, ignoring the chain value entirely', () => {
    const steps: TransformStep[] = [{ kind: 'textToHtml' }];
    const result = runTransformChain(steps, 'this string is ignored', { elements: [el('Actual'), el('content')] });
    expect(result.value).toBe('<p>Actual content</p>');
  });

  it('a realistic multi-step chain: strip a unit then parse the number', () => {
    const steps: TransformStep[] = [
      { kind: 'trim' },
      { kind: 'valueMap', valueMap: { id: 'v1', kind: 'stripUnits', params: { unit: 'hp' } } },
      { kind: 'parseNumber' },
    ];
    const result = runTransformChain(steps, '  10 hp  ', { elements: [] });
    expect(result.value).toBe(10);
  });
});
