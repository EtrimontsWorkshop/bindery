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
  it('powiazuje dwa wpisy o identycznym bboksie pierwszego wystapienia, kanoniczny = wiecej wystapien', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [entry('img_p0_1', bbox, [1]), entry('g_d0_img_p1_1', bbox, [2, 3])];
    const result = correlateImagesByBBox(entries);
    const first = result.find((e) => e.objId === 'img_p0_1')!;
    const second = result.find((e) => e.objId === 'g_d0_img_p1_1')!;
    expect(first.correlatedWith).toBe('g_d0_img_p1_1'); // wiecej wystapien (2>1) -> kanoniczny
    expect(second.correlatedWith).toBeUndefined();
  });

  it('NIE powiazuje wpisow o roznym bboksie', () => {
    const entries = [
      entry('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 }, [1]),
      entry('b', { minX: 50, minY: 50, maxX: 60, maxY: 60 }, [2]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('szum ponizej progu kwantyzacji (0.5pt) nadal jest korelowany', () => {
    const entries = [
      entry('a', { minX: 6, minY: 6, maxX: 606, maxY: 786 }, [1]),
      entry('b', { minX: 6.2, minY: 5.9, maxX: 606.1, maxY: 786.1 }, [2, 3]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.find((e) => e.objId === 'a')!.correlatedWith).toBe('b');
  });

  it('roznica >= progu kwantyzacji NIE jest korelowana (unika falszywych trafien)', () => {
    const entries = [
      entry('a', { minX: 6, minY: 6, maxX: 606, maxY: 786 }, [1]),
      entry('b', { minX: 7, minY: 6, maxX: 607, maxY: 786 }, [2]),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('pomija obrazy inline (objId === null)', () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const inline: ImageEntry = { ...entry('placeholder', bbox, [1]), objId: null };
    const entries = [inline, entry('a', bbox, [2])];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('remis w liczbie wystapien rozstrzygniety deterministycznie po objId', () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const entries = [entry('zzz', bbox, [1]), entry('aaa', bbox, [2])];
    const result = correlateImagesByBBox(entries);
    // "aaa" < "zzz" leksykalnie -> "aaa" kanoniczny
    expect(result.find((e) => e.objId === 'zzz')!.correlatedWith).toBe('aaa');
  });

  // [KROK-16 Z1] identyczny bbox (ta sama ramka na stronie), rozna rozdzielczosc
  // wewnetrzna -> to dwie rozne ilustracje w tej samej ramce, NIE ten sam zasob.
  it('identyczny bbox ale ROZNA rozdzielczosc wewnetrzna -> NIE koreluje (rozne ilustracje w tej samej ramce)', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2], { width: 1024, height: 768 }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });

  it('identyczny bbox i identyczna rozdzielczosc wewnetrzna -> koreluje', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2, 3], { width: 800, height: 600 }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.find((e) => e.objId === 'a')!.correlatedWith).toBe('b');
  });

  it('rozdzielczosc znana koreluje wylacznie z rozdzielczoscia znana, nie z brakiem danych (null)', () => {
    const bbox = { minX: 6, minY: 6, maxX: 606, maxY: 786 };
    const entries = [
      entry('a', bbox, [1], { width: 800, height: 600 }),
      entry('b', bbox, [2], { width: null, height: null }),
    ];
    const result = correlateImagesByBBox(entries);
    expect(result.every((e) => e.correlatedWith === undefined)).toBe(true);
  });
});
