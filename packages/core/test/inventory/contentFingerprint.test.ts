import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_OPEN_OPTIONS } from '../../src/pdfDocument.js';
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_GRID, fingerprintDecodedImage, fingerprintDistance } from '../../src/inventory/contentFingerprint.js';
import { buildInventory, type PdfDocumentLike } from '../../src/inventory/inventory.js';
import { classifyImages } from '../../src/images/classify.js';
import { build as buildTemplateSlot, PAGE_COUNT } from '../synth/fixtures/images-template-slot.js';

const IMAGE_KIND_RGB_24BPP = 2;

function rgbImage(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 3);
  }
  return { width, height, kind: IMAGE_KIND_RGB_24BPP, data };
}

describe('fingerprintDecodedImage', () => {
  it('gives a grid of luminance values for the { kind, data } shape', () => {
    const fp = fingerprintDecodedImage(rgbImage(40, 40, () => [255, 255, 255]));
    expect(fp).toHaveLength(FINGERPRINT_GRID * FINGERPRINT_GRID);
    expect(fp!.every((v) => v === 255)).toBe(true);
  });

  it('reads a bare 1-bit image mask', () => {
    const width = 16;
    const height = 8;
    const fp = fingerprintDecodedImage({ width, height, data: new Uint8Array((width / 8) * height).fill(0xff) });
    expect(fp!.every((v) => v === 255)).toBe(true);
  });

  it('returns null for what it cannot read', () => {
    expect(fingerprintDecodedImage(null)).toBeNull();
    expect(fingerprintDecodedImage({ width: 10 })).toBeNull();
    // A bitmap without OffscreenCanvas (Node): no fingerprint, no throw.
    expect(fingerprintDecodedImage({ width: 10, height: 10, bitmap: {} })).toBeNull();
  });

  it('reads a bitmap of the browser from a smoothed drawing larger than the grid, each cell the mean of its block', () => {
    const drawn: { w: number; h: number; quality?: string }[] = [];
    class FakeOffscreenCanvas {
      constructor(
        readonly w: number,
        readonly h: number,
      ) {}
      getContext() {
        const ctx = {
          fillStyle: '',
          imageSmoothingQuality: undefined as string | undefined,
          fillRect: () => {},
          drawImage: (_: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ w, h, quality: ctx.imageSmoothingQuality }),
          // Every other pixel black: a cell averages to grey, whatever single pixel a small drawing would land on.
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) % 2 === 0 ? 0 : 255)) }),
        };
        return ctx;
      }
    }
    const g = globalThis as { OffscreenCanvas?: unknown };
    const previous = g.OffscreenCanvas;
    g.OffscreenCanvas = FakeOffscreenCanvas;
    try {
      const fp = fingerprintDecodedImage({ width: 600, height: 400, bitmap: {} });
      expect(drawn).toEqual([{ w: FINGERPRINT_GRID * 4, h: FINGERPRINT_GRID * 4, quality: 'high' }]);
      expect(fp).toHaveLength(FINGERPRINT_GRID * FINGERPRINT_GRID);
      expect(fp!.every((v) => Math.abs(v - 127.5) <= 1)).toBe(true);
    } finally {
      g.OffscreenCanvas = previous;
    }
  });

  it('keeps a re-compressed copy close and tells a different picture apart', () => {
    const left = rgbImage(64, 48, (x) => (x < 32 ? [10, 10, 10] : [240, 240, 240]));
    const noisy = rgbImage(64, 48, (x, y) => {
      const v = (x < 32 ? 10 : 240) + (((x * 7 + y * 3) % 9) - 4);
      return [v, v, v];
    });
    const right = rgbImage(64, 48, (x) => (x < 32 ? [240, 240, 240] : [10, 10, 10]));
    const fp = fingerprintDecodedImage(left)!;
    expect(fingerprintDistance(fp, fingerprintDecodedImage(noisy)!)).toBeLessThan(5);
    expect(fingerprintDistance(fp, fingerprintDecodedImage(right)!)).toBeGreaterThan(100);
  });
});

describe('buildInventory — images-template-slot (different pictures in one slot of the layout)', () => {
  async function inventory() {
    const doc = await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buildTemplateSlot()) }).promise;
    return buildInventory(doc as unknown as PdfDocumentLike);
  }
  const isTopSlot = (e: { occurrences: { bbox: { minY: number } }[] }) => e.occurrences[0]!.bbox.minY > 400;

  it('fingerprints the images and links only the copies of the same picture', async () => {
    const inv = await inventory();
    const top = inv.images.filter(isTopSlot);
    const bottom = inv.images.filter((e) => !isTopSlot(e));
    expect(top).toHaveLength(PAGE_COUNT);
    expect(bottom).toHaveLength(PAGE_COUNT);
    expect(inv.images.every((e) => e.contentFingerprint !== undefined)).toBe(true);
    // The chapter pictures: same place, same resolution, different content — not one resource.
    expect(top.every((e) => e.correlatedWith === undefined)).toBe(true);
    // The ornament embedded again on every page: one resource, as before.
    expect(bottom.filter((e) => e.correlatedWith !== undefined)).toHaveLength(PAGE_COUNT - 1);
  });

  it('does not take the chapter pictures for a decoration repeated on many pages', async () => {
    const inv = await inventory();
    const pageBoxByPage = new Map(inv.perPage.map((p) => [p.pageNumber, p.box]));
    const classified = classifyImages(inv.images, pageBoxByPage);
    for (const c of classified.filter((c) => isTopSlot(c.entry))) {
      expect(c.reason).not.toMatch(/repeated|multi-page/);
    }
  });
});

describe('buildInventory — images that arrive decoded after the operator list (as in a browser)', () => {
  it('waits for them and fingerprints them all', async () => {
    const doc = await pdfjs.getDocument({ ...PDF_OPEN_OPTIONS, data: new Uint8Array(buildTemplateSlot()) }).promise;
    // A browser's pdf.js resolves `getOperatorList()` before the page's decoded images reach the main thread: `has` is false at first, and
    // `get(id, callback)` calls back once the image is there.
    const late = (store: { has(id: string): boolean; get(id: string): unknown }) => ({
      has: () => false,
      get: (id: string, callback?: (data: unknown) => void) => {
        if (!callback) throw new Error(`Requesting object that isn't resolved yet ${id}.`);
        setTimeout(() => callback(store.get(id)), 5);
        return undefined;
      },
    });
    const browserLike = {
      numPages: doc.numPages,
      getPage: async (n: number) => {
        const page = await doc.getPage(n);
        return new Proxy(page, { get: (target, key) => (key === 'objs' ? late(target.objs) : key === 'commonObjs' ? late(target.commonObjs) : typeof Reflect.get(target, key, target) === 'function' ? (Reflect.get(target, key, target) as (...args: unknown[]) => unknown).bind(target) : Reflect.get(target, key, target)) });
      },
    };
    const inv = await buildInventory(browserLike as unknown as PdfDocumentLike);
    expect(inv.images.length).toBeGreaterThan(0);
    expect(inv.images.every((e) => e.contentFingerprint !== undefined)).toBe(true);
  });
});
