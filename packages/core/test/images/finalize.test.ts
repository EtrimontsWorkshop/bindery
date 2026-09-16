import { describe, expect, it } from 'vitest';
import {
  classifyTargetKind,
  closeCorrelationByHash,
  computeContentHash,
  computeLuminanceStdDev,
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
