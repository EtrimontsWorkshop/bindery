/**
 * A tiny picture of an image's content: its luminance on a `FINGERPRINT_GRID` × `FINGERPRINT_GRID` grid, each cell
 * the mean of a few pixels, composited over white. Enough to tell two different illustrations apart, and to
 * recognise the same picture embedded twice (also when it was re-compressed on the way, which changes single pixels
 * but not the cell means).
 *
 * Why: `correlateImagesByBBox` links images that sit in the same place with the same resolution on different pages,
 * taking them for one resource embedded again on every page (a header, a frame). A layout template can put a
 * DIFFERENT picture in the same slot on every chapter's first page; linked, five chapter illustrations counted as one
 * picture repeated on five pages, and were hidden as a running ornament. The fingerprint lets the correlation check
 * the content too.
 *
 * Computed during the inventory from what pdf.js has already decoded for the operator list — `page.objs` holds the
 * image until `page.cleanup()` — so it costs a few hundred pixel reads per image (the `{ kind, data }` shape, Node
 * and small images) or one draw onto an 8×8 canvas (the `{ bitmap }` shape of the browser). Returns `null` when the
 * image cannot be read; the correlation then falls back to position and resolution alone.
 */

export const FINGERPRINT_GRID = 8;
/** Pixels sampled per cell side when reading raw data (so up to 16 per cell). */
const SAMPLES_PER_CELL_SIDE = 4;

const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

/** `FINGERPRINT_GRID²` luminance values, 0-255, row by row. */
export type ContentFingerprint = readonly number[];

function luminance(r: number, g: number, b: number, a: number): number {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  // Over white: a transparent area reads as paper, whatever colour its invisible pixels carry.
  return (lum * a + 255 * (255 - a)) / 255;
}

function fingerprintFromData(width: number, height: number, kind: number, data: ArrayLike<number>): ContentFingerprint | null {
  if (width <= 0 || height <= 0) return null;
  const pixelAt = (x: number, y: number): number => {
    if (kind === IMAGE_KIND_RGBA_32BPP) {
      const i = (y * width + x) * 4;
      return luminance(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!);
    }
    if (kind === IMAGE_KIND_RGB_24BPP) {
      const i = (y * width + x) * 3;
      return luminance(data[i]!, data[i + 1]!, data[i + 2]!, 255);
    }
    const byte = data[y * Math.ceil(width / 8) + (x >> 3)]!;
    return (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
  };
  if (kind !== IMAGE_KIND_RGBA_32BPP && kind !== IMAGE_KIND_RGB_24BPP && kind !== IMAGE_KIND_GRAYSCALE_1BPP) return null;

  const cells: number[] = [];
  for (let cy = 0; cy < FINGERPRINT_GRID; cy++) {
    for (let cx = 0; cx < FINGERPRINT_GRID; cx++) {
      let sum = 0;
      let count = 0;
      for (let sy = 0; sy < SAMPLES_PER_CELL_SIDE; sy++) {
        const y = Math.min(height - 1, Math.floor(((cy + (sy + 0.5) / SAMPLES_PER_CELL_SIDE) * height) / FINGERPRINT_GRID));
        for (let sx = 0; sx < SAMPLES_PER_CELL_SIDE; sx++) {
          const x = Math.min(width - 1, Math.floor(((cx + (sx + 0.5) / SAMPLES_PER_CELL_SIDE) * width) / FINGERPRINT_GRID));
          sum += pixelAt(x, y);
          count++;
        }
      }
      cells.push(Math.round(sum / count));
    }
  }
  return cells;
}

/**
 * The browser draws an image onto a canvas this many times larger than the grid, smoothed at high quality, and each
 * cell is the mean of its block: drawn straight onto an 8×8 canvas, a large image is read from a few of its pixels
 * only, and a sharp edge (a lettering, the rim of a can) made the cells of two tiles of one picture differ by 30-50
 * across their seam where the pixel reads of Node found 7-20.
 */
const BITMAP_SCALE = 4;

interface CanvasLike {
  getContext(id: '2d'): {
    fillStyle: string;
    imageSmoothingEnabled?: boolean;
    imageSmoothingQuality?: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
    getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
  } | null;
}

function fingerprintFromBitmap(bitmap: unknown): ContentFingerprint | null {
  const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as (new (w: number, h: number) => CanvasLike) | undefined;
  if (!OffscreenCanvasCtor) return null;
  const size = FINGERPRINT_GRID * BITMAP_SCALE;
  const ctx = new OffscreenCanvasCtor(size, size).getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const cells: number[] = [];
  for (let cy = 0; cy < FINGERPRINT_GRID; cy++) {
    for (let cx = 0; cx < FINGERPRINT_GRID; cx++) {
      let sum = 0;
      for (let y = 0; y < BITMAP_SCALE; y++) {
        for (let x = 0; x < BITMAP_SCALE; x++) {
          const i = ((cy * BITMAP_SCALE + y) * size + cx * BITMAP_SCALE + x) * 4;
          sum += luminance(data[i]!, data[i + 1]!, data[i + 2]!, 255);
        }
      }
      cells.push(Math.round(sum / (BITMAP_SCALE * BITMAP_SCALE)));
    }
  }
  return cells;
}

/** The fingerprint of an image as pdf.js holds it in `page.objs`/`page.commonObjs`; `null` when it cannot be read. */
export function fingerprintDecodedImage(raw: unknown): ContentFingerprint | null {
  if (raw === null || typeof raw !== 'object') return null;
  const img = raw as Record<string, unknown>;
  const width = img['width'];
  const height = img['height'];
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  try {
    if (typeof img['kind'] === 'number' && img['data'] != null) return fingerprintFromData(width, height, img['kind'], img['data'] as ArrayLike<number>);
    // An image mask (`paintImageMaskXObject`) comes as bare 1-bit rows without a `kind`.
    const data = img['data'] as ArrayLike<number> | null | undefined;
    if (data != null && data.length === Math.ceil(width / 8) * height) return fingerprintFromData(width, height, IMAGE_KIND_GRAYSCALE_1BPP, data);
    if (img['bitmap'] != null) return fingerprintFromBitmap(img['bitmap']);
  } catch {
    // A closed bitmap or an unexpected shape: no fingerprint, the correlation falls back to position.
  }
  return null;
}

/** Mean absolute difference of two fingerprints, 0 (identical) to 255. */
export function fingerprintDistance(a: ContentFingerprint, b: ContentFingerprint): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}
