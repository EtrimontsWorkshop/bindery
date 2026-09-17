import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [Step 17, a live-reported request] Automatic grid detection from map
 * pixels — a SUGGESTION for pre-filling `GridPicker` (packages/module), NOT
 * a replacement for manual calibration. MDD/step 8 (see the dead
 * `CIFScene.suggestedGrid` in `cif/types.ts`) deliberately deferred FULL
 * auto-detection beyond the MVP — this is NOT the same thing: here the
 * result is always best-effort + an explicit `confidence`, and the decision
 * "whether to show it as a pre-fill or ignore it" belongs to the caller
 * (`packages/module`, UI policy), not to this function (facts, not
 * decisions — the same division of responsibility as
 * `classify.ts`/`ReviewScreen`).
 *
 * Method: a VTT grid is a REGULAR, PERIODIC line structure — there's no need
 * to fit individual edges (Hough transform etc.), it's enough to find the
 * periodicity in the edge-strength PROFILE. For each axis separately:
 * 1) compute the luminance gradient (difference between adjacent pixels) and
 *    sum it ALONG the other axis -> a 1D "profile" (column x -> sum over y
 *    for vertical grid lines, row y -> sum over x for horizontal ones),
 * 2) for each candidate period p, search ALL phases o in [0,p) and take the
 *    one that maximizes the AVERAGE profile value at samples o, o+p, o+2p,
 *    ... — this simultaneously gives the period AND the phase (offset) in
 *    one pass, with no separate "find the offset" step.
 * 3) [discovery] phase sampling naturally favors MULTIPLES of the true
 *    period (2p, 3p... also hit every second/third line) — instead of
 *    taking the global maximum, we take the SMALLEST period whose score is
 *    close enough to the maximum (`HARMONIC_TOLERANCE`).
 *
 * Confidence (`confidence`) is calibrated PROVISIONALLY (no reference set of
 * real maps with known grids yet, unlike the thresholds in
 * `classify.ts`/`finalize.ts`) — to be verified against `samples/` in a
 * later step, if the suggestions turn out to be systematically over/under-
 * confident.
 */

export interface GridDetectionResult {
  size: number;
  offsetX: number;
  offsetY: number;
  /** 0-1, best-effort — see the function comment. */
  confidence: number;
}

export interface DetectGridOptions {
  minSize?: number;
  maxSize?: number;
}

const DEFAULT_MIN_SIZE_PX = 15;
const DEFAULT_MAX_SIZE_PX = 800;

/** Below this image edge length, it's not worth searching for periodicity — too little data. */
const MIN_IMAGE_EDGE_PX = 40;

/**
 * A period candidate is considered "good enough compared to the best" if its
 * score is >= this fraction of the best score found — see point 3 of the
 * `detectGrid` function comment (rejecting false period multiples).
 */
const HARMONIC_TOLERANCE = 0.92;

interface AxisCandidate {
  period: number;
  phase: number;
  confidence: number;
}

/**
 * Finds the best period+phase in a 1D edge-strength profile. Complexity: for
 * EVERY period candidate `p`, the total work across all phases `o` in [0,p)
 * is exactly `n` samples (p phases times n/p samples each) — so the TOTAL
 * work is `n * (maxP-minP)`, independent of how large `p` itself is.
 */
function findAxisPeriod(profile: Float64Array, minP: number, maxP: number): AxisCandidate | null {
  const n = profile.length;
  if (maxP <= minP || maxP >= n) return null;

  let profileMean = 0;
  for (let i = 0; i < n; i++) profileMean += profile[i]!;
  profileMean /= n;
  if (profileMean <= 0) return null; // no edges at all anywhere in the profile — no signal

  const rangeLen = maxP - minP + 1;
  const scores = new Float64Array(rangeLen);
  const phases = new Int32Array(rangeLen);
  let bestScore = -Infinity;

  for (let p = minP; p <= maxP; p++) {
    let periodBestScore = -Infinity;
    let periodBestPhase = 0;
    for (let o = 0; o < p; o++) {
      let sum = 0;
      let count = 0;
      for (let i = o; i < n; i += p) {
        sum += profile[i]!;
        count++;
      }
      const score = sum / count;
      if (score > periodBestScore) {
        periodBestScore = score;
        periodBestPhase = o;
      }
    }
    const idx = p - minP;
    scores[idx] = periodBestScore;
    phases[idx] = periodBestPhase;
    if (periodBestScore > bestScore) bestScore = periodBestScore;
  }

  let chosenIdx = -1;
  for (let idx = 0; idx < rangeLen; idx++) {
    if (scores[idx]! >= bestScore * HARMONIC_TOLERANCE) {
      chosenIdx = idx;
      break;
    }
  }
  if (chosenIdx < 0) return null;

  // Confidence: how much the chosen score stands out against the AVERAGE of
  // the whole profile (the edge "noise" level) — NOT against other periods
  // (those are already used to choose the period, not the confidence).
  const ratio = scores[chosenIdx]! / profileMean;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 3));

  return { period: minP + chosenIdx, phase: phases[chosenIdx]!, confidence };
}

export function detectGrid(image: DecodedImage, opts: DetectGridOptions = {}): GridDetectionResult | null {
  const { width, height, rgba } = image;
  if (width < MIN_IMAGE_EDGE_PX || height < MIN_IMAGE_EDGE_PX) return null;

  const minSize = Math.max(4, opts.minSize ?? DEFAULT_MIN_SIZE_PX);
  const maxSize = Math.min(opts.maxSize ?? DEFAULT_MAX_SIZE_PX, Math.floor(Math.min(width, height) / 3));
  if (maxSize <= minSize) return null;

  const n = width * height;
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    // Same coefficients as `computeLuminanceStdDev` in finalize.ts — consistency across the file.
    lum[p] = 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
  }

  // colProfile: strength of VERTICAL grid lines (HORIZONTAL gradient, summed over y).
  // rowProfile: strength of HORIZONTAL grid lines (VERTICAL gradient, summed over x).
  // One pass over the pixels computes both at once.
  const colProfile = new Float64Array(width);
  const rowProfile = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const prevRowOff = rowOff - width;
    for (let x = 0; x < width; x++) {
      const idx = rowOff + x;
      if (x > 0) colProfile[x]! += Math.abs(lum[idx]! - lum[idx - 1]!);
      if (y > 0) rowProfile[y]! += Math.abs(lum[idx]! - lum[prevRowOff + x]!);
    }
  }

  // [discovery, a bug caught by a test] `colProfile[0]`/`rowProfile[0]` are
  // BY DEFINITION always 0 (no left/top neighbor to subtract) — a constant
  // "false valley" at sample 0. Without cutting it out, this favors
  // periods/phases that "by accident" avoid sampling index 0 (e.g. a false
  // MULTIPLE of the true period) over ones that do hit it and are thus
  // unfairly "penalized". Shifting by 1 (and adding 1 to the returned phase)
  // removes this edge artifact entirely.
  const colResult = findAxisPeriod(colProfile.subarray(1), minSize, Math.min(maxSize, width - 2));
  const rowResult = findAxisPeriod(rowProfile.subarray(1), minSize, Math.min(maxSize, height - 2));
  if (colResult) colResult.phase += 1;
  if (rowResult) rowResult.phase += 1;
  if (!colResult && !rowResult) return null;

  if (colResult && rowResult) {
    const larger = Math.max(colResult.period, rowResult.period);
    const smaller = Math.min(colResult.period, rowResult.period);
    const agreement = smaller / larger; // 1 = identical periods on both axes, <1 = mismatch
    return {
      size: Math.round((colResult.period + rowResult.period) / 2),
      offsetX: colResult.phase,
      offsetY: rowResult.phase,
      confidence: Math.min(colResult.confidence, rowResult.confidence) * agreement,
    };
  }

  // Only ONE axis found periodicity — we assume a square grid (typical for
  // VTT maps) for the size, but the lack of independent confirmation lowers
  // confidence. The other axis's offset stays 0 (neutral, not guessed from
  // the unrelated phase of the other axis).
  const only = colResult ?? rowResult!;
  return colResult
    ? { size: only.period, offsetX: only.phase, offsetY: 0, confidence: only.confidence * 0.7 }
    : { size: only.period, offsetX: 0, offsetY: only.phase, confidence: only.confidence * 0.7 };
}
