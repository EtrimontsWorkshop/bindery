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
    // [KROK-17] Domyslnie SLABY sygnal (odpowiada `Z2-moderate-area-no-mask-evidence`
    // z classify.ts, przypadek na ktorym FLAT_TEXTURE_STDDEV_THRESHOLD zostal
    // skalibrowany) — testy silnego sygnalu (np. `Z1-large-relative-area`, 0,9)
    // nadpisuja jawnie przez `overrides`.
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
  it('daje identyczny hash dla identycznej tresci (determinizm)', async () => {
    const a = await computeContentHash(image(4, 4, 100));
    const b = await computeContentHash(image(4, 4, 100));
    expect(a).toBe(b);
  });

  it('daje rozny hash dla roznej tresci pikseli', async () => {
    const a = await computeContentHash(image(4, 4, 100));
    const b = await computeContentHash(image(4, 4, 200));
    expect(a).not.toBe(b);
  });

  it('daje rozny hash dla tych samych pikseli ale innych wymiarow (naglowek koduje width/height)', async () => {
    const a = await computeContentHash({ width: 4, height: 2, rgba: new Uint8ClampedArray(32).fill(50) });
    const b = await computeContentHash({ width: 2, height: 4, rgba: new Uint8ClampedArray(32).fill(50) });
    expect(a).not.toBe(b);
  });
});

describe('computeLuminanceStdDev', () => {
  it('jednolity obraz (jeden kolor) ma stddev ~0 (bledy zaokraglenia zmiennoprzecinkowe)', () => {
    expect(computeLuminanceStdDev(image(10, 10, 128))).toBeCloseTo(0, 3);
  });

  it('szachownica czarno-biala ma duze stddev', () => {
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
  it('liczy closedByBBox z wpisow majacych correlatedWith', () => {
    const a = entry({ objId: 'a' });
    const b = entry({ objId: 'b', correlatedWith: 'a' });
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'h1' },
      { entry: b, contentHash: 'h2' },
    ]);
    expect(result.closedByBBox).toBe(1);
  });

  it('domyka DODATKOWA korelacje przez identyczny hash, ktorej bbox nie zlapal', () => {
    const a = entry({ objId: 'a', occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }] });
    const b = entry({ objId: 'b', occurrences: [{ page: 5, bbox: { minX: 100, minY: 100, maxX: 110, maxY: 110 }, index: 0 }] }); // inna pozycja, bbox NIE koreluje
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'same-hash' },
      { entry: b, contentHash: 'same-hash' },
    ]);
    expect(result.closedByHash).toBe(1); // jeden z dwoch przemapowany na kanon
    expect(result.canonicalObjIdByObjId.size).toBe(1);
  });

  it('NIE domyka niczego dodatkowego gdy hashe sa rozne', () => {
    const a = entry({ objId: 'a' });
    const b = entry({ objId: 'b' });
    const result = closeCorrelationByHash([
      { entry: a, contentHash: 'h1' },
      { entry: b, contentHash: 'h2' },
    ]);
    expect(result.closedByHash).toBe(0);
    expect(result.canonicalObjIdByObjId.size).toBe(0);
  });

  it('kanoniczny wybor deterministyczny — wiecej wystapien wygrywa, remis po objId', () => {
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
    // "b" ma wiecej wystapien (2 vs 1) -> "a" zostaje przemapowane NA "b".
    expect(result.canonicalObjIdByObjId.get('a')).toBe('b');
    expect(result.canonicalObjIdByObjId.has('b')).toBe(false);
  });

  it('wpisy inline (objId=null) sa pomijane w korelacji przez hash', () => {
    const inline = entry({ objId: null });
    const result = closeCorrelationByHash([{ entry: inline, contentHash: 'h1' }]);
    expect(result.canonicalObjIdByObjId.size).toBe(0);
  });
});

describe('classifyTargetKind', () => {
  it('nie-content zawsze daje unknown', () => {
    expect(classifyTargetKind({ width: 2000, height: 2000, classification: 'decoration', nearStatblockOrHeading: false })).toBe('unknown');
  });

  it('duza rozdzielczosc + proporcje 0.5-2.2 -> scene', () => {
    expect(classifyTargetKind({ width: 1600, height: 1200, classification: 'content', nearStatblockOrHeading: false })).toBe('scene');
  });

  it('srednia rozdzielczosc, nie spelnia scene -> handout', () => {
    expect(classifyTargetKind({ width: 600, height: 600, classification: 'content', nearStatblockOrHeading: false })).toBe('handout');
  });

  it('mala + proporcje portretowe + sasiedztwo statblock/heading -> portrait', () => {
    expect(classifyTargetKind({ width: 200, height: 250, classification: 'content', nearStatblockOrHeading: true })).toBe('portrait');
  });

  it('mala + proporcje portretowe ale BEZ sasiedztwa -> nie portrait (spada do unknown, ponizej progu handout)', () => {
    expect(classifyTargetKind({ width: 200, height: 250, classification: 'content', nearStatblockOrHeading: false })).toBe('unknown');
  });

  it('zbyt mala na cokolwiek -> unknown', () => {
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

  it('[KROK-43 Z1, naprawa "cicha utrata"] reklasyfikuje content ponizej 100px na undecided (NIE decoration — bez kalibracji ani szansy na przeglad), z Diagnostic', async () => {
    const p = await prepared(entry({ objId: 'tiny' }), image(50, 50, 10));
    const diagnostics: Diagnostic[] = [];
    const result = finalizeImages([p], new Set(), diagnostics);
    expect(result.images[0]!.classification).toBe('undecided');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('IMAGE_TOO_SMALL_UNDECIDED');
  });

  it('[KROK-8 Z2] reklasyfikuje content o NISKIM luminanceStdDev (plaska tekstura) na decoration', async () => {
    const p = await prepared(entry({ objId: 'flat-texture' }), image(500, 500, 200), { luminanceStdDev: 2.33 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('decoration');
  });

  it('[KROK-8 Z2] NIE reklasyfikuje content o WYSOKIM luminanceStdDev (prawdziwa ilustracja)', async () => {
    const p = await prepared(entry({ objId: 'real-content' }), image(500, 500, 200), { luminanceStdDev: 71.74 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('[KROK-8 Z2] brak luminanceStdDev (np. testy bez prawdziwych pikseli) pomija reklasyfikacje "plaskiej tekstury"', async () => {
    const p = await prepared(entry({ objId: 'no-metric' }), image(500, 500, 200));
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('[KROK-17, zgloszony na zywo blad] content z MOCNYM sygnalem (confidence>=0,6) i NISKIM luminanceStdDev -> NIE reklasyfikuje (mapa kreskowa na bialym tle)', async () => {
    // Rzeczywisty przypadek: "Corbitt House Investigator Map" (CHA23131) — czarna
    // kreska na bialym tle, `Z1-large-relative-area` (confidence 0,9), niskie
    // stddev z DOKLADNIE tego samego geometrycznego powodu co plaska tekstura
    // pergaminu (dominujace jasne tlo) — ale to genuinie tresc, nie dekoracja.
    const p = await prepared(entry({ objId: 'line-art-map' }), image(500, 500, 200), { confidence: 0.9, luminanceStdDev: 8.5 });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.classification).toBe('content');
  });

  it('deduplikuje wpisy o tym samym contentHash, zachowujac PIERWSZY jako reprezentanta', async () => {
    const imgA = image(4, 4, 77);
    const imgB = image(4, 4, 77); // identyczna tresc -> ten sam hash
    const pA = await prepared(entry({ objId: 'a', occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, index: 0 }] }), imgA);
    const pB = await prepared(entry({ objId: 'b', occurrences: [{ page: 9, bbox: { minX: 500, minY: 500, maxX: 700, maxY: 700 }, index: 0 }] }), imgB);
    const result = finalizeImages([pA, pB], new Set());
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.entry.objId).toBe('a');
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.correlationClosedByHash).toBe(1);
  });

  it('przypisuje targetKind na podstawie wymiarow i sasiedztwa', async () => {
    const pScene = await prepared(entry({ objId: 'scene1' }), image(1600, 1200, 1));
    const pPortrait = await prepared(entry({ objId: 'portrait1' }), image(200, 250, 1));
    const result = finalizeImages([pScene, pPortrait], new Set(['portrait1']));
    const scene = result.images.find((i) => i.entry.objId === 'scene1');
    const portrait = result.images.find((i) => i.entry.objId === 'portrait1');
    expect(scene!.targetKind).toBe('scene');
    expect(portrait!.targetKind).toBe('portrait');
  });

  it('przenosi payload reprezentanta bez zmian do wyniku', async () => {
    const p = await prepared(entry({ objId: 'a' }), image(500, 500, 1), { payload: { encodedBytes: [1, 2, 3] } });
    const result = finalizeImages([p], new Set());
    expect(result.images[0]!.payload).toEqual({ encodedBytes: [1, 2, 3] });
  });

  it('determinizm: dwa wywolania z tymi samymi danymi daja identyczny wynik', async () => {
    const p = await prepared(entry({ objId: 'a' }), image(500, 500, 42));
    const r1 = finalizeImages([p], new Set());
    const r2 = finalizeImages([p], new Set());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
