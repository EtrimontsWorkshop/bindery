import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [at the user's request, after fixing the "Wrak" crop] Images revealed by
 * `treatFullBleedAsContent` and cropped by `autoCropUniformMargins` lose the
 * ADJACENCY of the bright, "aged paper" page margin that, in the PDF, sat
 * NEXT TO the illustration and optically brightened it (a simultaneous
 * contrast effect, not a pixel change). The author reported this as
 * "exported images are a bit too dark" — this is a deliberate, cosmetic
 * departure from pixel fidelity (NOT a fix for a decoding bug, since there
 * isn't one here), hence its own explicit, default-off toggle
 * (`images.brightenAutoCroppedImages`), scoped EXCLUSIVELY to images that
 * were actually cropped (see the call site in `buildImageExtraction.ts`).
 *
 * [Third iteration, two consecutive live-measured failures]
 *
 * 1) A plain gamma curve (`out=255*(in/255)^gamma`) fails on images with a
 *    near-black background (p. 26 "Wrak.pdf", `img_p25_1`, a portrait on a
 *    dark vignette) — gamma BY DEFINITION preserves `0` (`0^gamma==0`), so
 *    near-black corners stay near-black REGARDLESS of how aggressive the
 *    gamma is (measured visually: even gamma=0.6 didn't move the vignette).
 *    Fixed in the FIRST iteration by adding a constant black-point lift
 *    BEFORE gamma.
 *
 * 2) A constant lift (e.g. `lift=25`) on its own turned out to be
 *    INSUFFICIENT for the very dark portrait (user: "in my opinion this is
 *    still too little"), but a lift LARGE ENOUGH for the portrait (e.g.
 *    `lift=60`) noticeably "washes out" p. 20 (the ship), whose darkest
 *    tones are already moderately bright (~21/255) — a single CONSTANT
 *    parameter cannot be simultaneously "enough" for an image with a
 *    near-black floor and "safe" for an image that has no such floor.
 *
 * Fix: ADAPTIVE level stretching — the black point is COMPUTED FROM EACH
 * IMAGE'S OWN histogram (the lower brightness percentile, robust to
 * individual noisy pixels unlike a plain minimum), shifted to a shared
 * target (`TARGET_FLOOR`). An image with a near-black floor (portrait,
 * percentile ~5/255) gets a LARGE stretch; an image whose floor is already
 * moderately bright (ship, percentile ~21/255) gets a SMALL one — exactly as
 * much as it NEEDS, not one rigid recipe for both.
 *
 * [Fourth iteration, at the user's explicit request "let's try brightening a
 * bit more" AFTER confirming that the TARGET_FLOOR=75 version already works]
 * Raised to 95 (gamma 0.95->0.9) — a noticeably brighter portrait, while the
 * ship still doesn't "wash out" into fog (checked visually: 110 already
 * noticeably flattens the ship's sky/ice, 95 does not yet).
 *
 * [Fifth iteration, user report "it's bright enough now, but it lost some
 * contrast"] Expected, not an oversight: stretching [sourceFloor, 255] ->
 * [targetFloor, 255] is BY DEFINITION a compression of that range into a
 * smaller output range — what brightens the shadows simultaneously flattens
 * the differences between them. Fix: an ADDITIONAL contrast pass around a
 * pivot (`out = pivot + (in-pivot)*contrastFactor`, AFTER stretching and
 * gamma) — the pivot is HIGHER than the standard 128 (calibrated to 150),
 * because this book's images are mostly bright (paper/ice), so a pivot near
 * the middle of the whole range would also darken already-bright areas.
 * Calibrated visually on BOTH images: contrastFactor=1.25 restores clear
 * shadow depth (the portrait's face, the ship's hull) without blowing out
 * already-bright areas (sky, ice, paper).
 */

export interface BrightenOptions {
  /** Target brightness (0-255) that the image's detected lower percentile is shifted to. */
  targetFloor: number;
  /** Lower brightness-histogram percentile (0-1) used as the "black point" of this SPECIFIC image — not a plain minimum, so a single noisy dark pixel can't dominate the whole calculation. */
  floorPercentile: number;
  /** Gamma curve applied AFTER level stretching; <1 brightens further (more strongly in shadows/midtones than in highlights). */
  gamma: number;
  /** Contrast boost around `contrastPivot`, applied AFTER gamma — restores the depth that level stretching flattens by definition. 1 = no change, >1 boosts. */
  contrastFactor: number;
  /** Point (0-255) around which `contrastFactor` operates — values above it increase, below it decrease. Deliberately HIGHER than the standard 128 for images dominated by bright tones (paper/ice), so contrast doesn't darken what's already bright. */
  contrastPivot: number;
}

/** [Calibrated visually on `img_p19_1` and `img_p25_1`, "Wrak.pdf", after four consecutive iterations] See the rationale in the file header. */
export const AUTOCROP_BRIGHTEN: BrightenOptions = { targetFloor: 95, floorPercentile: 0.01, gamma: 0.9, contrastFactor: 1.25, contrastPivot: 150 };

/** Brightness (0-255) below which `percentile` share of the image's pixels lies — the "black point" OWN to this image, not a global constant. */
function percentileLuminance(image: DecodedImage, percentile: number): number {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    const lum = Math.round((image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!) / 3);
    hist[lum]!++;
    total++;
  }
  const target = total * percentile;
  let cumulative = 0;
  for (let v = 0; v < 256; v++) {
    cumulative += hist[v]!;
    if (cumulative >= target) return v;
  }
  return 255;
}

/**
 * Brightens an image adaptively: computes this image's OWN lower brightness
 * percentile, stretches it to `targetFloor`, applies a gamma curve, and
 * finally restores contrast around `contrastPivot` (see the rationale in the
 * file header — stretching flattens differences by definition, which this
 * last step recovers). Operates on the R/G/B channels, alpha is untouched.
 * Two passes over the pixels (one histogram pass, one 256-entry LUT pass) —
 * not a per-pixel function call, safe for images with millions of pixels.
 */
export function brightenCroppedImage(image: DecodedImage, opts: BrightenOptions = AUTOCROP_BRIGHTEN): DecodedImage {
  const sourceFloor = percentileLuminance(image, opts.floorPercentile);
  // We stretch EXCLUSIVELY when the image actually has something darker than
  // the target — otherwise (the image ALREADY has shadows brighter than
  // `targetFloor`, e.g. an outdoor scene with no deep shadows) the formula
  // below would darken that lower percentile DOWN to the target, exactly the
  // opposite of the intent (this flag is meant to ONLY brighten an image,
  // never darken it).
  const needsStretch = sourceFloor < opts.targetFloor;
  const scale = needsStretch ? (255 - opts.targetFloor) / Math.max(1, 255 - sourceFloor) : 1;

  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const stretched = needsStretch ? Math.max(0, Math.min(255, opts.targetFloor + (i - sourceFloor) * scale)) : i;
    const gammaCorrected = 255 * Math.pow(stretched / 255, opts.gamma);
    const contrasted = opts.contrastPivot + (gammaCorrected - opts.contrastPivot) * opts.contrastFactor;
    lut[i] = Math.max(0, Math.min(255, Math.round(contrasted)));
  }

  const rgba = new Uint8ClampedArray(image.rgba.length);
  for (let i = 0; i < image.rgba.length; i += 4) {
    rgba[i] = lut[image.rgba[i]!]!;
    rgba[i + 1] = lut[image.rgba[i + 1]!]!;
    rgba[i + 2] = lut[image.rgba[i + 2]!]!;
    rgba[i + 3] = image.rgba[i + 3]!;
  }
  return { width: image.width, height: image.height, rgba };
}
