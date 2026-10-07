import { describe, expect, it, vi } from 'vitest';
import { extractDirect, probeIntrinsicLongEdgePx, type PdfObjectsLike, type PdfPageForExtract } from '../../src/images/extract.js';
import type { RegionRenderer } from '../../src/images/regionRenderer.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const BBOX = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

function objsAlwaysUnresolved(): PdfObjectsLike {
  return {
    has: () => false,
    // If this is ever called despite has()===false, the test MUST detect it — see the test below.
    get: () => {
      throw new Error('get() must not be called without a prior has()===true — it would hang forever on a real pdf.js');
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
  it('success through page.objs — doesn\'t try commonObjs or a render', async () => {
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

  it('missing in page.objs (has=false) -> tries commonObjs, succeeds there', async () => {
    const objs = objsAlwaysUnresolved();
    const rgbData = { width: 3, height: 3, kind: 2, data: new Uint8ClampedArray(3 * 3 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.image.width).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('missing in both registries -> falls back to a region render, with the correct bbox', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 512 }, 1);
    expect(result.source).toBe('region-render');
    expect(result.image).toBe(FALLBACK_IMAGE);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { bbox: unknown }).bbox).toEqual(BBOX);
  });

  it('resolving to null/undefined (a silent JPX decode failure) gives a Diagnostic and tries the next path', async () => {
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

  it('when ALL paths fail (null everywhere), the final fallback is a region render, with two Diagnostics', async () => {
    const objs = objsResolvedWith(null);
    const commonObjs = objsResolvedWith(undefined);
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(calls).toHaveLength(1);
    expect(result.diagnostics.filter((d) => d.code === 'IMAGE_DECODE_EMPTY')).toHaveLength(2);
  });

  // A resource "promised" only after a page render (pdf.js: promotion to objs/commonObjs
  // requires page.render(), not getOperatorList() alone) — has()===false BEFORE the render, true AFTER.
  it('has()=false on both registries BEFORE the render, true AFTER — uses the CLEAN pixels of the resource, not a region snapshot', async () => {
    const rgbData = { width: 5, height: 5, kind: 2, data: new Uint8ClampedArray(5 * 5 * 3) };
    let promoted = false;
    const objs: PdfObjectsLike = { has: () => false, get: () => { throw new Error('must not be called — has()===false'); } };
    const commonObjs: PdfObjectsLike = {
      has: () => promoted,
      get: (_objId, callback) => callback(rgbData),
    };
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const warmingRenderer: RegionRenderer = {
      renderRegion: async (page, bbox, opts) => {
        promoted = true; // simulates pdf.js's promotion INSIDE page.render()
        return renderer.renderRegion(page, bbox, opts);
      },
    };
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, warmingRenderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.image.width).toBe(5);
    expect(calls).toHaveLength(1); // warmup — EXACTLY one render, not zero and not two
    expect(result.diagnostics).toHaveLength(0);
  });

  it('has()=false on both registries, STAYS false after the render — uses the ALREADY RENDERED pixels, without a SECOND render', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(result.image).toBe(FALLBACK_IMAGE);
    expect(calls).toHaveLength(1); // NOT two — the warmup pixels used as the final result, zero extra renders
  });

  it('the first attempt TRIED SOMETHING and decoding failed -> NO retry after the warmup (the same bytes give the same error)', async () => {
    // has()===true right away (not "not ready yet") — resolves to null.
    // A retry after the warmup would be pointless: the same `get()` would return the same null.
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
    expect(resolveCalls).toBe(1); // NOT two — no retry after a failed-but-genuine attempt
    expect(result.diagnostics.filter((d) => d.code === 'IMAGE_DECODE_EMPTY')).toHaveLength(1);
  });

  it('an error thrown by normalizeDecodedImage (an unknown shape) gives a Diagnostic and tries the next path', async () => {
    const objs = objsResolvedWith({ width: 1, height: 1 }); // no "data" and no "bitmap" -> normalizeDecodedImage throws
    const rgbData = { width: 2, height: 2, kind: 2, data: new Uint8ClampedArray(2 * 2 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const { renderer } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('commonObjs');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('IMAGE_DECODE_FAILED');
  });

  it('objId=null (a purely vector region) goes STRAIGHT to a region render, without trying objs/commonObjs', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const { renderer, calls } = fakeRenderer(FALLBACK_IMAGE);
    const result = await extractDirect(makePage(objs, commonObjs), null, BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(result.source).toBe('region-render');
    expect(calls).toHaveLength(1);
  });

  it('NEVER calls get() on an object that doesn\'t have has()===true — doesn\'t hang (a negative verification)', async () => {
    const getSpy = vi.fn(() => {
      throw new Error('must not be called');
    });
    const objs: PdfObjectsLike = { has: () => false, get: getSpy };
    const commonObjs: PdfObjectsLike = { has: () => false, get: getSpy };
    const { renderer } = fakeRenderer(FALLBACK_IMAGE);
    await extractDirect(makePage(objs, commonObjs), 'img1', BBOX, renderer, { targetLongEdgePx: 100 }, 1);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('probeIntrinsicLongEdgePx', () => {
  it('returns the longer edge (px) of an object resolved through page.objs', async () => {
    const rgbData = { width: 300, height: 200, kind: 2, data: new Uint8ClampedArray(300 * 200 * 3) };
    const objs = objsResolvedWith(rgbData);
    const commonObjs = objsAlwaysUnresolved();
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBe(300);
  });

  it('tries commonObjs when objs doesn\'t have this objId', async () => {
    const objs = objsAlwaysUnresolved();
    const rgbData = { width: 100, height: 400, kind: 2, data: new Uint8ClampedArray(100 * 400 * 3) };
    const commonObjs = objsResolvedWith(rgbData);
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBe(400);
  });

  it('returns null when no registry has this objId — best-effort, doesn\'t throw', async () => {
    const objs = objsAlwaysUnresolved();
    const commonObjs = objsAlwaysUnresolved();
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBeNull();
  });

  it('returns null (doesn\'t throw) when decoding resolves to null (e.g. JPX without a wasmUrl)', async () => {
    const objs = objsResolvedWith(null);
    const commonObjs = objsResolvedWith(undefined);
    const result = await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(result).toBeNull();
  });

  it('NEVER calls get() without a prior has()===true (the same invariant as extractDirect)', async () => {
    const getSpy = vi.fn(() => {
      throw new Error('must not be called');
    });
    const objs: PdfObjectsLike = { has: () => false, get: getSpy };
    const commonObjs: PdfObjectsLike = { has: () => false, get: getSpy };
    await probeIntrinsicLongEdgePx(makePage(objs, commonObjs), 'img1');
    expect(getSpy).not.toHaveBeenCalled();
  });
});
