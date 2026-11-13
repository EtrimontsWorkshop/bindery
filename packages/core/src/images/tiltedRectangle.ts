import type { DecodedImage } from './normalizeDecodedImage.js';
import { rotateAndCropImage } from './rotateCrop.js';

/**
 * A photograph or a painting that the page lays askew (a print tilted on a desk) comes out of its raster as an upright
 * box holding a tilted rectangle, its corners transparent (its mask or clip cuts it out); the raster's own edges may cut
 * the tilted print too. It is offered straightened: the edges of its outline that are not the raster's own edges give
 * its angle, the picture is turned by that angle, and it is cut to the largest upright rectangle of visible pixels.
 */

/** Longest side (cells) of the grid the outline is looked for on. */
const GRID_MAX_SIDE = 400;
/** A pixel at least this opaque is part of the picture. */
const OPAQUE_MIN_ALPHA = 128;
/** A tilt below this (degrees) is upright already; above this it is no print lying askew but a picture set on its corner. */
const MIN_TILT_DEG = 1.5;
const MAX_TILT_DEG = 35;
/**
 * A print whose corner shows (two of its sides, one across the other) is tilted at any angle from `MIN_TILT_DEG`. One
 * whose single side shows (the raster cuts the rest) may as well be an upright picture with one edge cut on a slant by
 * the page's design: it is taken for a tilted print from this angle. Measured on two books: prints showing one side at
 * 8.5 degrees, a chapter picture cut on a slant at 2.2.
 */
const SINGLE_SIDE_MIN_TILT_DEG = 5;
/** The visible pixels fill at most this share of the raster: an upright, opaque raster has nothing to straighten. */
const MAX_RASTER_FILL = 0.97;
/** An edge of the outline within this many cells of the raster's edge is the raster's edge, not the print's. */
const BORDER_CELLS = 1.5;
/** The print's own edges are this share of the outline's length at least: a few transparent specks at a corner are no tilt. */
const MIN_OWN_EDGE_SHARE = 0.25;
/** The print's own edges run along the tilt (or across it) within this many degrees: a cut-out of any other shape has edges every way. */
const EDGE_AGREEMENT_DEG = 3;
/** The straightened picture keeps at least this share of the visible pixels: a cut-out shape would lose more to the rectangle (a disc 0.64). A print cut by the raster on two sides, measured on one book, keeps 0.74. */
const MIN_KEPT_SHARE = 0.7;

interface Point {
  x: number;
  y: number;
}

/** Convex hull (Andrew's monotone chain), counterclockwise. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** An angle in degrees folded to (-45, 45]: the direction of a side, whichever of the rectangle's sides it is. */
function foldToQuarter(deg: number): number {
  let a = deg % 90;
  if (a > 45) a -= 90;
  if (a <= -45) a += 90;
  return a;
}

/** The visible-pixel mask of an image on a grid of at most `GRID_MAX_SIDE` cells. */
function opaqueGrid(image: DecodedImage): { mask: Uint8Array; width: number; height: number; scale: number } {
  const scale = Math.min(1, GRID_MAX_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const mask = new Uint8Array(width * height);
  for (let gy = 0; gy < height; gy++) {
    const y = Math.min(image.height - 1, Math.floor((gy + 0.5) / scale));
    for (let gx = 0; gx < width; gx++) {
      const x = Math.min(image.width - 1, Math.floor((gx + 0.5) / scale));
      if (image.rgba[(y * image.width + x) * 4 + 3]! >= OPAQUE_MIN_ALPHA) mask[gy * width + gx] = 1;
    }
  }
  return { mask, width, height, scale };
}

/** The tilt (degrees, image space, y down) of the print the raster holds, read from the edges of its outline that are not the raster's edges; `null` when there is none. */
export function findTilt(image: DecodedImage): number | null {
  if (image.width < 8 || image.height < 8) return null;
  const { mask, width: gw, height: gh } = opaqueGrid(image);
  let visible = 0;
  const ends: Point[] = [];
  for (let gy = 0; gy < gh; gy++) {
    let first = -1;
    let last = -1;
    for (let gx = 0; gx < gw; gx++) {
      if (!mask[gy * gw + gx]) continue;
      visible++;
      if (first < 0) first = gx;
      last = gx;
    }
    if (first >= 0) ends.push({ x: first, y: gy }, { x: last + 1, y: gy }, { x: first, y: gy + 1 }, { x: last + 1, y: gy + 1 });
  }
  if (visible === 0 || visible > MAX_RASTER_FILL * gw * gh) return null;
  const hull = convexHull(ends);
  if (hull.length < 3) return null;

  const onBorder = (a: Point, b: Point): boolean =>
    (a.x <= BORDER_CELLS && b.x <= BORDER_CELLS) || (a.x >= gw - BORDER_CELLS && b.x >= gw - BORDER_CELLS) || (a.y <= BORDER_CELLS && b.y <= BORDER_CELLS) || (a.y >= gh - BORDER_CELLS && b.y >= gh - BORDER_CELLS);
  let perimeter = 0;
  const own: { length: number; angle: number; direction: number }[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    perimeter += length;
    const direction = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (!onBorder(a, b)) own.push({ length, angle: foldToQuarter(direction), direction });
  }
  const ownLength = own.reduce((sum, e) => sum + e.length, 0);
  if (perimeter <= 0 || ownLength < MIN_OWN_EDGE_SHARE * perimeter) return null;
  // The tilt is the direction most of the print's own edges share (weighted by length); edges off it are curves or another shape.
  const longest = own.reduce((best, e) => (e.length > best.length ? e : best));
  const along = own.filter((e) => Math.abs(foldToQuarter(e.angle - longest.angle)) <= EDGE_AGREEMENT_DEG);
  const alongLength = along.reduce((sum, e) => sum + e.length, 0);
  if (alongLength < 0.8 * ownLength) return null;
  const tilt = longest.angle + along.reduce((sum, e) => sum + foldToQuarter(e.angle - longest.angle) * e.length, 0) / alongLength;
  // A corner: two of the print's own sides run across each other.
  const across = (a: number, b: number): boolean => Math.abs(Math.abs((((a - b) % 180) + 180) % 180) - 90) <= EDGE_AGREEMENT_DEG;
  const hasCorner = along.some((e) => along.some((f) => across(e.direction, f.direction)));
  const minTilt = hasCorner ? MIN_TILT_DEG : SINGLE_SIDE_MIN_TILT_DEG;
  return Math.abs(tilt) >= minTilt && Math.abs(tilt) <= MAX_TILT_DEG ? tilt : null;
}

/** The largest upright rectangle of visible pixels (histogram method over the grid), in grid cells. */
function largestOpaqueRectangle(mask: Uint8Array, width: number, height: number): { x: number; y: number; width: number; height: number; area: number } {
  const heights = new Int32Array(width);
  let best = { x: 0, y: 0, width: 0, height: 0, area: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[x] = mask[y * width + x] ? heights[x]! + 1 : 0;
    const stack: number[] = [];
    for (let x = 0; x <= width; x++) {
      const h = x < width ? heights[x]! : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! >= h) {
        const top = stack.pop()!;
        const rectHeight = heights[top]!;
        const left = stack.length > 0 ? stack[stack.length - 1]! + 1 : 0;
        const area = rectHeight * (x - left);
        if (area > best.area) best = { x: left, y: y - rectHeight + 1, width: x - left, height: rectHeight, area };
      }
      stack.push(x);
    }
  }
  return best;
}

/** The picture straightened and cut to its largest upright rectangle (see the top of the file); `null` when it is not a print lying askew. */
export function straightenTiltedPicture(image: DecodedImage): DecodedImage | null {
  const tilt = findTilt(image);
  if (tilt === null) return null;
  const rad = (tilt * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // The whole raster turned, on a canvas that holds all of it.
  const turned = rotateAndCropImage(image, {
    centerX: image.width / 2,
    centerY: image.height / 2,
    outputWidth: Math.round(image.width * cos + image.height * sin),
    outputHeight: Math.round(image.width * sin + image.height * cos),
    rotationRad: rad,
  });
  const { mask, width: gw, height: gh, scale } = opaqueGrid(turned);
  const rect = largestOpaqueRectangle(mask, gw, gh);
  let visible = 0;
  for (let i = 0; i < mask.length; i++) visible += mask[i]!;
  if (rect.area === 0 || rect.area < MIN_KEPT_SHARE * visible) return null;
  // One cell in from each side: the grid's cells at the rectangle's edge may hold a sliver of the transparent corner.
  const x0 = Math.min(turned.width - 1, Math.ceil((rect.x + 1) / scale));
  const y0 = Math.min(turned.height - 1, Math.ceil((rect.y + 1) / scale));
  const x1 = Math.max(x0 + 1, Math.floor((rect.x + rect.width - 1) / scale));
  const y1 = Math.max(y0 + 1, Math.floor((rect.y + rect.height - 1) / scale));
  const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(turned.rgba.subarray((y * turned.width + x0) * 4, (y * turned.width + x1) * 4), (y - y0) * (x1 - x0) * 4);
  return { width: x1 - x0, height: y1 - y0, rgba: out };
}
