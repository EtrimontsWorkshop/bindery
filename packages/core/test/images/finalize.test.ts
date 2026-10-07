import { describe, expect, it } from 'vitest';
import {
  classifyTargetKind,
  closeCorrelationByHash,
  computeContentHash,
  computeLuminanceStdDev,
  computeSmoothnessMetrics,
  computeUniformColorFraction,
  finalizeImages,
  type PreparedEntryForFinalize,
} from '../../src/images/finalize.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';
import type { Diagnostic } from '../../src/text/types.js';

function image(width: number, height: number, fill: number): DecodedImage {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(fill) };
}

function entry(overrides: Partial<ImageEntry> = {}): ImageEntry {
  return {
    objId: 'img1',
    occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea: 0.5,
    isMaskLayer: false,
    maskEvidence: null,
    ...overrides,
  };
}

async function prepared(
  e: ImageEntry,
  img: DecodedImage,
  overrides: Partial<PreparedEntryForFinalize<string>> = {},
): Promise<PreparedEntryForFinalize<string>> {
  return {
    entry: e,
    classification: 'content',
    // A WEAK signal by default (corresponds to `Z2-moderate-area-no-mask-evidence` from
    // classify.ts, the case FLAT_TEXTURE_STDDEV_THRESHOLD was calibrated on) — tests of a strong
    // signal (e.g. `Z1-large-relative-area`, 0.9) override it explicitly through `overrides`.
    confidence: 0.5,
    extractSource: 'objs',
    contentHash: await computeContentHash(img),
    width: img.width,
    height: img.height,
    payload: 'encoded-bytes-placeholder',
    ...overrides,
  };
}

describe('computeContentHash', () => {
  it('gives an identical hash for identical content (determinism)', async () => {
    const a = await computeContentHash(image(4, 4, 100));
    const b = await computeContentHash(image(4, 4, 100));
    expect(a).toBe(b);
  });

  it('gives a different hash for different pixel content', async () => {
    const a = await computeContentHash(image(4, 4, 100));
    const b = await computeContentHash(image(4, 4, 200));
    expect(a).not.toBe(b);
  });

  it('gives a different hash for the same pixels but different dimensions (the header encodes width/height)', async () => {
    const a = await computeContentHash({ width: 4, height: 2, rgba: new Uint8ClampedArray(32).fill(50) });
    const b = await computeContentHash({ width: 2, height: 4, rgba: new Uint8ClampedArray(32).fill(50) });
    expect(a).not.toBe(b);
  });
});

describe('computeLuminanceStdDev', () => {
  it('a uniform image (one color) has a stddev ~0 (floating-point rounding errors)', () => {
    expect(computeLuminanceStdDev(image(10, 10, 128))).toBeCloseTo(0, 3);
  });

  it('a black-and-white checkerboard has a large stddev', () => {
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const isBlack = (x + y) % 2 === 0;
        const v = isBlack ? 0 : 255;
        rgba[i] = v;
        rgba[i + 1] = v;
        rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
    expect(computeLuminanceStdDev({ width, height, rgba })).toBeGreaterThan(100);
  });
});

describe('computeUniformColorFraction', () => {
  it('is 1 for a single-color image', () => {
    expect(computeUniformColorFraction(image(100, 100, 255))).toBe(1);
  });

  it('tolerates tiny deviations from the dominant color (compression noise)', () => {
    const img = image(100, 100, 250);
    for (let p = 0; p < 100 * 100; p += 3) img.rgba[p * 4] = 245; // 5 levels off on the red channel
    expect(computeUniformColorFraction(img)).toBe(1);
  });

  it('is low for a half black / half white image', () => {
    const img = image(100, 100, 255);
    for (let p = 0; p < 5000; p++) {
      img.rgba[p * 4] = 0;
      img.rgba[p * 4 + 1] = 0;
      img.rgba[p * 4 + 2] = 0;
    }
    expect(computeUniformColorFraction(img)).toBeLessThan(0.6);
  });

  it('a sparse line drawing on white (a few percent ink) stays well below the hiding fraction', () => {
    const img = image(200, 200, 255);
    for (let y = 0; y < 200; y += 20) for (let x = 0; x < 200; x++) for (let c = 0; c < 3; c++) img.rgba[(y * 200 + x) * 4 + c] = 0;
    expect(computeUniformColorFraction(img)).toBeLessThan(0.99);
  });
});

describe('computeSmoothnessMetrics', () => {
  /** A soft radial vignette (bright center, darker edges) plus mild pixel noise, like a scanned paper background. */
  function vignette(width: number, height: number, noise: number): DecodedImage {
    const img = image(width, height, 255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x / width - 0.5) * 2;
        const dy = (y / height - 0.5) * 2;
        const v = 250 - 45 * Math.min(1, dx * dx + dy * dy) + (Math.random() - 0.5) * 2 * noise;
        const i = (y * width + x) * 4;
        img.rgba[i] = v;
        img.rgba[i + 1] = v + 6;
        img.rgba[i + 2] = v + 5;
      }
    }
    return img;
  }

  it('a noisy paper vignette is smooth at both scales', () => {
    const m = computeSmoothnessMetrics(vignette(1200, 900, 4));
    expect(m.coarseGradient).toBeLessThan(3.2);
    expect(m.fineGradient).toBeLessThan(6); // noise raises the fine measure — the coarse one is what stays low
  });

  it('a clean vignette is below both hiding thresholds', () => {
    const m = computeSmoothnessMetrics(vignette(1200, 900, 0));
    expect(m.coarseGradient).toBeLessThan(3.2);
    expect(m.fineGradient).toBeLessThan(1.5);
  });

  it('thin dark lines on white (line art) are NOT smooth', () => {
    const img = image(1200, 900, 255);
    for (let y = 0; y < 900; y += 30) for (let x = 0; x < 1200; x++) for (let c = 0; c < 3; c++) img.rgba[(y * 1200 + x) * 4 + c] = 20;
    for (let x = 0; x < 1200; x += 30) for (let y = 0; y < 900; y++) for (let c = 0; c < 3; c++) img.rgba[(y * 1200 + x) * 4 + c] = 20;
    const m = computeSmoothnessMetrics(img);
    expect(m.coarseGradient >= 3.2 || m.fineGradient >= 1.5).toBe(true);
  });

  it('artwork drawn ONLY in the alpha channel (a pencil sketch on a transparent page) is not ignored', () => {
    const img = image(600, 600, 0); // fully transparent black
    for (let y = 100; y < 500; y++) for (let x = 0; x < 600; x++) if ((x + y) % 24 < 3) img.rgba[(y * 600 + x) * 4 + 3] = 200; // diagonal strokes
    const m = computeSmoothnessMetrics(img);
    expect(m.fineGradient).toBeGreaterThan(1.5);
  });

  it('images too small to measure at block level are never reported as smooth', () => {
    expect(computeSmoothnessMetrics(image(4, 4, 200)).coarseGradient).toBe(Infinity);
  });
});

describe('closeCorrelationByHash', () => {
  it('counts closedByBBox from entries that have correlatedWith', () => {
    const a = entry({ objId: 'a' });
    const b = entry({ objId: 'b', correlatedWith: 'a' });
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'h1' },
      { entry: b, contentHash: 'h2' },
    ]);
    expect(result.closedByBBox).toBe(1);
  });

  it('closes an ADDITIONAL correlation through an identical hash, which the bbox didn\'t catch', () => {
    const a = entry({ objId: 'a', occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }] });
    const b = entry({ objId: 'b', occurrences: [{ page: 5, bbox: { minX: 100, minY: 100, maxX: 110, maxY: 110 }, index: 0 }] }); // a different position, the bbox does NOT correlate
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'same-hash' },
      { entry: b, contentHash: 'same-hash' },
    ]);
    expect(result.closedByHash).toBe(1); // one of the two remapped to the canonical one
    expect(result.canonicalObjIdByObjId.size).toBe(1);
  });

  it('does NOT close anything additional when the hashes differ', () => {
    const a = entry({ objId: 'a' });
    const b = entry({ objId: 'b' });
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'h1' },
      { entry: b, contentHash: 'h2' },
    ]);
    expect(result.closedByHash).toBe(0);
    expect(result.canonicalObjIdByObjId.size).toBe(0);
  });

  it('a deterministic canonical choice — more occurrences win, a tie broken by objId', () => {
    const a = entry({ objId: 'a', occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, index: 0 }] });
    const b = entry({
      objId: 'b',
      occurrences: [
        { page: 2, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, index: 0 },
        { page: 3, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, index: 0 },
      ],
    });
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'same' },
      { entry: b, contentHash: 'same' },
    ]);
    // "b" has more occurrences (2 vs 1) -> "a" is remapped TO "b".
    expect(result.canonicalObjIdByObjId.get('a')).toBe('b');
    expect(result.canonicalObjIdByObjId.has('b')).toBe(false);
  });

  it('inline entries (objId=null) are skipped in the correlation by hash', () => {
    const inline = entry({ objId: null });
    const result = closeCorrelationByHash([{ entry: inline, contentHash: 'h1' }]);
    expect(result.canonicalObjIdByObjId.size).toBe(0);
  });
});

describe('classifyTargetKind', () => {
  it('non-content always gives unknown', () => {
    expect(classifyTargetKind({ width: 2000, height: 2000, classification: 'decoration', nearStatblockOrHeading: false })).toBe('unknown');
  });

  it('a large resolution + an aspect ratio 0.5-2.2 -> scene', () => {
    expect(classifyTargetKind({ width: 1600, height: 1200, classification: 'content', nearStatblockOrHeading: false })).toBe('scene');
  });

  it('a medium resolution, doesn\'t meet scene -> handout', () => {
    expect(classifyTargetKind({ width: 600, height: 600, classification: 'content', nearStatblockOrHeading: false })).toBe('handout');
  });

  it('small + a portrait aspect ratio + adjacency of a statblock/heading -> portrait', () => {
    expect(classifyTargetKind({ width: 200, height: 250, classification: 'content', nearStatblockOrHeading: true })).toBe('portrait');
  });

  it('small + a portrait aspect ratio but WITHOUT adjacency -> not portrait (falls to unknown, below the handout threshold)', () => {
    expect(classifyTargetKind({ width: 200, height: 250, classification: 'content', nearStatblockOrHeading: false })).toBe('unknown');
  });

  it('too small for anything -> unknown', () => {
    expect(classifyTargetKind({ width: 50, height: 50, classification: 'content', nearStatblockOrHeading: false })).toBe('unknown');
  });
});

describe('finalizeImages', () => {
  it('[user request] hides a single-color image from the auto-detected list, even with a strong content signal', async () => {
    const p = await prepared(entry({ objId: 'blank' }), image(500, 500, 255), { confidence: 0.9, uniformColorFraction: 1 });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('decoration');
  });

  it('[user request] hides a single-color image classified as undecided too', async () => {
    const p = await prepared(entry({ objId: 'blank-undecided' }), image(500, 500, 255), { classification: 'undecided', confidence: 0.4, uniformColorFraction: 0.998 });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('decoration');
  });

  it('[user request] keeps an image that is mostly one color but has real content (below the uniform fraction)', async () => {
    const p = await prepared(entry({ objId: 'sparse-map' }), image(500, 500, 255), { confidence: 0.9, uniformColorFraction: 0.97 });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('content');
  });

  it('[user request] hides a smooth paper background (both gradients low), even when classified undecided or with a strong content signal', async () => {
    const smooth = { coarseGradient: 1.7, fineGradient: 0.6 };
    const strong = await prepared(entry({ objId: 'bg-strong' }), image(900, 900, 200), { confidence: 0.9, smoothness: smooth });
    const undecided = await prepared(entry({ objId: 'bg-undecided' }), image(900, 900, 201), { classification: 'undecided', confidence: 0.4, smoothness: smooth });
    expect(finalizeImages([strong, undecided], new Set()).images.map((i) => i.classification)).toEqual(['decoration', 'decoration']);
  });

  it('[user request] keeps an image that is smooth at only ONE scale (a faint sketch: low coarse but real fine detail)', async () => {
    const p = await prepared(entry({ objId: 'faint-sketch' }), image(900, 900, 200), { classification: 'undecided', confidence: 0.2, smoothness: { coarseGradient: 2.5, fineGradient: 2.9 } });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('[user request] hides a long, narrow image (a typical frame/border strip) — content or undecided', async () => {
    const wide = await prepared(entry({ objId: 'strip-wide' }), image(1200, 100, 128), { confidence: 0.9 });
    const tall = await prepared(entry({ objId: 'strip-tall' }), image(100, 900, 128), { classification: 'undecided', confidence: 0.4 });
    const result = finalizeImages([wide, tall], new Set());
    expect(result.images.map((i) => i.classification)).toEqual(['decoration', 'decoration']);
  });

  it('[user request] keeps an image just below the long-and-narrow ratio', async () => {
    const p = await prepared(entry({ objId: 'banner' }), image(1000, 200, 128), { confidence: 0.9 }); // 5:1
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('content');
  });

  it('reclassifies content below 100px to undecided (NOT decoration — without calibration or a chance for review), with a Diagnostic', async () => {
    const p = await prepared(entry({ objId: 'tiny' }), image(50, 50, 10));
    const diagnostics: Diagnostic[] = [];
    const result = finalizeImages([p], new Set(), diagnostics);
    expect(result.images[0]!.classification).toBe('undecided');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('IMAGE_TOO_SMALL_UNDECIDED');
  });

  it('reclassifies content with a LOW luminanceStdDev (a flat texture) to decoration', async () => {
    const p = await prepared(entry({ objId: 'flat-texture' }), image(500, 500, 200), { luminanceStdDev: 2.33 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('decoration');
  });

  it('does NOT reclassify content with a HIGH luminanceStdDev (a real illustration)', async () => {
    const p = await prepared(entry({ objId: 'real-content' }), image(500, 500, 200), { luminanceStdDev: 71.74 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('no luminanceStdDev (e.g. tests without real pixels) skips the "flat texture" reclassification', async () => {
    const p = await prepared(entry({ objId: 'no-metric' }), image(500, 500, 200));
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('content with a STRONG signal (confidence>=0.6) and a LOW luminanceStdDev -> does NOT reclassify (a line-art map on a white background)', async () => {
    // A real case: an investigator's map from a quick-start PDF — a black line on a white
    // background, `Z1-large-relative-area` (confidence 0.9), a low stddev for EXACTLY the same
    // geometric reason as a flat parchment texture (a dominant light background) — but it is
    // genuinely content, not decoration.
    const p = await prepared(entry({ objId: 'line-art-map' }), image(500, 500, 200), { confidence: 0.9, luminanceStdDev: 8.5 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('deduplicates entries with the same contentHash, keeping the FIRST one as the representative', async () => {
    const imgA = image(4, 4, 77);
    const imgB = image(4, 4, 77); // identical content -> the same hash
    const pA = await prepared(entry({ objId: 'a', occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, index: 0 }] }), imgA);
    const pB = await prepared(entry({ objId: 'b', occurrences: [{ page: 9, bbox: { minX: 500, minY: 500, maxX: 700, maxY: 700 }, index: 0 }] }), imgB);
    const result = finalizeImages([pA, pB], new Set());
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.entry.objId).toBe('a');
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.correlationClosedByHash).toBe(1);
  });

  it('assigns targetKind based on dimensions and adjacency', async () => {
    const pScene = await prepared(entry({ objId: 'scene1' }), image(1600, 1200, 1));
    const pPortrait = await prepared(entry({ objId: 'portrait1' }), image(200, 250, 1));
    const result = finalizeImages([pScene, pPortrait], new Set(['portrait1']));
    const scene = result.images.find((i) => i.entry.objId === 'scene1');
    const portrait = result.images.find((i) => i.entry.objId === 'portrait1');
    expect(scene!.targetKind).toBe('scene');
    expect(portrait!.targetKind).toBe('portrait');
  });

  it('carries the representative\'s payload unchanged into the result', async () => {
    const p = await prepared(entry({ objId: 'a' }), image(500, 500, 1), { payload: { encodedBytes: [1, 2, 3] } });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.payload).toEqual({ encodedBytes: [1, 2, 3] });
  });

  it('determinism: two calls with the same data give an identical result', async () => {
    const p = await prepared(entry({ objId: 'a' }), image(500, 500, 42));
    const r1 = finalizeImages([p], new Set());
    const r2 = finalizeImages([p], new Set());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
