import { describe, expect, it } from 'vitest';
import {
  classifyTargetKind,
  closeCorrelationByHash,
  computeContentHash,
  computeLuminanceStdDev,
  computeOpaqueFraction,
  computeDarkOpaqueShare,
  computeVisibleLuminanceStdDev,
  computeSmoothnessMetrics,
  computeUniformColorFraction,
  finalizeImages,
  isBookOfTextPanels,
  repeatedPanelLooks,
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

  it('keeps a dark smooth picture (a figure in red light) that is not flat; hides a dark flat panel and a light smooth sheet of the same smoothness', async () => {
    const smooth = { coarseGradient: 2.3, fineGradient: 1.35 };
    const picture = await prepared(entry({ objId: 'red-light' }), image(900, 900, 90), { classification: 'undecided', confidence: 0.4, smoothness: smooth, visibleLuminanceStdDev: 23.5, meanLuminance: 53 });
    const flatPanel = await prepared(entry({ objId: 'dark-panel' }), image(900, 900, 91), { classification: 'undecided', confidence: 0.4, smoothness: smooth, visibleLuminanceStdDev: 10, meanLuminance: 30 });
    const lightSheet = await prepared(entry({ objId: 'parchment' }), image(900, 900, 92), { classification: 'undecided', confidence: 0.4, smoothness: smooth, visibleLuminanceStdDev: 23.5, meanLuminance: 212 });
    expect(finalizeImages([picture, flatPanel, lightSheet], new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'decoration', 'decoration']);
  });

  it('[user request] keeps an image that is smooth at only ONE scale (a faint sketch: low coarse but real fine detail)', async () => {
    const p = await prepared(entry({ objId: 'faint-sketch' }), image(900, 900, 200), { classification: 'undecided', confidence: 0.2, smoothness: { coarseGradient: 2.5, fineGradient: 2.9 } });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('hides a page-sized undecided sheet of paper that is smooth at the coarse scale even when the grain raises the fine gradient', async () => {
    const paper = await prepared(entry({ objId: 'paper', maxRelativeArea: 1.01 }), image(900, 900, 200), { classification: 'undecided', confidence: 0.4, smoothness: { coarseGradient: 1.9, fineGradient: 3.3 } });
    expect(finalizeImages([paper], new Set()).images[0]!.classification).toBe('decoration');
  });

  it('keeps a page-sized undecided image with real coarse detail (a cover, a full-page picture)', async () => {
    const art = await prepared(entry({ objId: 'cover', maxRelativeArea: 1.2 }), image(900, 900, 200), { classification: 'undecided', confidence: 0.4, smoothness: { coarseGradient: 7.2, fineGradient: 3.0 } });
    expect(finalizeImages([art], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('keeps a page-sized undecided scene that is smooth but has a subject (a luminance spread of a picture), hides the sheet with a flat spread', async () => {
    const smooth = { coarseGradient: 2.3, fineGradient: 1.2 };
    const scene = await prepared(entry({ objId: 'night-scene', maxRelativeArea: 0.91 }), image(900, 900, 200), { classification: 'undecided', confidence: 0.4, smoothness: smooth, visibleLuminanceStdDev: 33.7 });
    const sheet = await prepared(entry({ objId: 'flat-sheet', maxRelativeArea: 0.91 }), image(900, 900, 201), { classification: 'undecided', confidence: 0.4, smoothness: smooth, visibleLuminanceStdDev: 21 });
    expect(finalizeImages([scene, sheet], new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'decoration']);
  });

  it('hides a light page-sized sheet with dark shapes on it (a high spread from a few blots) even though the spread is that of a picture', async () => {
    const blotted = await prepared(entry({ objId: 'white-with-blots', maxRelativeArea: 0.95 }), image(900, 900, 202), { classification: 'undecided', confidence: 0.4, smoothness: { coarseGradient: 2.5, fineGradient: 2.1 }, visibleLuminanceStdDev: 58, meanLuminance: 239 });
    expect(finalizeImages([blotted], new Set()).images[0]!.classification).toBe('decoration');
  });

  it('keeps a smaller undecided image with the same smoothness (the large-sheet rule needs a page-sized image)', async () => {
    const p = await prepared(entry({ objId: 'half-page', maxRelativeArea: 0.5 }), image(900, 900, 200), { classification: 'undecided', confidence: 0.4, smoothness: { coarseGradient: 1.9, fineGradient: 3.3 } });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('keeps a page-sized grainy, high-contrast image (the fine limit)', async () => {
    const p = await prepared(entry({ objId: 'noisy', maxRelativeArea: 1 }), image(900, 900, 200), { classification: 'undecided', confidence: 0.4, smoothness: { coarseGradient: 2.0, fineGradient: 6 } });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('hides a picture with next to no visible pixels whatever its size (a glow layer over an illustration), keeps a sparse one with real content', async () => {
    const glow = await prepared(entry({ objId: 'glow', maxRelativeArea: 0.54 }), image(900, 900, 120), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.004 });
    const sparse = await prepared(entry({ objId: 'sparse-figure', maxRelativeArea: 0.4 }), image(900, 900, 121), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.031 });
    expect(finalizeImages([glow, sparse], new Set()).images.map((i) => i.classification)).toEqual(['decoration', 'undecided']);
  });

  it('hides a small undecided image that is mostly transparent (a paperclip), keeps a small opaque one', async () => {
    const clip = await prepared(entry({ objId: 'clip', maxRelativeArea: 0.01 }), image(100, 100, 100), { classification: 'undecided', confidence: 0.2, opaqueFraction: 0.12 });
    const emblem = await prepared(entry({ objId: 'emblem', maxRelativeArea: 0.01 }), image(100, 100, 101), { classification: 'undecided', confidence: 0.2, opaqueFraction: 1 });
    expect(finalizeImages([clip, emblem], new Set()).images.map((i) => i.classification)).toEqual(['decoration', 'undecided']);
  });

  it('keeps a sparse image that covers a real share of the page (smoke, a splatter)', async () => {
    const p = await prepared(entry({ objId: 'smoke', maxRelativeArea: 0.2 }), image(100, 100, 100), { classification: 'undecided', confidence: 0.2, opaqueFraction: 0.13 });
    expect(finalizeImages([p], new Set()).images[0]!.classification).toBe('undecided');
  });

  it('computeDarkOpaqueShare: the share of visible pixels that are black, 0 when nothing is visible', () => {
    // visible black, visible black, visible white, invisible white
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 10, 10, 10, 200, 255, 255, 255, 255, 255, 255, 255, 0]);
    expect(computeDarkOpaqueShare({ width: 4, height: 1, rgba })).toBeCloseTo(2 / 3);
    expect(computeDarkOpaqueShare({ width: 1, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 0]) })).toBe(0);
  });

  it('computeVisibleLuminanceStdDev ignores invisible pixels: one flat color is 0, black and white is about 127', () => {
    const flat = new Uint8ClampedArray([40, 40, 40, 255, 40, 40, 40, 255, 255, 255, 255, 0]);
    expect(computeVisibleLuminanceStdDev({ width: 3, height: 1, rgba: flat })).toBeCloseTo(0);
    const contrast = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(computeVisibleLuminanceStdDev({ width: 2, height: 1, rgba: contrast })).toBeGreaterThan(120);
  });

  it('computeOpaqueFraction counts pixels with alpha above 16', () => {
    const rgba = new Uint8ClampedArray(4 * 4);
    rgba[3] = 255;
    rgba[7] = 17;
    rgba[11] = 16;
    expect(computeOpaqueFraction({ width: 4, height: 1, rgba })).toBeCloseTo(0.5);
  });

  it('[user request] hides a long, narrow image (a typical frame/border strip) — content or undecided', async () => {
    const wide = await prepared(entry({ objId: 'strip-wide' }), image(1200, 100, 128), { confidence: 0.9 });
    const tall = await prepared(entry({ objId: 'strip-tall' }), image(100, 900, 128), { classification: 'undecided', confidence: 0.4 });
    const result = finalizeImages([wide, tall], new Set());
    expect(result.images.map((i) => i.classification)).toEqual(['decoration', 'decoration']);
  });

  it('keeps a long, narrow drawn object (a spear: strong contrast, gaps in it) and a sparse one (a bow), hides the same shapes when they are pale or flat', async () => {
    const spear = await prepared(entry({ objId: 'spear' }), image(550, 28, 128), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.52, visibleLuminanceStdDev: 69 });
    const bow = await prepared(entry({ objId: 'bow', maxRelativeArea: 0.018 }), image(360, 101, 129), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.28, visibleLuminanceStdDev: 67 });
    const divider = await prepared(entry({ objId: 'divider' }), image(956, 17, 130), { classification: 'undecided', confidence: 0.4, opaqueFraction: 1, visibleLuminanceStdDev: 31 });
    const paperclip = await prepared(entry({ objId: 'paperclip', maxRelativeArea: 0.02 }), image(150, 200, 131), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.1, visibleLuminanceStdDev: 44 });
    expect(finalizeImages([spear, bow, divider, paperclip], new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'undecided', 'decoration', 'decoration']);
  });

  it('on a page that holds two or more drawn objects, a staff and a bow painted in slightly weaker contrast are drawn objects too; on another page they are hidden', async () => {
    const onPage = (page: number) => ({ occurrences: [{ page, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }] });
    const spearOf = (page: number, id: string, fill: number) => prepared(entry({ objId: id, ...onPage(page) }), image(19, 364, fill), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.38, visibleLuminanceStdDev: 77 });
    const staffOf = (page: number, id: string) => prepared(entry({ objId: id, ...onPage(page) }), image(18, 376, 128), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.71, visibleLuminanceStdDev: 54 });
    const bowOf = (page: number, id: string) => prepared(entry({ objId: id, maxRelativeArea: 0.029, ...onPage(page) }), image(63, 223, 128), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.29, visibleLuminanceStdDev: 63 });
    const rack = [await spearOf(1, 'spear1', 120), await spearOf(1, 'spear2', 121), await staffOf(1, 'staff'), await bowOf(1, 'bow')];
    expect(finalizeImages(rack, new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'undecided', 'undecided', 'undecided']);
    const alone = [await spearOf(2, 'spear3', 122), await staffOf(3, 'staff2'), await bowOf(3, 'bow2')];
    expect(finalizeImages(alone, new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'decoration', 'decoration']);
  });

  it('on a page with three or more cut-out pictures of some size (a page of items), the sparse ones beside them are offered too, a pistol of low contrast included; on a page with two they are hidden', async () => {
    const onPage = (page: number) => ({ occurrences: [{ page, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }] });
    const cutOut = (page: number, id: string, fill: number, std: number, area = 0.04) => prepared(entry({ objId: id, maxRelativeArea: area, ...onPage(page) }), image(341, 211, fill), { classification: 'undecided', confidence: 0.4, opaqueFraction: 0.15, visibleLuminanceStdDev: std });
    const items = [await cutOut(1, 'tape', 120, 52), await cutOut(1, 'rope', 121, 41), await cutOut(1, 'knife', 122, 36), await cutOut(1, 'pistol', 123, 28)];
    expect(finalizeImages(items, new Set()).images.map((i) => i.classification)).toEqual(['undecided', 'undecided', 'undecided', 'undecided']);
    const pair = [await cutOut(2, 'clip1', 124, 52), await cutOut(2, 'clip2', 125, 41), await cutOut(2, 'pistol2', 126, 28)];
    expect(finalizeImages(pair, new Set()).images.map((i) => i.classification)).toEqual(['decoration', 'decoration', 'decoration']);
  });

  it('a book whose layout is panels of text (a quarter of the pictures offered, ten or more) has the panels hidden; a book with a few documents keeps them', async () => {
    const panel = (id: string, fill: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'undecided', confidence: 0.4, textPanelCandidate: true });
    const picture = (id: string, fill: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'content', confidence: 0.9, luminanceStdDev: 70 });
    const book = [...(await Promise.all(Array.from({ length: 10 }, (_, i) => panel(`panel${i}`, 100 + i)))), ...(await Promise.all(Array.from({ length: 20 }, (_, i) => picture(`pic${i}`, 130 + i))))];
    const result = finalizeImages(book, new Set()).images;
    expect(result.filter((i) => i.classification === 'decoration')).toHaveLength(10);
    expect(result.filter((i) => i.classification === 'content')).toHaveLength(20);
    const documents = [...(await Promise.all(Array.from({ length: 3 }, (_, i) => panel(`doc${i}`, 100 + i)))), ...(await Promise.all(Array.from({ length: 20 }, (_, i) => picture(`pic${i}`, 130 + i))))];
    expect(finalizeImages(documents, new Set()).images.filter((i) => i.classification === 'decoration')).toHaveLength(0);
  });

  it('a panel of text whose raster is found twice in a book of few panels is the layout: both are hidden, a single one (a handout) is kept', async () => {
    const panel = (id: string, fill: number, key: string) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'undecided', confidence: 0.4, textPanelCandidate: true, textPanelKey: key });
    const picture = (id: string, fill: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'content', confidence: 0.9, luminanceStdDev: 70 });
    const pictures = await Promise.all(Array.from({ length: 20 }, (_, i) => picture(`pic${i}`, 130 + i)));
    const book = [await panel('sidebarA', 100, '324x1711:13.1:0.2'), await panel('sidebarB', 101, '324x1711:13.1:0.2'), await panel('handout', 102, '600x800:20.0:3.0'), ...pictures];
    const result = finalizeImages(book, new Set()).images;
    const byId = new Map(result.map((i) => [i.entry.objId, i.classification]));
    expect(byId.get('sidebarA')).toBe('decoration');
    expect(byId.get('sidebarB')).toBe('decoration');
    expect(byId.get('handout')).toBe('undecided');
  });

  it('a tinted panel of text whose look is shared by five or more other panels is the layout and is hidden; a lone one, or one with a look of its own, is kept', async () => {
    const look = (stdDev: number, saturation: number, mean: number) => ({ stdDev, saturation, mean, coverage: 0.3, textOnCenter: false });
    const panel = (id: string, fill: number, textPanelLook: ReturnType<typeof look>) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'undecided', confidence: 0.4, textPanelLook });
    const picture = (id: string, fill: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'content', confidence: 0.9, luminanceStdDev: 70 });
    const cards = await Promise.all(Array.from({ length: 6 }, (_, i) => panel(`card${i}`, 100 + i, look(24.5 + i * 0.2, 44 + i * 0.5, 210 + i))));
    const lone = await panel('lone', 120, look(55, 20, 140));
    const pictures = await Promise.all(Array.from({ length: 30 }, (_, i) => picture(`pic${i}`, 130 + i)));
    const result = finalizeImages([...cards, lone, ...pictures], new Set()).images;
    expect(result.filter((i) => i.entry.objId?.startsWith('card') && i.classification === 'decoration')).toHaveLength(6);
    expect(result.find((i) => i.entry.objId === 'lone')!.classification).toBe('undecided');
    expect(result.filter((i) => i.classification === 'content')).toHaveLength(30);
  });

  it('a smooth panel on which the text covers half of its box or more (a quarter on light paper) is a box of text and is hidden; one with less text, a darker one, and one with a look of its own, are kept', async () => {
    const panel = (id: string, fill: number, coverage: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'undecided', confidence: 0.4, textPanelLook: { stdDev: 8.3, saturation: 86, mean: 197, coverage, textOnCenter: true } });
    const picture = (id: string, fill: number) => prepared(entry({ objId: id }), image(500, 300, fill), { classification: 'content', confidence: 0.9, luminanceStdDev: 70 });
    const wrapped = await prepared(entry({ objId: 'wrapped' }), image(500, 300, 102), { classification: 'undecided', confidence: 0.4, textPanelLook: { stdDev: 8.3, saturation: 86, mean: 197, coverage: 0.7, textOnCenter: false } });
    const darkMap = await prepared(entry({ objId: 'map' }), image(500, 300, 104), { classification: 'undecided', confidence: 0.4, textPanelLook: { stdDev: 30, saturation: 60, mean: 139, coverage: 0.28, textOnCenter: true } });
    const book = [await panel('note', 100, 0.59), await panel('letter', 103, 0.3), await panel('sidebar', 101, 0.2), darkMap, wrapped, ...(await Promise.all(Array.from({ length: 10 }, (_, i) => picture(`pic${i}`, 130 + i))))];
    const byId = new Map(finalizeImages(book, new Set()).images.map((i) => [i.entry.objId, i.classification]));
    expect(byId.get('note')).toBe('decoration');
    expect(byId.get('letter')).toBe('decoration');
    expect(byId.get('map')).toBe('undecided');
    expect(byId.get('sidebar')).toBe('undecided');
    expect(byId.get('wrapped')).toBe('undecided');
  });

  it('a render that the page\'s text fills is a box of text whatever its look', async () => {
    const paper = await prepared(entry({ objId: 'paper' }), image(500, 300, 100), { classification: 'undecided', confidence: 0.4, textFillsBox: true });
    const picture = await prepared(entry({ objId: 'picture' }), image(500, 300, 101), { classification: 'undecided', confidence: 0.4 });
    const byId = new Map(finalizeImages([paper, picture], new Set()).images.map((i) => [i.entry.objId, i]));
    expect(byId.get('paper')).toMatchObject({ classification: 'decoration', holdsText: true });
    expect(byId.get('picture')!.classification).toBe('undecided');
  });

  it('a plain card of light paper that the page\'s text lies on is a box of text however little of it the text covers', async () => {
    const strip = await prepared(entry({ objId: 'strip' }), image(500, 300, 100), { classification: 'content', confidence: 0.6, textOnPaperCard: true });
    const picture = await prepared(entry({ objId: 'picture' }), image(500, 300, 101), { classification: 'content', confidence: 0.6 });
    const byId = new Map(finalizeImages([strip, picture], new Set()).images.map((i) => [i.entry.objId, i]));
    expect(byId.get('strip')).toMatchObject({ classification: 'decoration', holdsText: true });
    expect(byId.get('picture')!.classification).toBe('content');
  });

  it('marks a hidden box of text so that the review can offer it, and nothing else that is hidden', async () => {
    const note = await prepared(entry({ objId: 'note' }), image(500, 300, 100), { classification: 'undecided', confidence: 0.4, textPanelLook: { stdDev: 8.3, saturation: 86, mean: 197, coverage: 0.59, textOnCenter: true } });
    const blank = await prepared(entry({ objId: 'blank' }), image(500, 300, 128), { classification: 'undecided', confidence: 0.4, uniformColorFraction: 1 });
    const mask = await prepared(entry({ objId: 'mask' }), image(500, 300, 90), { classification: 'mask', confidence: 0.4, textPanelLook: { stdDev: 8.3, saturation: 86, mean: 197, coverage: 0.9, textOnCenter: true } });
    const byId = new Map(finalizeImages([note, blank, mask], new Set()).images.map((i) => [i.entry.objId, i]));
    expect(byId.get('note')).toMatchObject({ classification: 'decoration', holdsText: true });
    expect(byId.get('blank')).toMatchObject({ classification: 'decoration' });
    expect(byId.get('blank')!.holdsText).toBeUndefined();
    expect(byId.get('mask')!.holdsText).toBeUndefined();
  });

  it('repeatedPanelLooks counts only the other panels of the same look', () => {
    const at = (stdDev: number) => ({ textPanelLook: { stdDev, saturation: 40, mean: 200, coverage: 0.3, textOnCenter: false } });
    const six = Array.from({ length: 6 }, () => at(20));
    expect(repeatedPanelLooks([...six, at(40)]).size).toBe(6);
    expect(repeatedPanelLooks(six.slice(0, 5)).size).toBe(0);
  });

  it('isBookOfTextPanels needs both the count and the share', () => {
    expect(isBookOfTextPanels(192, 260)).toBe(true);
    expect(isBookOfTextPanels(9, 20)).toBe(false);
    expect(isBookOfTextPanels(20, 107)).toBe(false);
    expect(isBookOfTextPanels(0, 0)).toBe(false);
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

  it('pictures that fill the page and share a size and a place (a map set) are told apart by their pixels', async () => {
    const pA = await prepared(entry({ objId: 'mapA', maxRelativeArea: 0.96 }), image(4, 4, 10));
    const pB = await prepared(entry({ objId: 'mapB', maxRelativeArea: 0.96, correlatedWith: 'mapA' }), image(4, 4, 200));
    const result = finalizeImages([pA, pB], new Set());
    expect(result.images.map((i) => i.entry.objId)).toEqual(['mapA', 'mapB']);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it('big pictures of the same size and place with the same pixels are one picture', async () => {
    const pA = await prepared(entry({ objId: 'mapA', maxRelativeArea: 0.96 }), image(4, 4, 10));
    const pB = await prepared(entry({ objId: 'mapB', maxRelativeArea: 0.96, correlatedWith: 'mapA' }), image(4, 4, 10));
    const result = finalizeImages([pA, pB], new Set());
    expect(result.images.map((i) => i.entry.objId)).toEqual(['mapA']);
  });

  it('small pictures linked by size and place stay one picture whatever their pixels (frames, icons)', async () => {
    const pA = await prepared(entry({ objId: 'iconA', maxRelativeArea: 0.02 }), image(4, 4, 10));
    const pB = await prepared(entry({ objId: 'iconB', maxRelativeArea: 0.02, correlatedWith: 'iconA' }), image(4, 4, 11));
    const result = finalizeImages([pA, pB], new Set());
    expect(result.images).toHaveLength(1);
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
