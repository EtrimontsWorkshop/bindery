import type { DecodedImage } from './normalizeDecodedImage.js';
import { featherAlpha } from './featherAlpha.js';

/**
 * [Step 42 Z1, "a token with no transparency sits ON the map, not IN it"]
 * Removes the textured page background around an illustration meant for a
 * token — the classic "corner flood fill with tolerance" from image
 * editors: assumes ALL 4 image corners belong to the background (almost
 * always true for an illustration embedded on a rulebook page — the content
 * itself rarely touches ALL four corners at once), spreads (BFS, not
 * recursion — zero risk of stack overflow on large images) across
 * neighboring pixels whose color is within `tolerance` of EACH corner's OWN
 * seed (four independent sources, not one global color — the background can
 * be gradiented/vignetted, a single reference color from one corner wouldn't
 * match the others, the same spirit as `cropUniformMargins.ts`'s "each
 * line's own average, not one global color").
 */

export interface RemoveBackgroundOptions {
  /** Max deviation of an RGB channel from the seed color (the corner a given pixel is spreading from) for a pixel to count as "the same background". */
  tolerance: number;
  /** Radius for smoothing the removed-background boundary (see `featherAlpha.ts`) in pixels. */
  featherPx: number;
  /** [safeguard] If the fill would cover MORE than this share of the total area (0-1), abort and remove NOTHING — this means the background is NOT uniform (an image mostly "background" by tolerance = a false detection), not that the token genuinely has that much background to remove. */
  maxAreaFraction: number;
  /**
   * [background-click-in report Z1, "a hat merging with the body creates a
   * closed pocket of background"] Additional flood-fill seed points, BEYOND
   * the 4 corners — pixels manually pointed out by the user in background
   * areas NOT CONNECTED to the image's edge. The classic limitation of any
   * "corner flood fill" (magic wand): a background area cut off from the
   * edge by content (a pocket under a hat brim, between an arm and torso) is
   * unreachable from ANY corner, regardless of tolerance — this isn't an
   * implementation flaw, just the geometry of the problem. Each extra point
   * spreads with the SAME mechanism/tolerance as the corners, into a SHARED
   * `visited` set — `maxAreaFraction` is computed CUMULATIVELY over the SUM
   * of all fills (corners + all extra points), not separately per point, so
   * multiple clicks can't collectively "leak" more removal than the limit
   * allows. Coordinates outside the image are skipped (a safe no-op, not an
   * error). Empty by default — no change to prior behavior.
   */
  extraSeeds?: ReadonlyArray<{ x: number; y: number }>;
}

export interface RemoveBackgroundResult {
  /** The original (`aborted: true`) or the image with background removed (alpha=0 in the background, smoothed boundary). */
  image: DecodedImage;
  /** Share of area (0-1) actually removed — meaningful EVEN when `aborted` (shows by how much the limit was exceeded). */
  removedFraction: number;
  /** `true` = `maxAreaFraction` exceeded, `image` is the UNCHANGED original. */
  aborted: boolean;
}

/**
 * [Calibrated on a real portrait from `sample/ZewCthulhu-WRAK.pdf` (p. 26,
 * "Isaac Klein"), see `RAPORT-KROK-42.md` for the method] Painted/sketched
 * illustrations (the typical style of NPC portraits in rulebooks) often have
 * a SOFT, gradually shaded transition from background to content (no sharp
 * edge) — on this specific image, any tolerance >=16 chain-spread across the
 * whole picture (removedFraction jumped from ~0.40 at tolerance=12 to ~0.97
 * at tolerance=16, see the calibration history below) and removed MOST of
 * the portrait, not just the background. A flat/bright rulebook page
 * background (this function's target) needs a much smaller tolerance than
 * originally assumed (32) — 8-12 gave a clean result (background removed,
 * the portrait's rough painted border preserved) on this image, with a
 * clear cliff just above it. `tolerance: 10` was chosen as the middle of
 * this safe plateau, with margin on both sides (4 left a visible thin sliver
 * of background, 16 already catastrophically overwrote content).
 * `maxAreaFraction: 0.6` (unchanged) is PRECISELY the safeguard IN CASE of
 * such a "leak" — if the chain fill on some image exceeded 60% of the area,
 * the function ABORTS and returns the original (see the test "uniform
 * background... ABORTS").
 */
export const DEFAULT_REMOVE_BACKGROUND: RemoveBackgroundOptions = { tolerance: 10, featherPx: 2, maxAreaFraction: 0.6 };

function colorDistance(rgba: Uint8ClampedArray, idxA: number, idxB: number): number {
  const dr = rgba[idxA]! - rgba[idxB]!;
  const dg = rgba[idxA + 1]! - rgba[idxB + 1]!;
  const db = rgba[idxA + 2]! - rgba[idxB + 2]!;
  return Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
}

/**
 * [design decision] Tolerance is computed relative to the DIRECT neighbor
 * that "discovered" a given pixel (the last already-accepted pixel in the
 * chain), NOT relative to a constant corner seed color — the standard
 * "magic wand"/"contiguous flood" behavior from image editors. A rulebook
 * page background often has a SUBTLE gradient/vignette (shading toward the
 * edges, an "aged paper" texture) — comparing against a CONSTANT corner
 * would stop the spread prematurely at the gradient's edge, even though the
 * whole area is STILL uniform background; chained comparison allows a
 * GRADUAL color drift over a large area (each individual step small), while
 * still rejecting a SHARP jump (a genuine illustration edge).
 */

export function removeBackground(image: DecodedImage, opts: RemoveBackgroundOptions = DEFAULT_REMOVE_BACKGROUND): RemoveBackgroundResult {
  const { width, height, rgba } = image;
  const totalPixels = width * height;
  if (totalPixels === 0) return { image, removedFraction: 0, aborted: false };

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let queueHead = 0;
  let queueTail = 0;
  let removedCount = 0;

  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  const extraSeeds = opts.extraSeeds ?? [];
  const seeds: Array<[number, number]> = [...corners, ...extraSeeds.map((s): [number, number] => [Math.round(s.x), Math.round(s.y)])];
  for (const [cx, cy] of seeds) {
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue; // [background-click-in report Z1] a clicked coordinate outside the image — safe no-op
    const seedPos = cy * width + cx;
    if (visited[seedPos]) continue; // the same corner/point may already be visited via a fill from ANOTHER seed (small images: width or height == 1; a click into an already-removed area)
    visited[seedPos] = 1;
    queue[queueTail++] = seedPos;
    removedCount++;
    while (queueHead < queueTail) {
      const pos = queue[queueHead++]!;
      const posIdx = pos * 4;
      const x = pos % width;
      const y = (pos - x) / width;
      const neighbors: Array<[number, number]> = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const npos = ny * width + nx;
        if (visited[npos]) continue;
        const nIdx = npos * 4;
        if (colorDistance(rgba, posIdx, nIdx) <= opts.tolerance) {
          visited[npos] = 1;
          queue[queueTail++] = npos;
          removedCount++;
        }
      }
    }
  }

  const removedFraction = removedCount / totalPixels;
  if (removedFraction > opts.maxAreaFraction) {
    return { image, removedFraction, aborted: true };
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  for (let pos = 0; pos < totalPixels; pos++) {
    if (visited[pos]) out[pos * 4 + 3] = 0;
  }
  const feathered = featherAlpha({ width, height, rgba: out }, opts.featherPx);
  return { image: feathered, removedFraction, aborted: false };
}
