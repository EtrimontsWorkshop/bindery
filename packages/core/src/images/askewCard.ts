import type { Matrix, Rect } from '../geometry.js';
import type { ClipInfo } from '../inventory/clipPaths.js';
import type { RotatedPdfRegion } from './renderRotatedRegion.js';

/**
 * A card that the page lays a few degrees askew (a sheet of paper turned on the page, a shadow under it) is shown, when it is rendered with
 * what the page draws on it, as its own turned rectangle straightened: the upright box around it takes in wedges of the page at its corners
 * (the edge of a chapter's tab, a line of the column beside it) and shows the card askew. A turn below this many degrees is upright already;
 * one above this is no card lying askew but a picture set on its corner (a quarter turn is a picture stored sideways, see `quarterTurns`).
 */
export const ASKEW_CARD_MIN_TILT_DEG = 0.3;
export const ASKEW_CARD_MAX_TILT_DEG = 20;
/** The sides of the painted raster are at a right angle to one another within this many degrees (a raster sheared is no card). */
const RIGHT_ANGLE_TOLERANCE_DEG = 1;
/** The rectangle rendered is the raster's own, this share of each side taken off at each edge (its outermost pixels, the paper's torn edge, show the page beside them). */
export const ASKEW_CARD_INSET = 0.02;

/**
 * The turned rectangle a raster is painted in, from the matrix it is painted with (the unit square to the page), when it is turned by a few
 * degrees: its centre, its sides along and across its turn, and the turn that brings it upright (mirrored rasters are turned the same way,
 * the render shows them as the page does). `null` for an upright raster, one turned by much, or a sheared one.
 */
export function askewRectangleOf(ctm: Matrix): RotatedPdfRegion | null {
  const [a, b, c, d, e, f] = ctm;
  const sideX = Math.hypot(a, b);
  const sideY = Math.hypot(c, d);
  if (sideX <= 0 || sideY <= 0) return null;
  const across = Math.abs((a * c + b * d) / (sideX * sideY));
  if (across > Math.sin((RIGHT_ANGLE_TOLERANCE_DEG * Math.PI) / 180)) return null;
  const angle = Math.atan2(b, a);
  // The turn nearest to upright: a raster mirrored or stored sideways is turned by a half or a quarter turn on top of its tilt.
  const quarter = Math.round(angle / (Math.PI / 2));
  const tilt = angle - quarter * (Math.PI / 2);
  const tiltDeg = Math.abs((tilt * 180) / Math.PI);
  if (tiltDeg < ASKEW_CARD_MIN_TILT_DEG || tiltDeg > ASKEW_CARD_MAX_TILT_DEG) return null;
  const sideways = Math.abs(quarter) % 2 === 1;
  const width = (sideways ? sideY : sideX) * (1 - 2 * ASKEW_CARD_INSET);
  const height = (sideways ? sideX : sideY) * (1 - 2 * ASKEW_CARD_INSET);
  return { centerX: e + (a + c) / 2, centerY: f + (b + d) / 2, width, height, rotationRad: tilt };
}

/** The sides of a clip's four corners are of one length with the opposite side within this share (a tilted rectangle, not any four-cornered shape). */
const OPPOSITE_SIDES_MAX_DIFFERENCE = 0.03;

/** The four corners of a clip polygon (`[x0, y0, x1, y1, ...]`, the first corner repeated at the end or not) when it is a rectangle, upright or turned; `null` otherwise. */
function rectangleCorners(polygon: readonly number[]): { x: number; y: number }[] | null {
  let n = polygon.length / 2;
  if (n === 5 && polygon[0] === polygon[8] && polygon[1] === polygon[9]) n = 4;
  if (n !== 4) return null;
  const p = [0, 1, 2, 3].map((i) => ({ x: polygon[2 * i]!, y: polygon[2 * i + 1]! }));
  const side = (i: number): { x: number; y: number } => ({ x: p[(i + 1) % 4]!.x - p[i]!.x, y: p[(i + 1) % 4]!.y - p[i]!.y });
  const len = (v: { x: number; y: number }): number => Math.hypot(v.x, v.y);
  const [s0, s1, s2, s3] = [side(0), side(1), side(2), side(3)];
  if (len(s0) <= 0 || len(s1) <= 0) return null;
  if (Math.abs(len(s0) - len(s2)) > OPPOSITE_SIDES_MAX_DIFFERENCE * len(s0) || Math.abs(len(s1) - len(s3)) > OPPOSITE_SIDES_MAX_DIFFERENCE * len(s1)) return null;
  if (Math.abs((s0.x * s1.x + s0.y * s1.y) / (len(s0) * len(s1))) > Math.sin((RIGHT_ANGLE_TOLERANCE_DEG * Math.PI) / 180)) return null;
  return p;
}

/**
 * The turned rectangle of a clip of four corners (`[x0, y0, x1, y1, ...]`, the first corner repeated at the end or not), when it is a
 * rectangle turned by a few degrees: what the page shows of a card it cuts to its sheet (see `askewRectangleOf`). `null` otherwise.
 */
export function askewRectangleOfPolygon(polygon: readonly number[]): RotatedPdfRegion | null {
  const p = rectangleCorners(polygon);
  if (p === null) return null;
  // A rectangle with its corners in order: two sides from one corner, at a right angle; as a matrix from that corner, its turn is the matrix's.
  return askewRectangleOf([p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y, p[3]!.x - p[0]!.x, p[3]!.y - p[0]!.y, p[0]!.x, p[0]!.y]);
}

/** A clip polygon fills this share of the rectangle around it, turned along its longest side, at least to be all but that rectangle. */
const NEARLY_RECTANGLE_MIN_FILL = 0.95;

/**
 * The turned rectangle around a clip polygon of five corners that is all but a rectangle (a print with a corner cut off): turned
 * along its longest side, filled by the polygon for the most part. `null` for another shape.
 */
export function nearlyRectangleOf(polygon: readonly number[]): { rect: RotatedPdfRegion; tiltDeg: number } | null {
  let n = polygon.length / 2;
  if (n >= 2 && polygon[0] === polygon[2 * n - 2] && polygon[1] === polygon[2 * n - 1]) n--;
  // A rectangle with one corner cut off: five corners.
  if (n !== 5) return null;
  const p = Array.from({ length: n }, (_, i) => ({ x: polygon[2 * i]!, y: polygon[2 * i + 1]! }));
  let longest = 0;
  let angle = 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % n]!;
    area += a.x * b.y - b.x * a.y;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) {
      longest = length;
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  area = Math.abs(area) / 2;
  // The turn nearest to upright that lays the longest side along an axis.
  const tilt = angle - Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  const cos = Math.cos(-tilt);
  const sin = Math.sin(-tilt);
  const turned = p.map((q) => ({ x: q.x * cos - q.y * sin, y: q.x * sin + q.y * cos }));
  const minX = Math.min(...turned.map((q) => q.x));
  const maxX = Math.max(...turned.map((q) => q.x));
  const minY = Math.min(...turned.map((q) => q.y));
  const maxY = Math.max(...turned.map((q) => q.y));
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0 || area < NEARLY_RECTANGLE_MIN_FILL * width * height) return null;
  // The centre turned back into the page.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const centerX = cx * Math.cos(tilt) - cy * Math.sin(tilt);
  const centerY = cx * Math.sin(tilt) + cy * Math.cos(tilt);
  const rect = { centerX, centerY, width: width * (1 - 2 * ASKEW_CARD_INSET), height: height * (1 - 2 * ASKEW_CARD_INSET), rotationRad: tilt };
  return { rect, tiltDeg: Math.abs((tilt * 180) / Math.PI) };
}

/**
 * The turned rectangle a painting of a raster shows when it is a card laid askew: what its clip of four corners lets through, or its raster's
 * own rectangle. A rectangular clip is what the page shows (it cuts into the raster: a clip that lets all of it through is not kept), so a
 * raster turned a few degrees behind an upright rectangular window (an illustration set in a straight frame) shows upright: it is no card askew.
 */
export function askewRectangleOfPainting(o: { clip?: Pick<ClipInfo, 'paths' | 'ctm'>; ctm?: Matrix }): RotatedPdfRegion | null {
  const polygon = o.clip?.paths.length === 1 && o.clip.paths[0]!.length === 1 ? o.clip.paths[0]![0]! : undefined;
  if (polygon !== undefined && rectangleCorners(polygon) !== null) return askewRectangleOfPolygon(polygon);
  // A clip that is all but a rectangle (a print with a corner cut off) is what the page shows of the card too: its turn, not the raster's.
  const nearly = polygon !== undefined ? nearlyRectangleOf(polygon) : null;
  if (nearly !== undefined && nearly !== null) return nearly.tiltDeg < ASKEW_CARD_MIN_TILT_DEG || nearly.tiltDeg > ASKEW_CARD_MAX_TILT_DEG ? null : nearly.rect;
  const ctm = o.ctm ?? o.clip?.ctm;
  return ctm !== undefined ? askewRectangleOf(ctm) : null;
}

/** The upright box around a turned rectangle. */
export function envelopeOf(rect: RotatedPdfRegion): Rect {
  const cos = Math.abs(Math.cos(rect.rotationRad));
  const sin = Math.abs(Math.sin(rect.rotationRad));
  const halfW = (rect.width * cos + rect.height * sin) / 2;
  const halfH = (rect.width * sin + rect.height * cos) / 2;
  return { minX: rect.centerX - halfW, minY: rect.centerY - halfH, maxX: rect.centerX + halfW, maxY: rect.centerY + halfH };
}
