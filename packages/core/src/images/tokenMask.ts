import type { DecodedImage } from './normalizeDecodedImage.js';
import { featherAlpha } from './featherAlpha.js';

/**
 * [Step 42 Z2, "mask: circle, square, rounded square, hex"] Shapes defined
 * as PURE geometry (an "is the point inside" test on normalized coordinates
 * `[-1,1] x [-1,1]`, canvas center = (0,0)), NOT a canvas clip-path — the
 * same philosophy as the rest of `packages/core` ("zero-DOM", testable
 * without a browser/Node canvas). `square` is deliberately "no masking" (the
 * whole square canvas) — one of four equally valid choices from the brief's
 * table, not a special case.
 */
export type TokenMaskShape = 'circle' | 'square' | 'roundedSquare' | 'hex';

/** Corner radius of `roundedSquare`, relative to the half-side (1.0) — 22% gives a clearly rounded but still "square" shape (not approaching a circle). */
const ROUNDED_SQUARE_CORNER_RADIUS = 0.22;

function isInsideRoundedSquare(nx: number, ny: number): boolean {
  const r = ROUNDED_SQUARE_CORNER_RADIUS;
  const dx = Math.max(Math.abs(nx) - (1 - r), 0);
  const dy = Math.max(Math.abs(ny) - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/**
 * A regular "flat-top" hexagon (flat top/bottom edges, sharp left/right
 * vertices), circumradius (to the vertices) = 1 — touches the canvas's
 * left/right edges, leaves a margin top/bottom (a hexagon's natural
 * proportions — a regular hexagon can't touch all 4 edges of a square at
 * once).
 *
 * Standard half-plane test: a point is inside a regular hexagon
 * (circumradius R, N=6 sides) exactly when, for EVERY one of the 6 edges,
 * its projection onto that edge's normal direction doesn't exceed the
 * apothem (the inradius, `R*cos(pi/N)`). By symmetry it's enough to check 3
 * of the 6 normals (opposite edges give the same condition after
 * `Math.abs`).
 */
function isInsideHexagon(nx: number, ny: number): boolean {
  const circumradius = 1;
  const apothem = circumradius * Math.cos(Math.PI / 6);
  for (let k = 0; k < 3; k++) {
    const theta = (k + 0.5) * (Math.PI / 3); // 30°, 90°, 150°
    const proj = nx * Math.cos(theta) + ny * Math.sin(theta);
    if (Math.abs(proj) > apothem) return false;
  }
  return true;
}

/** Whether the normalized point `(nx, ny)` (canvas center = (0,0), canvas edges = ±1) lies inside `shape`. */
export function isInsideShape(shape: TokenMaskShape, nx: number, ny: number): boolean {
  switch (shape) {
    case 'square':
      return true;
    case 'circle':
      return nx * nx + ny * ny <= 1;
    case 'roundedSquare':
      return isInsideRoundedSquare(nx, ny);
    case 'hex':
      return isInsideHexagon(nx, ny);
  }
}

/**
 * Applies `shape` to a SQUARE `image` (the caller is responsible for
 * cropping/scaling to a square beforehand — `applyTokenMask` itself does
 * NOT crop) — multiplies each pixel's alpha by 0 (outside the shape) or 1
 * (inside), then smooths the boundary via `featherAlpha` (a function SHARED
 * with `removeBackground.ts` — the same reason: blurring a uniform area
 * doesn't change it, so the effect is visible EXCLUSIVELY in a narrow band
 * around the shape's boundary).
 */
export function applyTokenMask(image: DecodedImage, shape: TokenMaskShape, featherPx: number): DecodedImage {
  const { width, height, rgba } = image;
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const halfW = width / 2;
  const halfH = height / 2;
  for (let y = 0; y < height; y++) {
    // The pixel's CENTER (y+0.5), not its corner — consistent with the
    // "integer coordinate = pixel center" convention used everywhere else in
    // this project (`sampleBilinear` in `rotateCrop.ts`).
    const ny = (y + 0.5 - halfH) / halfH;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - halfW) / halfW;
      if (!isInsideShape(shape, nx, ny)) {
        out[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  return featherAlpha({ width, height, rgba: out }, featherPx);
}
