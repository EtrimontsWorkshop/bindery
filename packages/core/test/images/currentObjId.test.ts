import { describe, expect, it } from 'vitest';
import { currentObjIdAt, waitForObjects, type PdfPageForExtract } from '../../src/images/extract.js';

describe('currentObjIdAt', () => {
  const list = {
    fnArray: [10, 85, 83, 88, 91],
    argsArray: [[], ['g_d2_img_p7_4', 100, 50], [{ data: 'img_p6_9', width: 4, height: 4 }], ['img_p6_11'], [[], [], []]],
  };

  it('reads the id of a painted image from the operator list of this document', () => {
    expect(currentObjIdAt(list, 1, 'img_p6_4')).toBe('g_d2_img_p7_4');
    expect(currentObjIdAt(list, 2, 'x')).toBe('img_p6_9');
    expect(currentObjIdAt(list, 3, 'x')).toBe('img_p6_11');
  });

  it('falls back to the inventory id when the operator is not an image paint, or nothing is known', () => {
    expect(currentObjIdAt(list, 0, 'img_p6_4')).toBe('img_p6_4');
    expect(currentObjIdAt(list, 4, 'img_p6_4')).toBe('img_p6_4');
    expect(currentObjIdAt(list, 99, 'img_p6_4')).toBe('img_p6_4');
    expect(currentObjIdAt(list, undefined, 'img_p6_4')).toBe('img_p6_4');
    expect(currentObjIdAt(null, 1, 'img_p6_4')).toBe('img_p6_4');
    expect(currentObjIdAt({}, 1, null)).toBeNull();
  });
});

describe('waitForObjects', () => {
  function pageWith(ready: Set<string>): PdfPageForExtract {
    const objs = { has: (id: string) => ready.has(id), get: () => undefined };
    return { objs, commonObjs: { has: () => false, get: () => undefined } } as unknown as PdfPageForExtract;
  }

  it('returns at once when everything is registered', async () => {
    const spent = await waitForObjects(pageWith(new Set(['a', 'b'])), ['a', 'b'], 500);
    expect(spent).toBeLessThan(50);
  });

  it('waits until a resource that arrives late is registered', async () => {
    const ready = new Set<string>(['a']);
    setTimeout(() => ready.add('b'), 40);
    const page = pageWith(ready);
    await waitForObjects(page, ['a', 'b'], 1000);
    expect(page.objs.has('b')).toBe(true);
  });

  it('gives up after the timeout for a resource that never arrives', async () => {
    const spent = await waitForObjects(pageWith(new Set()), ['never'], 60);
    expect(spent).toBeGreaterThanOrEqual(50);
    expect(spent).toBeLessThan(500);
  });

  it('does not wait with a zero timeout', async () => {
    expect(await waitForObjects(pageWith(new Set()), ['never'], 0)).toBe(0);
  });
});
