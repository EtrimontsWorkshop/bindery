import type { DecodedImage } from './normalizeDecodedImage.js';
import { measureRasterText } from './rasterText.js';

/**
 * A photograph laid on a page of documents inside ONE raster (a snapshot pinned to a report, a picture clipped to a
 * letter): the PDF has no picture of its own to take, so the photograph is found in the raster's pixels and cut out of
 * it, to be offered by itself while the documents go with the boxes of text.
 *
 * The raster is measured on a coarse grid and blurred, so that the thin strokes of letters melt into their paper: what
 * stays dark or coloured is a picture. The photograph is the largest such patch that is big, compact and not flat (a
 * black bar of a redaction is flat), and only when the rest of the raster, the patch painted white, is still a document:
 * many lines of letters of one size on light paper.
 */

/** Width (cells) of the grid the raster is measured on, and the radius (cells) of the blur that melts letters into paper. */
const GRID_WIDTH = 300;
const BLUR_RADIUS = 3;
/** A blurred cell darker than this, or more saturated than this, belongs to a picture. */
const PICTURE_MAX_LUMINANCE = 170;
const PICTURE_MIN_SATURATION = 0.3;
/**
 * The patch that is the photograph: at least this share of the raster, each side at least this share of the raster's
 * side, filling at least this share of its box, with this spread of luminance in it at least. Measured on the rasters of
 * one book that hold a photograph among documents (the patch at 0.15-0.33 of the raster, filling 0.72-0.84 of its box,
 * a spread of 41-52) and on 288 rasters of 23 books that have lines of letters.
 */
const PHOTO_MIN_SHARE = 0.04;
const PHOTO_MAX_SHARE = 0.7;
const PHOTO_MIN_SIDE_SHARE = 0.12;
const PHOTO_MIN_FILL = 0.5;
const PHOTO_MIN_SPREAD = 25;
/** What is left of the raster is a document: this many lines of letters at least, this light, letters this even (see `letterHeightVariation`), this little colour. */
const REST_MIN_LINES = 20;
const REST_MIN_LIGHT_SHARE = 0.85;
const REST_MAX_HEIGHT_VARIATION = 0.27;
const REST_MAX_COLOUR_SHARE = 0.1;

/** A box in the raster's pixels. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mean of each cell's square neighbourhood of radius `r` (integral image). */
function boxBlur(values: Float32Array, width: number, height: number, r: number): Float32Array {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x]!;
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height, y + r + 1);
      const sum = integral[y1 * (width + 1) + x1]! - integral[y0 * (width + 1) + x1]! - integral[y1 * (width + 1) + x0]! + integral[y0 * (width + 1) + x0]!;
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** The raster's luminance and saturation on the grid (cell means; transparent pixels as white paper). */
function onGrid(image: DecodedImage): { lum: Float32Array; sat: Float32Array; width: number; height: number } {
  const width = Math.min(GRID_WIDTH, image.width);
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const lum = new Float32Array(width * height);
  const sat = new Float32Array(width * height);
  const count = new Float32Array(width * height);
  for (let y = 0; y < image.height; y++) {
    const gy = Math.min(height - 1, Math.floor((y * height) / image.height));
    for (let x = 0; x < image.width; x++) {
      const gx = Math.min(width - 1, Math.floor((x * width) / image.width));
      const i = (y * image.width + x) * 4;
      const a = image.rgba[i + 3]! / 255;
      const r = image.rgba[i]! * a + 255 * (1 - a);
      const g = image.rgba[i + 1]! * a + 255 * (1 - a);
      const b = image.rgba[i + 2]! * a + 255 * (1 - a);
      const max = Math.max(r, g, b);
      const cell = gy * width + gx;
      lum[cell] = lum[cell]! + 0.299 * r + 0.587 * g + 0.114 * b;
      sat[cell] = sat[cell]! + (max > 0 ? (max - Math.min(r, g, b)) / max : 0);
      count[cell] = count[cell]! + 1;
    }
  }
  for (let i = 0; i < width * height; i++) {
    lum[i] = count[i]! > 0 ? lum[i]! / count[i]! : 255;
    sat[i] = count[i]! > 0 ? sat[i]! / count[i]! : 0;
  }
  return { lum, sat, width, height };
}

/** The box of the photograph laid on this raster of documents, in the raster's pixels; `null` when there is none or the raster is not a page of documents. */
export function findPhotoInDocument(image: DecodedImage): PixelBox | null {
  if (image.width < 16 || image.height < 16) return null;
  const { lum, sat, width: W, height: H } = onGrid(image);
  const blurredLum = boxBlur(lum, W, H, BLUR_RADIUS);
  const blurredSat = boxBlur(sat, W, H, BLUR_RADIUS);
  const picture = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (blurredLum[i]! < PICTURE_MAX_LUMINANCE || blurredSat[i]! > PICTURE_MIN_SATURATION) picture[i] = 1;

  // The largest patch of picture cells that is shaped like a photograph.
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  let best: { minX: number; minY: number; maxX: number; maxY: number; area: number } | null = null;
  for (let start = 0; start < W * H; start++) {
    if (!picture[start] || seen[start]) continue;
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    let area = 0;
    let inked = 0;
    let sum = 0;
    let sumSq = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      // The spread is that of the cells that are dark or coloured themselves: the blur's halo of paper around a flat bar would lend it one.
      if (lum[p]! < PICTURE_MAX_LUMINANCE || sat[p]! > PICTURE_MIN_SATURATION) {
        inked++;
        sum += lum[p]!;
        sumSq += lum[p]! * lum[p]!;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && picture[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && picture[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && picture[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && picture[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const share = area / (W * H);
    const mean = inked > 0 ? sum / inked : 0;
    const spread = inked > 0 ? Math.sqrt(Math.max(0, sumSq / inked - mean * mean)) : 0;
    if (share < PHOTO_MIN_SHARE || share > PHOTO_MAX_SHARE || w < PHOTO_MIN_SIDE_SHARE * W || h < PHOTO_MIN_SIDE_SHARE * H || area < PHOTO_MIN_FILL * w * h || spread < PHOTO_MIN_SPREAD) continue;
    if (best === null || area > best.area) best = { minX, minY, maxX, maxY, area };
  }
  if (best === null) return null;

  const box: PixelBox = {
    x: Math.floor((best.minX * image.width) / W),
    y: Math.floor((best.minY * image.height) / H),
    width: 0,
    height: 0,
  };
  box.width = Math.min(image.width, Math.ceil(((best.maxX + 1) * image.width) / W)) - box.x;
  box.height = Math.min(image.height, Math.ceil(((best.maxY + 1) * image.height) / H)) - box.y;

  // What is left, the photograph painted white, must be a page of documents.
  const rest = { width: image.width, height: image.height, rgba: new Uint8ClampedArray(image.rgba) };
  for (let y = box.y; y < box.y + box.height; y++) rest.rgba.fill(255, (y * image.width + box.x) * 4, (y * image.width + box.x + box.width) * 4);
  const m = measureRasterText(rest);
  const isDocument = m.lines >= REST_MIN_LINES && m.lightShare >= REST_MIN_LIGHT_SHARE && m.letterHeightVariation <= REST_MAX_HEIGHT_VARIATION && m.colourShare <= REST_MAX_COLOUR_SHARE;
  return isDocument ? box : null;
}
