import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Shape of a mask raster. A photo pinned to the page as a tilted print is cut out by a mask that is a
 * rotated rectangle (white) inside a black field; the more the print is tilted, the smaller the share of
 * the raster that is white (a 10-degree tilt of a square print leaves about 0.75 of it), so the share alone
 * cannot tell such a mask from one that deliberately hides a part of the picture (an oval portrait is 0.785
 * white at most, a torn edge or a silhouette a lot less). What tells them apart is the shape: the white area
 * of a rotated rectangle fills almost all of its smallest enclosing rectangle, an oval fills 0.785 of it.
 */

/** A pixel whose mean channel value is at or above this is "white" (lets the masked picture through). */
const WHITE_THRESHOLD = 128;
/** The white points taken into account — enough for the edge of a rectangle to be measured to a fraction of a percent. */
const MAX_SAMPLE_POINTS = 60_000;
/** Step of the angles tried for the smallest enclosing rectangle, in degrees. A rectangle is symmetric every 90 degrees. */
const ANGLE_STEP_DEGREES = 1;

/**
 * How completely the white area of a mask fills its smallest enclosing rectangle (rotated to any angle), from
 * 0 to 1: about 1 for a rectangle at any tilt (a little less where the edge is blurred), 0.785 for an
 * ellipse, lower for anything with a torn or indented outline. 0 when there is no white area.
 */
export function maskRectangularity(image: DecodedImage): number {
  const stride = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / MAX_SAMPLE_POINTS)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const i = (y * image.width + x) * 4;
      if ((image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!) / 3 >= WHITE_THRESHOLD) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length === 0) return 0;
  let smallest = Infinity;
  for (let deg = 0; deg < 90; deg += ANGLE_STEP_DEGREES) {
    const rad = (deg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < xs.length; k++) {
      const u = xs[k]! * c + ys[k]! * s;
      const v = -xs[k]! * s + ys[k]! * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    // A sampled point stands for a stride x stride cell, hence the added stride on each side.
    const area = (maxU - minU + stride) * (maxV - minV + stride);
    if (area < smallest) smallest = area;
  }
  return Math.min(1, (xs.length * stride * stride) / smallest);
}
