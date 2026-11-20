import { computeVisibleLuminanceStdDev } from './finalize.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Whether a picture cut out by a mask is one solid figure (a creature, a person standing on the transparent ground) rather than a
 * spray of drops (a splatter of blood or ink) or a soft shadow. A figure standing in a tall box leaves most of the box
 * transparent, as a splatter does, so the share of its opaque pixels in the whole raster does not tell them apart. Measured on a
 * real rulebook of painted figures and on the splatters of three books, taken within the box of what shows:
 * - the 31 figures cover 31%-67% of it and their largest piece holds 91%-100% of what shows;
 * - the splatters cover 5%-23%, their largest piece holds 16%-81% (the rest is drops);
 * - a soft grey vignette is one piece over 26%, but even (a luminance spread of 15; the figures, 38-58).
 */

/** A pixel with alpha above this counts as shown (the same limit as the opaque share it corrects). */
const SHOWN_ALPHA = 16;
/** The share of the box of what shows that a figure covers at least. */
const MIN_COVER = 0.25;
/** The share of what shows that its largest piece (4-connected) holds at least. */
const MIN_LARGEST_PIECE = 0.9;
/** The luminance spread over what shows from which it is a picture, not a shadow. */
const MIN_STDDEV = 25;
/** The pieces are looked for on a grid of at most this many cells along the long edge. */
const GRID_LONG_EDGE = 300;

export function isSolidCutOut(image: DecodedImage): boolean {
  const { width, height, rgba } = image;
  if (width < 2 || height < 2) return false;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / GRID_LONG_EDGE));
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const shown = new Uint8Array(w * h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      if (rgba[((gy * step) * width + gx * step) * 4 + 3]! <= SHOWN_ALPHA) continue;
      shown[gy * w + gx] = 1;
      count++;
      if (gx < minX) minX = gx;
      if (gx > maxX) maxX = gx;
      if (gy < minY) minY = gy;
      if (gy > maxY) maxY = gy;
    }
  }
  if (count === 0) return false;
  if (count / ((maxX - minX + 1) * (maxY - minY + 1)) < MIN_COVER) return false;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let largest = 0;
  for (let start = 0; start < shown.length; start++) {
    if (shown[start] === 0 || seen[start] === 1) continue;
    let size = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of neighbours) {
        if (q < 0 || q >= shown.length || shown[q] === 0 || seen[q] === 1) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (size > largest) largest = size;
  }
  if (largest / count < MIN_LARGEST_PIECE) return false;
  return computeVisibleLuminanceStdDev(image) >= MIN_STDDEV;
}
