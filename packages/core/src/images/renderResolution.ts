/**
 * Region-render resolution policy (Step 8 Z3). Step 7's calibration
 * (RAPORT-KROK-7.md) showed that 92.7% of candidate images require a region
 * render (not direct extraction), and the default constant of 2048px was
 * insufficient for scenes/maps (the source resource's longer edge often
 * exceeds 2048px, so the render scales DOWN images sharper than the source).
 *
 * [Step 8, architectural constraint] The real `targetKind` (`scene`/
 * `handout`/`portrait`, `finalize.ts`) needs the ALREADY-decoded output
 * dimensions — it isn't available BEFORE the render (we're computing HERE
 * the resolution of THIS render). Instead of trying to predict `targetKind`
 * ahead of time (risking a mismatch with the real, later classification), we
 * use the region representative's `maxRelativeArea` — EXACTLY THE SAME
 * signal `classify.ts` already uses for content/decoration classification —
 * as a PROXY for the size category (a large "scene-like" image -> the
 * highest minimum, a medium "handout-like" one -> medium, a small
 * "portrait-like" one -> the lowest). This is a deliberate approximation,
 * documented here, not a mistake.
 */

/** Same threshold as `LARGE_AREA_CONTENT_THRESHOLD` in `classify.ts` (>=40% of the page = "scene-like"). */
const SCENE_LIKE_AREA_THRESHOLD = 0.4;
/** Same threshold as `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD` in `classify.ts` (>=10% of the page = "handout-like"). */
const HANDOUT_LIKE_AREA_THRESHOLD = 0.1;

/** Minimums from the Step 8 Z3 brief — to be calibrated against `samples/`. */
const MIN_SCENE_LONG_EDGE_PX = 2048;
const MIN_HANDOUT_LONG_EDGE_PX = 1024;
const MIN_PORTRAIT_LONG_EDGE_PX = 512;

/**
 * Safety multiplier above the source's native resolution — a region render
 * isn't 1:1 with the resource (it also covers the bbox's surrounding
 * pixels, possible CTM scaling), so a slight margin over the "bare" source
 * size guards against slight softness when zooming in Foundry. A starting
 * value, to be calibrated.
 */
const SAFETY_MARGIN = 1.15;

export interface RenderResolutionInput {
  /**
   * Native (source) longer-edge lengths (px) of ALL images in the region
   * whose resolution could be determined (see `probeIntrinsicLongEdgePx` in
   * `extract.ts`) — EMPTY for a purely vector region (no image) or when no
   * member could be resolved.
   */
  intrinsicLongEdgesPx: readonly number[];
  /** The region representative's `maxRelativeArea` — see the comment at the top of the file. `null` for a purely vector region. */
  representativeMaxRelativeArea: number | null;
  /** Default edge length used EXCLUSIVELY when there's no image at all in the region (brief: "value from settings"). */
  defaultLongEdgePx: number;
  /** Hard ceiling — guards against producing a file of absurd size from a spread. */
  maxLongEdgePx: number;
}

/** Minimum by size category (a proxy for `targetKind`, see the comment at the top of the file) — `null` when the region is purely vector (brief: no category minimum, just the value from settings). */
function minimumForCategory(representativeMaxRelativeArea: number | null): number | null {
  if (representativeMaxRelativeArea === null) return null;
  if (representativeMaxRelativeArea >= SCENE_LIKE_AREA_THRESHOLD) return MIN_SCENE_LONG_EDGE_PX;
  if (representativeMaxRelativeArea >= HANDOUT_LIKE_AREA_THRESHOLD) return MIN_HANDOUT_LONG_EDGE_PX;
  return MIN_PORTRAIT_LONG_EDGE_PX;
}

/**
 * `targetLongEdge = clamp(max(intrinsicLongEdge) * safetyMargin, category minimum, settings maximum)`
 * (Step 8 Z3 brief). A purely vector region (`intrinsicLongEdgesPx` empty
 * AND `representativeMaxRelativeArea===null`) skips the category minimum
 * entirely — there's nothing to map it to, so plain `defaultLongEdgePx` from
 * settings (clamped to the ceiling) is enough (brief: "value from settings").
 */
export function computeTargetLongEdgePx(input: RenderResolutionInput): number {
  if (input.intrinsicLongEdgesPx.length === 0) {
    const minimum = minimumForCategory(input.representativeMaxRelativeArea);
    const base = minimum !== null ? Math.max(input.defaultLongEdgePx, minimum) : input.defaultLongEdgePx;
    return Math.min(base, input.maxLongEdgePx);
  }

  const intrinsicMax = Math.max(...input.intrinsicLongEdgesPx);
  const desired = intrinsicMax * SAFETY_MARGIN;
  const minimum = minimumForCategory(input.representativeMaxRelativeArea) ?? MIN_PORTRAIT_LONG_EDGE_PX;
  return Math.min(Math.max(desired, minimum), input.maxLongEdgePx);
}
