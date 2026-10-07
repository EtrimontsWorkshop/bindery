import { describe, expect, it } from 'vitest';
import { correlateImagesByBBox, type ImageEntry } from '../../src/inventory/imageRegistry.js';

function entry(
  objId: string,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  pageRefs: number[],
  size: { width: number | null; height: number | null } = { width: null, height: null },
): ImageEntry {
  return {
    objId,
    occurrences: pageRefs.map((page) => ({ page, bbox, index: 0 })),
    pageRefs,
    maxRelativeArea: 0.1,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: size.width,
    intrinsicHeight: size.height,
  };
}

describe('correlateImagesByBBox', () => {
  it('links two entries with an identical bbox of the first occurrence, the canonical one = the one with more occurrences', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [entry('img_p0_1', bbox, [1]), entry('g_d0_img_p1_1', bbox, [2, 3])];
    const result = correlateImagesByBBox(entries);
    const first = result.find((e) => e.objId === 'img_p0_1')!;
    const second = result.find((e) => e.objId === 'g_d0_img_p1_1')!;
    expect(first.correlatedWith).toBe('g_d0_img_p1_1'); // more occurrences (2>1) -> canonical
    expect(second.correlatedWith).toBeUndefined();
  });

  it('does NOT link entries with a different bbox', () => {
    const entries = [
      entry('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 }, [1]),
      entry('b', { minX: 50, minY: 50, maxX: 60, maxY: 60 }, [2]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('noise below the quantization threshold (0.5pt) is still correlated', () => {
    const entries = [
      entry('a', { minX: 6, minY: 6, maxX: 606, maxY: 786 }, [1]),
      entry('b', { minX: 6.2, minY: 5.9, maxX: 606.1, maxY: 786.1 }, [2, 3]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.find((e) => e.objId === 'a')!.correlatedWith).toBe('b');
  });

  it('a difference >= the quantization threshold is NOT correlated (avoids false hits)', () => {
    const entries = [
      entry('a', { minX: 6, minY: 6, maxX: 606, maxY: 786 }, [1]),
      entry('b', { minX: 7, minY: 6, maxX: 607, maxY: 786 }, [2]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('skips inline images (objId === null)', () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const inline: ImageEntry = { ...entry('placeholder', bbox, [1]), objId: null };
    const entries = [inline, entry('a', bbox, [2])];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('a tie in the number of occurrences resolved deterministically by objId', () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const entries = [entry('zzz', bbox, [1]), entry('aaa', bbox, [2])];
    const result = correlateImagesByBBox(entries);
    // "aaa" < "zzz" lexically -> "aaa" is canonical
    expect(result.find((e) => e.objId === 'zzz')!.correlatedWith).toBe('aaa');
  });

  // an identical bbox (the same frame on the page), a different internal resolution -> these are
  // two different illustrations in the same frame, NOT the same resource.
  it('an identical bbox but a DIFFERENT internal resolution -> does NOT correlate (different illustrations in the same frame)', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2], { width: 1024, height: 768 }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('an identical bbox and an identical internal resolution -> correlates', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2, 3], { width: 800, height: 600 }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.find((e) => e.objId === 'a')!.correlatedWith).toBe('b');
  });

  it('a known resolution correlates only with a known resolution, not with a lack of data (null)', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2], { width: null, height: null }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });
});
