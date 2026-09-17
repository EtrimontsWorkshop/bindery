/**
 * 2D matrices and rectangles — math shared by the inventory pass (phase 2/3,
 * MDD appendix A). Reimplemented independently of pdfjs-dist (we do not
 * import `Util` from pdf.js here), so `walkOperators` stays a fully pure
 * function, testable on bare number arrays with zero dependencies — the
 * formula was verified directly against `Util.transform` in pdf.mjs (Step 4).
 */

/** PDF affine matrix: [a, b, c, d, e, f], point' = (x*a + y*c + e, x*b + y*d + f). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Composes two matrices: `m1` (the current CTM) extended by `m2` (the new
 * matrix, e.g. from a `cm` operator). Formula identical to
 * `Util.transform(m1, m2)` in pdf.js.
 */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bbox of the unit square [0,1]x[0,1] transformed by the CTM — methodology
 * from the phase-0 spike (`Util.getAxialAlignedBoundingBox` does not exist in
 * 6.1.200). Negative coordinates ARE valid (print bleed) — never clip them.
 */
export function unitSquareBBox(ctm: Matrix): Rect {
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of corners) {
    xs.push(ctm[0] * x + ctm[2] * y + ctm[4]);
    ys.push(ctm[1] * x + ctm[3] * y + ctm[5]);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Bbox of a pdf.js TextItem run. This is NOT the same case as `localRectBBox`:
 * `item.width`/`item.height` from `getTextContent()` are ALREADY the final
 * length in device space (the sum of glyph position deltas, see
 * `updateAdvanceScale` in pdf.worker.mjs) — NOT local pre-transform units like
 * with the `re` operator. Multiplying them by `transform[0]`/`transform[3]`
 * (as `localRectBBox` does) DOUBLES the scaling by the font size (e.g. 10x
 * for Tf 10) — discovered empirically in Step 6 during the first integration
 * of column detection on real fixtures (line bboxes reached x=2000+ on a
 * 612pt-wide page). Instead: normalize direction from (a,b)/(c,d), scale by
 * the ALREADY-final width/height.
 */
export function textRunBBox(transform: Matrix, width: number, height: number): Rect {
  const [a, b, c, d, e, f] = transform;
  const hLen = Math.hypot(a, b) || 1;
  const vLen = Math.hypot(c, d) || 1;
  const hx = (a / hLen) * width;
  const hy = (b / hLen) * width;
  const vx = (c / vLen) * height;
  const vy = (d / vLen) * height;
  const corners: Array<[number, number]> = [
    [e, f],
    [e + hx, f + hy],
    [e + vx, f + vy],
    [e + hx + vx, f + hy + vy],
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function unionRect(a: Rect, b: Rect): Rect {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Intersection area / area of the smaller of the two rectangles — used for mask detection (the "geometry" path). */
export function overlapRatio(a: Rect, b: Rect): number {
  const inter = rectIntersection(a, b);
  if (!inter) return 0;
  const smaller = Math.min(rectArea(a), rectArea(b));
  if (smaller <= 0) return 0;
  return rectArea(inter) / smaller;
}

/** Area of `r` relative to the page area — 0..1+ (an image may extend past the page). */
export function relativeArea(r: Rect, page: Rect): number {
  const pageArea = rectArea(page);
  if (pageArea <= 0) return 0;
  return rectArea(r) / pageArea;
}

/**
 * [extracted after a full design review — the same formula was duplicated
 * across three files in `profiles/`] Distance between the NEAREST edges of
 * two rectangles — 0 when they touch or overlap (a negative/zero gap is
 * clamped to 0 on each axis separately BEFORE `Math.hypot`, not after),
 * otherwise the Euclidean distance between the nearest points.
 */
export function rectGapDistance(a: Rect, b: Rect): number {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
  const dy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * [user report, "the image shrinks a lot after rotation, lots of empty space
 * in the frame"] Scale factor `s` (0 < s <= 1) of the LARGEST rectangle with
 * the SAME aspect ratio as `width x height` that fits ENTIRELY inside THAT
 * SAME rectangle rotated by `angleRad` (ANY angle, any sign, any magnitude —
 * see the reduction below). Output: `packages/module`'s `#rotateImage` uses
 * this to crop the rotated image down to size WITHOUT transparent corners
 * (instead of enlarging the canvas to fit the WHOLE original with empty
 * corners) — the standard behavior of "straighten" tools in photo editors.
 *
 * Derivation: an output rectangle with half-dimensions `(s*a, s*b)`
 * (a=width/2, b=height/2), CENTERED at the same point as the rotation, fits
 * inside the original (pre-rotation) exactly when EVERY one of its 4 corners,
 * after rotating BACKWARD by `angleRad` (matrix `R(-angleRad)`), has
 * coordinates in `[-a,a] x [-b,b]` — the four inequalities from this (one per
 * distinct corner type) give four upper bounds on `s`, of which the SMALLEST
 * (most restrictive) is taken. Manually verified on two known cases: angle=0
 * -> s=1 (full size); a square rotated 45° -> s=1/√2 (known geometric result)
 * — see the tests.
 *
 * [fix for a reported bug — "after 36 rotations of 10° each, the image
 * shrinks" ALSO revealed that the function produced NEGATIVE (nonsensical)
 * results for angles > 90°, e.g. 170°/190°] The rectangle has a 180° PERIOD
 * (central symmetry — rotating by θ and by θ+180° yields an IDENTICAL point
 * set) AND is symmetric with respect to sign (rotating left/right by the same
 * angle gives a mirrored, and therefore scale-equivalent, result) — the
 * previous `Math.abs(angleRad)` with no other reduction correctly handled
 * ONLY angles already in [-90°, 90°]; for larger angles (unavoidable when
 * repeatedly clicking a small-step rotate button) it produced arbitrarily
 * wrong results. Reduction below: modulo π (180° period, handling negatives —
 * JS `%` is NOT "floor mod"), fold into `(-π/2, π/2]`, then `Math.abs` ->
 * always `[0, π/2]`.
 */
export function inscribedRotatedRectScale(width: number, height: number, angleRad: number): number {
  if (width <= 0 || height <= 0) return 1;
  const a = width / 2;
  const b = height / 2;
  let angle = angleRad % Math.PI;
  if (angle < 0) angle += Math.PI; // now in [0, π)
  if (angle > Math.PI / 2) angle -= Math.PI; // now in (-π/2, π/2]
  angle = Math.abs(angle); // now in [0, π/2]
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const c1 = a / (a * cos + b * sin);
  const d2 = b * cos - a * sin;
  const c2 = d2 !== 0 ? b / Math.abs(d2) : Infinity;
  const d3 = a * cos - b * sin;
  const c3 = d3 !== 0 ? a / Math.abs(d3) : Infinity;
  const c4 = b / (a * sin + b * cos);
  return Math.min(c1, c2, c3, c4, 1);
}
