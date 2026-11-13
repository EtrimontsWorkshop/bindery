import { describe, expect, it } from 'vitest';
import { currentObjIdAt, waitForDependencies, waitForObjects, type PdfPageForExtract } from '../../src/images/extract.js';

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

describe('waitForDependencies', () => {
  // A registry like pdf.js's `PDFObjects`: `get` with a callback calls it once the object is resolved.
  function registry(): { has(id: string): boolean; get(id: string, cb: () => void): void; resolve(id: string): void } {
    const ready = new Set<string>();
    const waiting = new Map<string, (() => void)[]>();
    return {
      has: (id) => ready.has(id),
      get: (id, cb) => (ready.has(id) ? cb() : waiting.set(id, [...(waiting.get(id) ?? []), cb])),
      resolve: (id) => {
        ready.add(id);
        for (const cb of waiting.get(id) ?? []) cb();
        waiting.delete(id);
      },
    };
  }
  const list = { fnArray: [1, 85, 1, 1, 83], argsArray: [['img_p0_1'], ['img_p0_1', 10, 10], ['g_d0_img_p0_2'], ['mask_p0_3'], [{ data: 'mask_p0_3' }]] };

  it('waits for every dependency, however late it arrives, each in the registry pdf.js puts it in', async () => {
    const objs = registry();
    const commonObjs = registry();
    const page = { objs, commonObjs } as unknown as PdfPageForExtract;
    // Later than the default settle budget of the old clock-measured wait would have allowed under load.
    setTimeout(() => objs.resolve('img_p0_1'), 5);
    setTimeout(() => commonObjs.resolve('g_d0_img_p0_2'), 30);
    setTimeout(() => objs.resolve('mask_p0_3'), 60);
    expect(await waitForDependencies(page, list, 10_000)).toBe(true);
    expect(['img_p0_1', 'mask_p0_3'].every((id) => objs.has(id)) && commonObjs.has('g_d0_img_p0_2')).toBe(true);
  });

  it('returns at once when nothing is missing or there is no operator list', async () => {
    const objs = registry();
    const commonObjs = registry();
    for (const id of ['img_p0_1', 'mask_p0_3']) objs.resolve(id);
    commonObjs.resolve('g_d0_img_p0_2');
    const page = { objs, commonObjs } as unknown as PdfPageForExtract;
    expect(await waitForDependencies(page, list, 0)).toBe(true);
    expect(await waitForDependencies(page, null, 0)).toBe(true);
    expect(await waitForDependencies(page, {}, 0)).toBe(true);
  });

  it('gives up after the timeout when the worker never sends a dependency', async () => {
    const page = { objs: registry(), commonObjs: registry() } as unknown as PdfPageForExtract;
    expect(await waitForDependencies(page, list, 20)).toBe(false);
  });
});
