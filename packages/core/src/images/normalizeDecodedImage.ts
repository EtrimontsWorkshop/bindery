/**
 * Closes the gap described in RAPORT-FAZA-1.md: `page.objs.get()` returns
 * DIFFERENT shapes depending on the environment — `{ bitmap: ImageBitmap }`
 * in the browser (Foundry), `{ kind, data: Uint8ClampedArray }` in Node
 * (phase-0 spike). Without this normalization, golden tests would pass in
 * Node while production ran in the browser — meaning they wouldn't actually
 * be testing what really executes.
 */

/** Canonical representation of a decoded image, independent of the environment. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Uint8ClampedArray;
}

// Constants verified empirically in phase 0 (Step 1 spike, pdfjs-dist 6.1.200).
const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

interface KindDataShape {
  [key: string]: unknown;
  width: number;
  height: number;
  kind: number;
  data: Uint8ClampedArray | Uint8Array;
}

interface BitmapShape {
  [key: string]: unknown;
  width: number;
  height: number;
  bitmap: unknown;
}

function isKindDataShape(img: Record<string, unknown>): img is KindDataShape {
  return typeof img['kind'] === 'number' && img['data'] != null;
}

function isBitmapShape(img: Record<string, unknown>): img is BitmapShape {
  return img['bitmap'] != null;
}

function normalizeFromKindData(img: KindDataShape): DecodedImage {
  const { width, height, kind, data } = img;

  if (kind === IMAGE_KIND_RGBA_32BPP) {
    return { width, height, rgba: Uint8ClampedArray.from(data) };
  }

  if (kind === IMAGE_KIND_RGB_24BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let px = 0; px < width * height; px++) {
      rgba[px * 4] = data[px * 3]!;
      rgba[px * 4 + 1] = data[px * 3 + 1]!;
      rgba[px * 4 + 2] = data[px * 3 + 2]!;
      rgba[px * 4 + 3] = 255;
    }
    return { width, height, rgba };
  }

  if (kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const bytesPerRow = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * bytesPerRow + (x >> 3)]!;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const px = (y * width + x) * 4;
        rgba[px] = v;
        rgba[px + 1] = v;
        rgba[px + 2] = v;
        rgba[px + 3] = 255;
      }
    }
    return { width, height, rgba };
  }

  throw new Error(`normalizeDecodedImage: unsupported kind=${kind}`);
}

function normalizeFromBitmap(img: BitmapShape): DecodedImage {
  // OffscreenCanvas is a web-platform standard (not a Foundry API) — using it
  // here doesn't break assumption A1. But it's only available in the
  // browser; in Node (unit tests) it throws a readable error instead of
  // silently hanging — actual canvas drawing stays phase 3 scope (see
  // KROK-3-fixtures.md, Z6).
  const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
    | (new (w: number, h: number) => {
        getContext(id: '2d'): {
          drawImage(bitmap: unknown, dx: number, dy: number): void;
          getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
        } | null;
      })
    | undefined;

  if (!OffscreenCanvasCtor) {
    throw new Error(
      'normalizeDecodedImage: OffscreenCanvas is not available in this environment (probably Node) — ' +
        'drawing an ImageBitmap onto a canvas is phase-3 scope, not phase 1.',
    );
  }

  const canvas = new OffscreenCanvasCtor(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('normalizeDecodedImage: failed to create a 2D context for OffscreenCanvas');
  }
  ctx.drawImage(img.bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, rgba: imageData.data };
}

/**
 * Normalizes the result of `page.objs.get()`/`page.commonObjs.get()`
 * (either of the two shapes observed empirically — see the comment at the
 * top of the file) into a single canonical RGBA representation.
 */
export function normalizeDecodedImage(raw: unknown): DecodedImage {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('normalizeDecodedImage: expected an object, got ' + typeof raw);
  }
  const img = raw as Record<string, unknown>;
  if (typeof img['width'] !== 'number' || typeof img['height'] !== 'number') {
    throw new Error('normalizeDecodedImage: input is missing numeric width/height');
  }

  if (isKindDataShape(img)) {
    return normalizeFromKindData(img);
  }
  if (isBitmapShape(img)) {
    return normalizeFromBitmap(img);
  }

  throw new Error('normalizeDecodedImage: unrecognized input shape (no "data" and no "bitmap")');
}
