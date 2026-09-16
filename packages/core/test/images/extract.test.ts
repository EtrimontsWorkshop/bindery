import { describe, expect, it, vi } from 'vitest';
import { extractDirect, probeIntrinsicLongEdgePx, type PdfObjectsLike, type PdfPageForExtract } from '../../src/images/extract.js';
import type { RegionRenderer } from '../../src/images/regionRenderer.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const BBOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

function objsAlwaysUnresolved(): PdfObjectsLike {
  return {
    has: () => false,
    // Jesli to kiedykolwiek zostanie wywolane pomimo has()===false, test MUSI to wykryc — patrz test nizej.
    get: () => {
      throw new Error('get() nie powinno byc wywolane bez uprzedniego has()===true — zawiesiloby sie w nieskonczonosc na prawdziwym pdf.js');
    },
  };
}

function objsResolvedWith(data: unknown): PdfObjectsLike {
  return {
    has: () => true,
    get: (_objId, callback) => callback(data),
  };
}

function fakeRenderer(image: DecodedImage): { renderer: RegionRenderer; calls: unknown[] } {
  const calls: unknown[] = [];
  const renderer: RegionRenderer = {
    renderRegion: async (page, bbox, opts) => {
      calls.push({ page, bbox, opts });
      return image;
    },
  };
  return { renderer, calls };
}

const FALLBACK_IMAGE: DecodedImage = { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 4]) };

function makePage(objs: PdfObjectsLike, commonObjs: PdfObjectsLike): PdfPageForExtract {
  return {
    objs,
    commonObjs,
    getViewport: () => ({ transform: [1, 0, 0, -1, 0, 0] }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
}

describe('extractDirect', () => {
  it('sukces przez page.objs — nie probuje commonObjs ani renderu', async () => {
    const rgbData = { width: 2, height: 2, kind: 2, data: new Uint8ClampedArray(2 * 2 * 3) };
    const objs = objsResolvedWith(rgbData);
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('objs');
    expect(result.image.width).toBe(2);
    expect(calls).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('brak w page.objs (has=false) -> proba commonObjs, sukces tam', async () => {
    const objs = objsAlwaysUnresolved();
    const rgbData = { width: 3, height: 3, kind: 2, data: new Uint8ClampedArray(3 * 3 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.image.width).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('brak w obu rejestrach -> fallback do renderu regionu, z poprawnym bbox', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 512 }, 1);
    expect(result.source).toBe('region-render');
    expect(result.image).toBe(FALLBACK_IMAGE);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { bbox: unknown }).bbox).toEqual(BBOX);
  });

  it('[U6] rozwiazanie do null/undefined (cichy blad dekodowania JPX) daje Diagnostic i probuje nastepna sciezke', async () => {
    const objs = objsResolvedWith(undefined);
    const rgbData = { width: 2, height: 2, kind: 2, data: new Uint8ClampedArray(2 * 2 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const { renderer } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 7);
    expect(result.source).toBe('commonObjs');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('IMAGE_DECODE_EMPTY');
    expect(result.diagnostics[0]!.pageNumber).toBe(7);
    expect(result.diagnostics[0]!.severity).toBe('warning');
  });

  it('[U6] gdy WSZYSTKIE sciezki zawodza (null wszedzie), koncowy fallback to render regionu, z dwoma Diagnostic', async () => {
    const objs = objsResolvedWith(null);
    const commonObjs = objsResolvedWith(undefined);
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(calls).toHaveLength(1);
    expect(result.diagnostics.filter((d) => d.code === 'IMAGE_DECODE_EMPTY')).toHaveLength(2);
  });

  // [KROK-16 Z2, naprawa zgloszonego bledu na zywo] Zasob "obiecany" dopiero
  // po renderze strony (pdf.js: promocja do objs/commonObjs wymaga page.render(),
  // nie samej getOperatorList()) — has()===false PRZED renderem, true PO.
  it('has()=false na obu rejestrach PRZED renderem, true PO — uzywa CZYSTYCH pikseli zasobu, nie zrzutu regionu', async () => {
    const rgbData = { width: 5, height: 5, kind: 2, data: new Uint8ClampedArray(5 * 5 * 3) };
    let promoted = false;
    const objs: PdfObjectsLike = { has: () => false, get: () => { throw new Error('nie powinno byc wywolane — has()===false'); } };
    const commonObjs: PdfObjectsLike = {
      has: () => promoted,
      get: (_objId, callback) => callback(rgbData),
    };
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const warmingRenderer: RegionRenderer = {
      renderRegion: async (page, bbox, opts) => {
        promoted = true; // symuluje promocje pdf.js WEWNATRZ page.render()
        return renderer.renderRegion(page, bbox, opts);
      },
    };
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, warmingRenderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.image.width).toBe(5);
    expect(calls).toHaveLength(1); // rozgrzewka — DOKLADNIE jeden render, nie zero i nie dwa
    expect(result.diagnostics).toHaveLength(0);
  });

  it('has()=false na obu rejestrach, POZOSTAJE false po renderze — uzywa JUZ WYRENDEROWANYCH pikseli, bez DRUGIEGO renderu', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(result.image).toBe(FALLBACK_IMAGE);
    expect(calls).toHaveLength(1); // NIE dwa — piksele z rozgrzewki uzyte jako wynik koncowy, zero dodatkowego renderu
  });

  it('pierwsza proba COS probowala i dekodowanie zawiodlo -> BEZ ponawiania po rozgrzewce (te same bajty daja ten sam blad)', async () => {
    // has()===true od razu (nie "jeszcze nie gotowe") — resolve do null (U6).
    // Retry po rozgrzewce bylby bez sensu: ten sam `get()` zwrociloby to samo null.
    let resolveCalls = 0;
    const objs: PdfObjectsLike = {
      has: () => true,
      get: (_objId, callback) => {
        resolveCalls++;
        callback(null);
      },
    };
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(calls).toHaveLength(1);
    expect(resolveCalls).toBe(1); // NIE dwa — brak ponawiania po nieudanej-ale-faktycznej probie
    expect(result.diagnostics.filter((d) => d.code === 'IMAGE_DECODE_EMPTY')).toHaveLength(1);
  });

  it('blad rzucony przez normalizeDecodedImage (nieznany ksztalt) daje Diagnostic i probuje nastepna sciezke', async () => {
    const objs = objsResolvedWith({ width: 1, height: 1 }); // brak "data" i brak "bitmap" -> normalizeDecodedImage rzuca
    const rgbData = { width: 2, height: 2, kind: 2, data: new Uint8ClampedArray(2 * 2 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const { renderer } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('IMAGE_DECODE_FAILED');
  });

  it('objId=null (region czysto wektorowy) idzie WPROST do renderu regionu, bez probowania objs/commonObjs', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), null, BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(calls).toHaveLength(1);
  });

  it('NIGDY nie wywoluje get() na obiekcie ktory nie ma has()===true — nie zawiesza sie (weryfikacja negatywna)', async () => {
    const getSpy = vi.fn(() => {
      throw new Error('nie powinno byc wywolane');
    });
    const objs: PdfObjectsLike = { has: () => false, get: getSpy };
    const commonObjs: PdfObjectsLike = { has: () => false, get: getSpy };
    const { renderer } = fakeRenderer(FALLBACK_IMAGE);
    await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('[KROK-8 Z3] probeIntrinsicLongEdgePx', () => {
  it('zwraca dluzsza krawedz (px) obiektu rozwiazanego przez page.objs', async () => {
    const rgbData = { width: 300, height: 200, kind: 2, data: new Uint8ClampedArray(300 * 200 * 3) };
    const objs = objsResolvedWith(rgbData);
    const commonObjs = objsAlwaysUnresolved();
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBe(300);
  });

  it('probuje commonObjs, gdy objs nie ma tego objId', async () => {
    const objs = objsAlwaysUnresolved();
    const rgbData = { width: 100, height: 400, kind: 2, data: new Uint8ClampedArray(100 * 400 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBe(400);
  });

  it('zwraca null gdy zaden rejestr nie ma tego objId — best-effort, nie rzuca', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBeNull();
  });

  it('zwraca null (nie rzuca) gdy dekodowanie rozwiazuje sie do null (U6, np. JPX bez wasmUrl)', async () => {
    const objs = objsResolvedWith(null);
    const commonObjs = objsResolvedWith(undefined);
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBeNull();
  });

  it('NIGDY nie wywoluje get() bez uprzedniego has()===true (ten sam niezmiennik co extractDirect, U3)', async () => {
    const getSpy = vi.fn(() => {
      throw new Error('nie powinno byc wywolane');
    });
    const objs: PdfObjectsLike = { has: () => false, get: getSpy };
    const commonObjs: PdfObjectsLike = { has: () => false, get: getSpy };
    await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(getSpy).not.toHaveBeenCalled();
  });
});
