import { EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, type ImageClassification } from './classify.js';
import type { ExtractSource } from './extract.js';
import type { GridDetectionResult } from './detectGrid.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { Diagnostic } from '../text/types.js';

/**
 * Deduplication and target classification (Step 7 Z5, MDD phase 3). Only
 * AFTER decoding is `contentHash` available — we use it to (1) close
 * correlation for U1 beyond what positional correlation caught (step 5/6),
 * (2) deduplicate the final list, (3) the `scene`/`handout`/`portrait`
 * heuristics (defaults — phase-4 profiles override them).
 *
 * `crypto.subtle` (Web Crypto) is used deliberately instead of
 * `node:crypto` — a web-platform standard ALSO available in Node (>=20), so
 * it works identically in the browser and in tests (the same pattern as
 * `OffscreenCanvas`, A1).
 *
 * [Step 7 Z6, memory budget] This function DELIBERATELY does not accept a
 * raw `DecodedImage` (48MB for a 4000x3000 image) — only an already-computed
 * `contentHash` + dimensions + an arbitrary "payload" (typically already-
 * encoded WebP/PNG bytes, far smaller). The orchestrator computes the hash
 * and encodes EVERY image separately, immediately after decode, and frees
 * the raw pixels BEFORE moving to the next one — only THEN (once all raw
 * buffers no longer exist) does it call `finalizeImages` on the lightweight
 * metadata list. Without this separation (computing the hash INSIDE
 * finalize, on the whole list at once) ALL of the document's decoded images
 * would have to be kept in memory simultaneously — exactly what the brief
 * forbids (a 1.2 GB RAM budget, "Twenty of these at once is 1 GB").
 */

export type ImageTargetKind = 'scene' | 'handout' | 'portrait' | 'unknown';

/**
 * Absolute size below which an image is SUSPECTED of being too small to be
 * useful content — a value taken DIRECTLY from MDD §Phase 3 ("reject
 * intrinsicWidth < 100 || intrinsicHeight < 100"), NEVER verified against
 * real material. Checked HERE (after decode), not in `classify.ts` — see the
 * comment there for why (pdf.js doesn't reveal intrinsicWidth/Height before
 * resolving the object).
 *
 * [Step 43 Z1, fix for "silent loss" found in a constants audit — A10] The
 * reclassification below used to land DIRECTLY in `decoration`, OVERRIDING
 * even the STRONGEST `content` signal (e.g. `Z1-large-relative-area`,
 * confidence 0.9) — with no calibration evidence and no chance for review.
 * A genuine small portrait/icon (e.g. 95x95px) would silently end up in
 * decoration, exactly the same bug pattern as
 * `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD` (see `classify.ts`) — unlike
 * the "flat texture" reclassification below (`FLAT_TEXTURE_STDDEV_THRESHOLD`),
 * which operates EXCLUSIVELY on an already-weak `content` signal
 * (`confidence < FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`), this rule had NO
 * such safeguard at all. Fix: it now lands in `undecided` (visible in the
 * review screen, with a `Diagnostic` `IMAGE_TOO_SMALL_UNDECIDED` in
 * `buildImageExtraction.ts`), not `decoration`.
 */
const MIN_ABSOLUTE_PX = 100;
/** [Step 43 Z1] Confidence for the "too small" -> `undecided` reclassification — the same level as other single, not-confirmed-by-a-second-signal signals (see `Z13-extreme-aspect-ratio-undecided` in `classify.ts`), NOT `RECLASSIFIED_CONFIDENCE` (0.9) used by the actual hard reclassifications below. */
const TOO_SMALL_UNDECIDED_CONFIDENCE = 0.4;

/**
 * [Step 8 Z2, discovery] Relative area (and even bbox aspect ratio) do NOT
 * reliably distinguish a genuine illustration from a FLAT BACKGROUND TEXTURE
 * (e.g. a uniform "paper"/"parchment" used as decorative page background) —
 * observed directly on `CP-RED-InterfaceVol1_v1.pdf` AFTER deploying
 * `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD` in `classify.ts`: two flat background
 * textures (area 0.193 and 0.279 of the page — WITHIN the genuine-content
 * range of 0.116-0.257) were falsely classified as `content`. The standard
 * deviation of pixel luminance AFTER decode distinguishes them
 * unambiguously: measured textures = 2.33 and 13.16, genuine content (6
 * images) = 40.75-81.20 — a clean gap. This signal needs ALREADY-decoded
 * pixels (like `MIN_ABSOLUTE_PX` above), so it's computed by the CALLER
 * (the orchestrator, `buildImageExtraction.ts`) and passed in as a ready
 * number — `finalize.ts` doesn't hold a raw `DecodedImage` (see the comment
 * about the memory budget).
 */
const FLAT_TEXTURE_STDDEV_THRESHOLD = 20;

/**
 * [Step 17, a live-reported bug] The "flat texture" reclassification below
 * only applies to entries with a WEAK `content` signal — exactly as it was
 * calibrated (both cases in the `FLAT_TEXTURE_STDDEV_THRESHOLD` comment are
 * `Z2-moderate-area-no-mask-evidence`, confidence 0.5). Observed directly on
 * `CHA23131 Call of Cthulhu 7th Edition Quick-Start Rules.pdf`: a
 * black-line-on-white-background drawn map ("Corbitt House Investigator
 * Map", `Z1-large-relative-area`, confidence 0.9 — a STRONG, unambiguous
 * geometric signal) has a low luminance standard deviation for EXACTLY THE
 * SAME reason as a flat parchment texture (a dominant light background, a
 * sparse dark line) — the reclassification unconditionally overrode a
 * strong signal with a weak, single-signal pixel heuristic, losing an
 * actual handout. Threshold = the same "content below this threshold starts
 * unchecked in the review screen" boundary used elsewhere in this file (see
 * `ClassifiedImage.confidence` in `classify.ts`) — not a new, independent
 * value.
 */
const FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE = 0.6;

/**
 * [User request] A SINGLE-COLOR image (e.g. a blank white rectangle, with at
 * most tiny deviations from it — anti-aliasing, compression noise) is never
 * useful content, so it is hidden from the auto-detected image list. This is
 * NOT the "flat texture" heuristic above (`FLAT_TEXTURE_STDDEV_THRESHOLD`,
 * a luminance spread that a line-art map on a white page also has): it asks
 * how many pixels are within `UNIFORM_COLOR_TOLERANCE` (per channel, out of
 * 255) of the image's average color. A sparse line map has a few percent of
 * ink pixels far from white, so it stays well below the fraction required
 * here; a truly blank image is at ~100%. Anything hidden this way can still
 * be recovered with "Select & cut" on the page preview.
 */
const UNIFORM_COLOR_TOLERANCE = 12;
const UNIFORM_COLOR_MIN_FRACTION = 0.995;

/**
 * [User request] SMOOTH BACKGROUND images — a paper/parchment texture or a
 * page-background wash: a soft vignette with only faint blotches, no edges,
 * no lines, no shapes. Not single-colored (so `UNIFORM_COLOR_*` misses it: a
 * vignette spreads the color) and with too high a luminance spread for
 * `FLAT_TEXTURE_STDDEV_THRESHOLD`, which also only ever touched weak
 * `content` (never `undecided`) and sat close to its limit on real material
 * (17.5 measured against the threshold 20).
 *
 * Two gradient measures on the decoded pixels (composited over white, so
 * artwork drawn in the alpha channel — pencil sketches — still counts):
 * - COARSE: the image reduced to ~256 blocks on its long side, mean absolute
 *   difference of neighboring blocks' luminance. Averaging blocks removes
 *   compression noise, so it doesn't depend on how noisy the source JPEG is.
 * - FINE: mean absolute luminance difference of neighboring pixels.
 * Measured on all 58 images extracted from "WFRP Ubersreik Adventures - If
 * Looks Could Kill" (Cubicle 7): the 15 paper/background images have coarse
 * 1.24-2.40 and fine 0.51-1.03; every genuine illustration (portraits, maps,
 * monsters, a faint pencil sketch on an alpha channel) has coarse >= 4.34
 * (fine >= 1.22). An image is hidden only when BOTH are below their
 * thresholds (about the midpoint of the gap in coarse, 1.5x the highest
 * background in fine), so a real image would have to be smooth at both scales
 * at once.
 */
const SMOOTH_BACKGROUND_COARSE_MAX = 3.2;
const SMOOTH_BACKGROUND_FINE_MAX = 1.5;
/** Long-side block count for the coarse measure. */
const SMOOTHNESS_COARSE_BLOCKS = 256;
/** Images with a shorter side below this are too small to judge as "smooth" — never hidden by this rule. */
const SMOOTHNESS_MIN_SIDE_PX = 16;

/** "High resolution" (brief, `scene`) — the longer edge. To be verified during calibration against `samples/`. */
const SCENE_MIN_LONG_EDGE_PX = 1200;
/** "Medium resolution" (brief, `handout`). */
const HANDOUT_MIN_LONG_EDGE_PX = 400;
const SCENE_ASPECT_MIN = 0.5;
const SCENE_ASPECT_MAX = 2.2;
/** "Small" (brief, `portrait`) — upper bound on the longer edge. */
const PORTRAIT_MAX_LONG_EDGE_PX = 400;
const PORTRAIT_ASPECT_MIN = 0.6;
const PORTRAIT_ASPECT_MAX = 1.1;

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * A hash of the image's content (dimensions + RGBA pixels) — NOT a hash of
 * the PDF file or the objId, just the actual decoded content. Called BY THE
 * CALLER (the orchestrator) on EACH image separately, immediately after
 * decode — see the comment at the top of the file.
 */
export async function computeContentHash(image: DecodedImage): Promise<string> {
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, image.width);
  headerView.setUint32(4, image.height);
  const combined = new Uint8Array(header.length + image.rgba.length);
  combined.set(header, 0);
  combined.set(image.rgba, header.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Standard deviation of pixel luminance (0-255) — the "flat texture" vs
 * "genuine illustration" signal, see `FLAT_TEXTURE_STDDEV_THRESHOLD`. One
 * pass, no allocation of an intermediate samples array (important for images
 * up to 4096x4096 = ~16M pixels). Called BY THE CALLER, same as
 * `computeContentHash`.
 */
export function computeLuminanceStdDev(image: DecodedImage): number {
  const { rgba, width, height } = image;
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const lum = 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance);
}

/**
 * The fraction (0-1) of pixels within `UNIFORM_COLOR_TOLERANCE` of the
 * image's average RGBA color — see `UNIFORM_COLOR_MIN_FRACTION`. Computed by
 * the caller right after decode, like `computeLuminanceStdDev`.
 */
export function computeUniformColorFraction(image: DecodedImage): number {
  const { rgba, width, height } = image;
  const n = width * height;
  if (n === 0) return 1;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    r += rgba[i]!;
    g += rgba[i + 1]!;
    b += rgba[i + 2]!;
    a += rgba[i + 3]!;
  }
  const mr = r / n;
  const mg = g / n;
  const mb = b / n;
  const ma = a / n;
  let close = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (
      Math.abs(rgba[i]! - mr) <= UNIFORM_COLOR_TOLERANCE &&
      Math.abs(rgba[i + 1]! - mg) <= UNIFORM_COLOR_TOLERANCE &&
      Math.abs(rgba[i + 2]! - mb) <= UNIFORM_COLOR_TOLERANCE &&
      Math.abs(rgba[i + 3]! - ma) <= UNIFORM_COLOR_TOLERANCE
    ) {
      close++;
    }
  }
  return close / n;
}

export interface SmoothnessMetrics {
  /** Mean absolute luminance difference between neighboring blocks (image reduced to ~256 blocks on its long side); `Infinity` for images too small to measure. */
  coarseGradient: number;
  /** Mean absolute luminance difference between neighboring pixels. */
  fineGradient: number;
}

/** See `SMOOTH_BACKGROUND_COARSE_MAX`. Luminance is composited over white so that content drawn in the alpha channel isn't ignored. */
export function computeSmoothnessMetrics(image: DecodedImage): SmoothnessMetrics {
  const { rgba, width, height } = image;
  if (width < 2 || height < 2) return { coarseGradient: Infinity, fineGradient: Infinity };
  const lum = new Float32Array(width * height);
  for (let p = 0; p < lum.length; p++) {
    const i = p * 4;
    const a = rgba[i + 3]! / 255;
    lum[p] = (0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!) * a + 255 * (1 - a);
  }

  let fineSum = 0;
  let fineCount = 0;
  for (let y = 0; y < height - 1; y += 2) {
    for (let x = 0; x < width - 1; x += 2) {
      const v = lum[y * width + x]!;
      fineSum += Math.abs(v - lum[y * width + x + 1]!) + Math.abs(v - lum[(y + 1) * width + x]!);
      fineCount += 2;
    }
  }
  const fineGradient = fineCount > 0 ? fineSum / fineCount : Infinity;

  const k = Math.max(1, Math.round(Math.max(width, height) / SMOOTHNESS_COARSE_BLOCKS));
  const bw = Math.floor(width / k);
  const bh = Math.floor(height / k);
  if (Math.min(width, height) < SMOOTHNESS_MIN_SIDE_PX || bw < 3 || bh < 3) return { coarseGradient: Infinity, fineGradient };
  const blocks = new Float64Array(bw * bh);
  for (let y = 0; y < bh * k; y++) {
    const row = Math.floor(y / k) * bw;
    for (let x = 0; x < bw * k; x++) blocks[row + Math.floor(x / k)]! += lum[y * width + x]!;
  }
  const area = k * k;
  let coarseSum = 0;
  let coarseCount = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const v = blocks[y * bw + x]! / area;
      if (x + 1 < bw) {
        coarseSum += Math.abs(v - blocks[y * bw + x + 1]! / area);
        coarseCount++;
      }
      if (y + 1 < bh) {
        coarseSum += Math.abs(v - blocks[(y + 1) * bw + x]! / area);
        coarseCount++;
      }
    }
  }
  return { coarseGradient: coarseSum / coarseCount, fineGradient };
}

export interface CorrelationClosureResult {
  /** Entries already linked by positional correlation (`correlatedWith`, step 5/6). */
  closedByBBox: number;
  /**
   * Entries ADDITIONALLY linked EXCLUSIVELY by an identical `contentHash` —
   * positional correlation did NOT catch this (e.g. the same resource
   * embedded on the page at a different position/crop than its "canonical"
   * occurrence). MUST be SIGNIFICANTLY smaller than `closedByBBox`, otherwise
   * the U1 mechanism isn't working (step 7's DoD).
   */
  closedByHash: number;
  /** `objId` -> canonical `objId` after accounting for BOTH signals (bbox + hash). */
  canonicalObjIdByObjId: ReadonlyMap<string, string>;
}

/**
 * Closes correlation via `contentHash` where positional (bbox) correlation
 * missed it — two entries with the same content hash are the same resource,
 * regardless of position. ALSO returns a count of what was already closed by
 * bbox, to compare the effectiveness of both mechanisms (brief: "report how
 * many such cases were found").
 */
export function closeCorrelationByHash(entries: readonly { entry: ImageEntry; contentHash: string }[]): CorrelationClosureResult {
  const bboxCanonicalOf = (e: ImageEntry): string => e.correlatedWith ?? e.objId ?? '';
  const closedByBBox = entries.filter(({ entry }) => entry.correlatedWith !== undefined).length;

  const entriesByBBoxCanonical = new Map<string, ImageEntry[]>();
  const byHash = new Map<string, Set<string>>();
  for (const { entry, contentHash } of entries) {
    if (entry.objId === null) continue; // inline: no objId, nothing to correlate
    const bboxCanonical = bboxCanonicalOf(entry);
    const arr = entriesByBBoxCanonical.get(bboxCanonical) ?? [];
    arr.push(entry);
    entriesByBBoxCanonical.set(bboxCanonical, arr);

    const set = byHash.get(contentHash) ?? new Set<string>();
    set.add(bboxCanonical);
    byHash.set(contentHash, set);
  }

  const totalOccurrences = (bboxCanonical: string): number =>
    (entriesByBBoxCanonical.get(bboxCanonical) ?? []).reduce((sum, e) => sum + e.occurrences.length, 0);

  // bboxCanonical -> new canonical AFTER closing via hash.
  const canonicalRemap = new Map<string, string>();
  let closedByHash = 0;
  for (const bboxCanonicalSet of byHash.values()) {
    if (bboxCanonicalSet.size <= 1) continue; // bbox already closed this (or only one canonical in this hash group)
    const keys = [...bboxCanonicalSet];
    // Canonical = the most TOTAL occurrences; ties broken by key (determinism, independent of input order).
    const canonical = keys.sort((a, b) => totalOccurrences(b) - totalOccurrences(a) || a.localeCompare(b))[0]!;
    for (const key of keys) {
      if (key === canonical) continue;
      canonicalRemap.set(key, canonical);
      closedByHash += (entriesByBBoxCanonical.get(key) ?? []).length;
    }
  }

  const canonicalObjIdByObjId = new Map<string, string>();
  for (const { entry } of entries) {
    if (entry.objId === null) continue;
    const bboxCanonical = bboxCanonicalOf(entry);
    const remapped = canonicalRemap.get(bboxCanonical);
    if (remapped) canonicalObjIdByObjId.set(entry.objId, remapped);
  }

  return { closedByBBox, closedByHash, canonicalObjIdByObjId };
}

export interface TargetKindInput {
  width: number;
  height: number;
  classification: ImageClassification;
  /** Whether there's a `statblock` or `heading` semantic block nearby (same page, step 6). */
  nearStatblockOrHeading: boolean;
}

/**
 * DEFAULT heuristics (per the brief) — phase-4 profiles override them. Check
 * order matters: `portrait` (small + proximity) is more specific than
 * `scene`/`handout` (resolution only), so it's checked first, so that a
 * small portrait near a statblock isn't caught by the more general
 * `handout` rule.
 */
export function classifyTargetKind(input: TargetKindInput): ImageTargetKind {
  if (input.classification !== 'content') return 'unknown';
  const longEdge = Math.max(input.width, input.height);
  const aspect = input.width / input.height;

  if (input.nearStatblockOrHeading && longEdge <= PORTRAIT_MAX_LONG_EDGE_PX && aspect >= PORTRAIT_ASPECT_MIN && aspect <= PORTRAIT_ASPECT_MAX) {
    return 'portrait';
  }
  if (longEdge >= SCENE_MIN_LONG_EDGE_PX && aspect >= SCENE_ASPECT_MIN && aspect <= SCENE_ASPECT_MAX) {
    return 'scene';
  }
  if (longEdge >= HANDOUT_MIN_LONG_EDGE_PX) {
    return 'handout';
  }
  return 'unknown';
}

/**
 * An entry ready for finalization — WITHOUT the raw `DecodedImage` (see the
 * comment at the top of the file about the memory budget). `payload` is
 * whatever the caller wants to carry through to the final result (typically
 * `EncodedImage` from `encodeImage.ts`, already-compressed WebP/PNG bytes) —
 * `finalizeImages` itself doesn't know or need to know what `payload` is.
 */
export interface PreparedEntryForFinalize<TPayload> {
  entry: ImageEntry;
  classification: ImageClassification;
  /** [Step 11 Z4] See `ClassifiedImage.confidence` in `classify.ts`. */
  confidence: number;
  extractSource: ExtractSource;
  contentHash: string;
  width: number;
  height: number;
  /** See `computeLuminanceStdDev`/`FLAT_TEXTURE_STDDEV_THRESHOLD`. Optional — no value skips the "flat texture" reclassification (e.g. in unit tests with no real pixels). */
  luminanceStdDev?: number;
  /** See `computeUniformColorFraction`. Optional — no value skips the "single-color image" rule (e.g. in unit tests with no real pixels). */
  uniformColorFraction?: number;
  /** See `computeSmoothnessMetrics`. Optional — no value skips the "smooth background" rule (e.g. in unit tests with no real pixels). */
  smoothness?: SmoothnessMetrics;
  /** [Step 17] See `detectGrid.ts` — a grid auto-detection suggestion, `undefined` when not computed (e.g. tests) or when `detectGrid` found no periodicity. */
  suggestedGrid?: GridDetectionResult;
  payload: TPayload;
}

export interface FinalizedImage<TPayload> {
  entry: ImageEntry;
  classification: ImageClassification;
  /** [Step 11 Z4] See `ClassifiedImage.confidence` in `classify.ts`. */
  confidence: number;
  extractSource: ExtractSource;
  contentHash: string;
  width: number;
  height: number;
  targetKind: ImageTargetKind;
  luminanceStdDev?: number;
  uniformColorFraction?: number;
  smoothness?: SmoothnessMetrics;
  suggestedGrid?: GridDetectionResult;
  payload: TPayload;
}

export interface FinalizeResult<TPayload> {
  images: FinalizedImage<TPayload>[];
  correlationClosedByBBox: number;
  correlationClosedByHash: number;
  duplicatesRemoved: number;
}

/**
 * Final step: reclassification by absolute size (deferred from Z1, see
 * `MIN_ABSOLUTE_PX`), closing correlation via hash, deduplication, target
 * classification. `prepared` MUST already be in deterministic order (e.g.
 * sorted by `objId` as in `imageRegistry.ts`) — the representative of each
 * duplicate group is the FIRST entry in that order. A pure (synchronous)
 * function — all the costly I/O (decode/hash/encode) has already happened
 * at the caller.
 */
export function finalizeImages<TPayload>(
  prepared: readonly PreparedEntryForFinalize<TPayload>[],
  nearStatblockOrHeadingByObjId: ReadonlySet<string>,
  // [Step 43 Z1] Optional — a caller with no need for diagnostics (e.g.
  // existing unit tests) gets exactly the behavior from before this flag.
  diagnostics: Diagnostic[] = [],
): FinalizeResult<TPayload> {
  // [Step 11 Z4] The "flat texture" reclassification below is a HARD,
  // unambiguous signal (a measured luminance stddev, applying EXCLUSIVELY to
  // already-weak `content` — see `FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`) —
  // it gets high confidence, it does NOT inherit the old `content` confidence
  // from before the reclassification (already stale, since the
  // classification changed).
  const RECLASSIFIED_CONFIDENCE = 0.9;
  const reclassified = prepared.map((d) => {
    // [User request] Images that are never worth reviewing — a single color
    // (blank), a smooth paper/page background, or a long narrow strip (typically a frame/border/divider) —
    // are hidden from the auto-detected list outright, whatever the earlier
    // signals said. `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD` is applied to
    // the DECODED size here, on top of the bbox-based rules in `classify.ts`
    // (which only ever made such strips `undecided`, so they still cluttered
    // the list). Recoverable via "Select & cut" on the page preview.
    if (d.classification === 'content' || d.classification === 'undecided') {
      const isUniformColor = d.uniformColorFraction !== undefined && d.uniformColorFraction >= UNIFORM_COLOR_MIN_FRACTION;
      const shortEdge = Math.min(d.width, d.height);
      const isLongAndNarrow = shortEdge > 0 && Math.max(d.width, d.height) / shortEdge >= EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD;
      const isSmoothBackground =
        d.smoothness !== undefined && d.smoothness.coarseGradient < SMOOTH_BACKGROUND_COARSE_MAX && d.smoothness.fineGradient < SMOOTH_BACKGROUND_FINE_MAX;
      if (isUniformColor || isLongAndNarrow || isSmoothBackground) {
        return { ...d, classification: 'decoration' as ImageClassification, confidence: RECLASSIFIED_CONFIDENCE };
      }
    }
    if (d.classification === 'content' && (d.width < MIN_ABSOLUTE_PX || d.height < MIN_ABSOLUTE_PX)) {
      diagnostics.push({
        severity: 'info',
        code: 'IMAGE_TOO_SMALL_UNDECIDED',
        params: { width: d.width, height: d.height, threshold: MIN_ABSOLUTE_PX },
        pageNumber: d.entry.occurrences[0]?.page,
      });
      return { ...d, classification: 'undecided' as ImageClassification, confidence: TOO_SMALL_UNDECIDED_CONFIDENCE };
    }
    // [Step 8 Z2] A flat texture (e.g. a paper background) — area/aspect
    // ratio alone do NOT distinguish it from a genuine illustration, see the
    // comment on `FLAT_TEXTURE_STDDEV_THRESHOLD`. [Step 17] EXCLUSIVELY for a
    // WEAK `content` signal — see `FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE`.
    if (
      d.classification === 'content' &&
      d.confidence < FLAT_TEXTURE_RECLASSIFY_MAX_CONFIDENCE &&
      d.luminanceStdDev !== undefined &&
      d.luminanceStdDev < FLAT_TEXTURE_STDDEV_THRESHOLD
    ) {
      return { ...d, classification: 'decoration' as ImageClassification, confidence: RECLASSIFIED_CONFIDENCE };
    }
    return d;
  });

  const closure = closeCorrelationByHash(reclassified.map((d) => ({ entry: d.entry, contentHash: d.contentHash })));

  const canonicalKeyOf = new Map<ImageEntry, string>();
  reclassified.forEach((d, i) => {
    if (d.entry.objId === null) {
      canonicalKeyOf.set(d.entry, `__inline_${i}__`);
      return;
    }
    const afterHash = closure.canonicalObjIdByObjId.get(d.entry.objId);
    canonicalKeyOf.set(d.entry, afterHash ?? d.entry.correlatedWith ?? d.entry.objId);
  });

  const groups = new Map<string, typeof reclassified>();
  for (const d of reclassified) {
    const key = canonicalKeyOf.get(d.entry)!;
    const arr = groups.get(key) ?? [];
    arr.push(d);
    groups.set(key, arr);
  }

  let duplicatesRemoved = 0;
  const images: FinalizedImage<TPayload>[] = [];
  for (const group of groups.values()) {
    const representative = group[0]!;
    duplicatesRemoved += group.length - 1;
    const targetKind = classifyTargetKind({
      width: representative.width,
      height: representative.height,
      classification: representative.classification,
      nearStatblockOrHeading: representative.entry.objId !== null && nearStatblockOrHeadingByObjId.has(representative.entry.objId),
    });
    images.push({ ...representative, targetKind });
  }

  return {
    images,
    correlationClosedByBBox: closure.closedByBBox,
    correlationClosedByHash: closure.closedByHash,
    duplicatesRemoved,
  };
}
