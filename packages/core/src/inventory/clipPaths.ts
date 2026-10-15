import type { Matrix, Rect } from '../geometry.js';

/**
 * Clipping paths of a page, as the operator walk sees them: a path that a `clip` operator turned into the visible
 * region for everything painted after it (until the enclosing save/restore). A picture painted under a clip is
 * shown only where the clip lets it through — a sprite sheet cut down to one figure, a photo cut to a silhouette —
 * and its raw resource knows nothing about it.
 *
 * Pure geometry, no pdf.js: paths come as the flat `DrawOPS` stream pdf.js stores inside `constructPath`.
 */

/** A clipping path: its subpaths as flat `[x0, y0, x1, y1, ...]` polygons in page space. */
export type ClipPath = readonly (readonly number[])[];

/** What the walk records for a picture that a clip cuts: the restricting clip paths and the image's CTM (unit square -> page). */
export interface ClipInfo {
  paths: readonly ClipPath[];
  ctm: Matrix;
  /** The share (0-1) of the picture that all the clips let through. */
  coverage: number;
}

const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

const CURVE_SEGMENTS = 8;

/** Pictures that a clip lets through at least this much of are treated as unclipped. */
export const CLIP_IGNORE_COVERAGE = 0.97;

const SAMPLE_GRID = 24;

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * The subpaths of a `DrawOPS` stream as page-space polygons. Curves are flattened into straight segments; a path
 * with an operator outside the known set yields what was parsed before it.
 */
export function flattenPath(flat: readonly number[], ctm: Matrix): ClipPath {
  const polygons: number[][] = [];
  let current: number[] = [];
  let cx = 0;
  let cy = 0;
  const push = (x: number, y: number): void => {
    const [px, py] = apply(ctm, x, y);
    current.push(px, py);
    cx = x;
    cy = y;
  };
  const finish = (): void => {
    if (current.length >= 6) polygons.push(current);
    current = [];
  };
  let i = 0;
  while (i < flat.length) {
    const op = flat[i++]!;
    if (op === DRAW_MOVE_TO) {
      finish();
      push(flat[i]!, flat[i + 1]!);
      i += 2;
    } else if (op === DRAW_LINE_TO) {
      push(flat[i]!, flat[i + 1]!);
      i += 2;
    } else if (op === DRAW_CURVE_TO) {
      const [x1, y1, x2, y2, x3, y3] = [flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!, flat[i + 4]!, flat[i + 5]!];
      const x0 = cx;
      const y0 = cy;
      for (let k = 1; k <= CURVE_SEGMENTS; k++) {
        const t = k / CURVE_SEGMENTS;
        const u = 1 - t;
        push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      i += 6;
    } else if (op === DRAW_QUADRATIC_CURVE_TO) {
      const [x1, y1, x2, y2] = [flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!];
      const x0 = cx;
      const y0 = cy;
      for (let k = 1; k <= CURVE_SEGMENTS; k++) {
        const t = k / CURVE_SEGMENTS;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
      }
      i += 4;
    } else if (op === DRAW_CLOSE_PATH) {
      finish();
    } else {
      break;
    }
  }
  finish();
  return polygons;
}

export function clipPathBBox(path: ClipPath): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of path) {
    for (let i = 0; i < polygon.length; i += 2) {
      minX = Math.min(minX, polygon[i]!);
      maxX = Math.max(maxX, polygon[i]!);
      minY = Math.min(minY, polygon[i + 1]!);
      maxY = Math.max(maxY, polygon[i + 1]!);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Even-odd point-in-polygon test over all subpaths of a clip path. */
export function pointInClipPath(path: ClipPath, x: number, y: number): boolean {
  let inside = false;
  for (const polygon of path) {
    const n = polygon.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[2 * i]!;
      const yi = polygon[2 * i + 1]!;
      const xj = polygon[2 * j]!;
      const yj = polygon[2 * j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return outer.minX <= inner.minX + 0.5 && outer.minY <= inner.minY + 0.5 && outer.maxX >= inner.maxX - 0.5 && outer.maxY >= inner.maxY - 0.5;
}

/**
 * The clips among `paths` that cut the picture: the ones whose bbox does not contain the picture's bbox. A page-sized
 * clip, which most pictures are painted under, is not one of them.
 */
export function restrictingClips(paths: readonly ClipPath[], imageBBox: Rect): ClipPath[] {
  return paths.filter((path) => {
    const box = clipPathBBox(path);
    return box !== null && !containsRect(box, imageBBox);
  });
}

/** The share of the picture (the unit square mapped by `ctm`) that lies inside every one of `paths`, sampled on a grid. */
export function clipCoverage(paths: readonly ClipPath[], ctm: Matrix): number {
  let inside = 0;
  for (let gy = 0; gy < SAMPLE_GRID; gy++) {
    for (let gx = 0; gx < SAMPLE_GRID; gx++) {
      const [x, y] = apply(ctm, (gx + 0.5) / SAMPLE_GRID, (gy + 0.5) / SAMPLE_GRID);
      if (paths.every((path) => pointInClipPath(path, x, y))) inside++;
    }
  }
  return inside / (SAMPLE_GRID * SAMPLE_GRID);
}
