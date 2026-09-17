import { groupByQuantizedPosition } from '../collections.js';
import { axisPositions, baselineTolerance, computeStreamAngle, fontSizeFromTransform } from '../layout/textGeometry.js';

/**
 * Statistics on gaps between items, per font key (Step 5 Z2) — the
 * "enabler" for the whole step (assumption A8: this can't be computed on a
 * single page).
 *
 * Valley-finding method: **a histogram with smoothing (moving average) +
 * explicit detection of the two highest peaks and the valley between them**.
 * Chosen AFTER rejecting Otsu (1979): calibration on synthetic distributions
 * (see RAPORT-KROK-5.md) showed that Otsu's eta (the ratio of between-class
 * to total variance) is NOT a measure of bimodality — even a purely
 * unimodal, wide uniform distribution gets an eta of ~0.75 (because Otsu
 * always finds the "best possible" two-class split, regardless of whether a
 * real valley exists). k-means was also rejected (iterative, sensitive to
 * initialization, non-deterministic without a fixed seed). Explicit peak
 * detection + the valley between them gives separation=0 when there is only
 * one peak (a truly unimodal distribution), as the brief requires.
 */

export interface GapSample {
  fontKey: string;
  /** Horizontal gap (along the reading direction) between the end of the previous item and the start of the next, in pt. */
  gap: number;
  /** [Step 6 Z1a] The page number the sample came from — enabler for the per-page profile. */
  page: number;
}

export interface FontGapProfile {
  fontKey: string;
  /** A gap STRICTLY BELOW this threshold -> the same word. */
  intraWordThreshold: number;
  /** A gap ABOVE this threshold -> separate words. Between the thresholds: a zone of uncertainty, NEVER merge (P1). */
  interWordThreshold: number;
  /** Quality of mode separation (Otsu's eta, 0-1). Low = unimodal distribution. */
  separation: number;
  sampleCount: number;
  /** false when sampleCount is below the threshold OR separation is below the confidence threshold — Z4 condition #6 requires true to merge. */
  reliable: boolean;
}

const MIN_SAMPLE_COUNT = 50;
const MIN_SEPARATION = 0.3;
/** A +/-15% margin around the found valley — a safety zone (P1: never merge at the boundary of uncertainty). */
const VALLEY_MARGIN_RATIO = 0.15;
/** Fallback values from the brief: 0.25x font size for the intra-word threshold. */
const FALLBACK_INTRA_RATIO = 0.25;
const FALLBACK_INTER_RATIO = 0.6;
const HISTOGRAM_BINS = 48;

export interface GapAwareItem {
  fontKey: string;
  transform: readonly number[];
  width: number;
}

/**
 * Collects gap samples from items on ONE page (already past hygiene — no
 * whitespace items, see Z1). Groups by (angle, approximate cross-axis
 * position), sorts along the reading direction, computes gaps between the
 * END of the previous item and the START of the next. The gap is assigned
 * to the font key of the PRECEDING item (a property of its metrics/kerning).
 */
export function collectGapSamples(items: readonly GapAwareItem[], page: number): GapSample[] {
  const groups = groupByQuantizedPosition(items, (item) => {
    const angle = computeStreamAngle(item.transform);
    const cross = axisPositions(item.transform, angle).cross;
    const tolerance = baselineTolerance(fontSizeFromTransform(item.transform));
    return `${angle}|${Math.round(cross / tolerance)}`;
  });

  const samples: GapSample[] = [];
  for (const arr of groups.values()) {
    const withAxis = arr.map((item) => {
      const angle = computeStreamAngle(item.transform);
      return { item, along: axisPositions(item.transform, angle).along };
    });
    withAxis.sort((a, b) => a.along - b.along);
    for (let i = 1; i < withAxis.length; i++) {
      const prev = withAxis[i - 1]!;
      const curr = withAxis[i]!;
      const gap = curr.along - (prev.along + prev.item.width);
      if (gap >= 0) samples.push({ fontKey: prev.item.fontKey, gap, page });
    }
  }
  return samples;
}

interface ValleyResult {
  threshold: number;
  separation: number;
}

/** Minimum number of bins that must separate two peaks for them to count as distinct modes (not quantization noise). */
const MIN_PEAK_SEPARATION_BINS = 3;

function buildHistogram(values: readonly number[], bins: number, binWidth: number): number[] {
  const histogram = new Array<number>(bins).fill(0);
  for (const v of values) {
    const bin = Math.min(bins - 1, Math.floor(v / binWidth));
    histogram[bin]!++;
  }
  return histogram;
}

/** Width-3 moving-average smoothing — dampens single-bin noise without assuming a specific distribution shape. */
function smooth(histogram: readonly number[]): number[] {
  return histogram.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(histogram.length - 1, i + 1);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += histogram[j]!;
    return sum / (hi - lo + 1);
  });
}

/** Local maxima (>= both neighbors, > 0), sorted by height descending. */
function findPeaks(histogram: readonly number[]): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < histogram.length; i++) {
    const h = histogram[i]!;
    if (h <= 0) continue;
    const prev = i > 0 ? histogram[i - 1]! : -Infinity;
    const next = i < histogram.length - 1 ? histogram[i + 1]! : -Infinity;
    if (h >= prev && h >= next) peaks.push(i);
  }
  return peaks.sort((a, b) => histogram[b]! - histogram[a]!);
}

/**
 * Finds the valley between the two highest, sufficiently distant peaks of
 * the smoothed histogram. No two distinct peaks -> separation=0 (a unimodal
 * distribution, per the brief §Z2: "low separation = unimodal distribution").
 */
function findValley(values: readonly number[]): ValleyResult {
  const max = Math.max(...values);
  if (max <= 0 || values.length === 0) return { threshold: 0, separation: 0 };

  const binWidth = max / HISTOGRAM_BINS || 1;
  const raw = buildHistogram(values, HISTOGRAM_BINS, binWidth);
  const histogram = smooth(raw);
  const peaks = findPeaks(histogram);

  if (peaks.length < 2) return { threshold: max / 2, separation: 0 };

  // The highest peak + the highest OTHER peak at least MIN_PEAK_SEPARATION_BINS bins away.
  const first = peaks[0]!;
  const second = peaks.slice(1).find((p) => Math.abs(p - first) >= MIN_PEAK_SEPARATION_BINS);
  if (second === undefined) return { threshold: max / 2, separation: 0 };

  const lo = Math.min(first, second);
  const hi = Math.max(first, second);
  let valleyBin = lo;
  for (let i = lo; i <= hi; i++) {
    if (histogram[i]! < histogram[valleyBin]!) valleyBin = i;
  }

  const peakHeight = Math.min(histogram[lo]!, histogram[hi]!);
  const separation = peakHeight > 0 ? Math.max(0, Math.min(1, 1 - histogram[valleyBin]! / peakHeight)) : 0;
  return { threshold: (valleyBin + 0.5) * binWidth, separation };
}

function fallbackProfile(fontKey: string, size: number, sampleCount: number): FontGapProfile {
  return {
    fontKey,
    intraWordThreshold: size * FALLBACK_INTRA_RATIO,
    interWordThreshold: size * FALLBACK_INTER_RATIO,
    separation: 0,
    sampleCount,
    reliable: false,
  };
}

/**
 * Builds a gap profile per font key from samples collected across the WHOLE
 * document. `fontSizeByKey` (from InventoryResult.fonts) feeds the fallback
 * value when there are too few samples OR the distribution is unimodal (Z2
 * safeguards). Never extrapolates one font's profile onto another — a
 * missing entry in `fontSizeByKey` for a key with no samples gets a fallback
 * with size 1 (last resort, always reliable=false).
 */
/** Builds a single profile from an array of gaps already assigned to one font key — the core shared by the document level and the page level (Z1a). */
function profileFromGaps(fontKey: string, gaps: readonly number[], size: number): FontGapProfile {
  if (gaps.length < MIN_SAMPLE_COUNT) {
    return fallbackProfile(fontKey, size, gaps.length);
  }
  const { threshold, separation } = findValley(gaps);
  if (separation < MIN_SEPARATION) {
    return { ...fallbackProfile(fontKey, size, gaps.length), separation };
  }
  return {
    fontKey,
    intraWordThreshold: threshold * (1 - VALLEY_MARGIN_RATIO),
    interWordThreshold: threshold * (1 + VALLEY_MARGIN_RATIO),
    separation,
    sampleCount: gaps.length,
    reliable: true,
  };
}

function groupGapsByFont(samples: readonly GapSample[]): Map<string, number[]> {
  const byFont = new Map<string, number[]>();
  for (const s of samples) {
    const arr = byFont.get(s.fontKey);
    if (arr) arr.push(s.gap);
    else byFont.set(s.fontKey, [s.gap]);
  }
  return byFont;
}

/**
 * Builds a gap profile per font key from samples collected across the WHOLE
 * document. `fontSizeByKey` (from InventoryResult.fonts) feeds the fallback
 * value when there are too few samples OR the distribution is unimodal (Z2
 * safeguards). Never extrapolates one font's profile onto another — a
 * missing entry in `fontSizeByKey` for a key with no samples gets a fallback
 * with size 1 (last resort, always reliable=false).
 */
export function buildFontGapProfiles(
  samples: readonly GapSample[],
  fontSizeByKey: ReadonlyMap<string, number>,
): Map<string, FontGapProfile> {
  const byFont = groupGapsByFont(samples);
  const profiles = new Map<string, FontGapProfile>();
  const allKeys = new Set<string>([...byFont.keys(), ...fontSizeByKey.keys()]);
  for (const fontKey of allKeys) {
    profiles.set(fontKey, profileFromGaps(fontKey, byFont.get(fontKey) ?? [], fontSizeByKey.get(fontKey) ?? 1));
  }
  return profiles;
}

/**
 * [Step 6 Z1a] Hierarchical profile: document-level + per-page. Fixes a
 * systematic bug from Step 5 (RAPORT-KROK-5.md): pages with a dense,
 * atypical layout (tables of contents) have their OWN, tighter gap
 * distribution, which the document-level profile (averaged over the whole
 * file, including paragraphs with different geometry) fails to capture.
 * With no knowledge of page semantics — purely geometric, per-page
 * statistics using the same mechanism as the document level.
 */
export interface HierarchicalGapProfile {
  fontKey: string;
  document: FontGapProfile;
  /** A profile ONLY for pages with enough samples (>= MIN_PAGE_SAMPLE_COUNT) — a missing entry means no own profile for that page for this font. */
  byPage: Map<number, FontGapProfile>;
}

/**
 * The sample threshold at the PAGE level, lower than the document one
 * (MIN_SAMPLE_COUNT=50). A single page inherently has fewer samples than the
 * whole document — requiring the same threshold as the whole document would
 * make it practically impossible for any per-page profile to ever form
 * (verified empirically on Cienie_posrod_mgie.pdf p. 3: 32 samples for the
 * table-of-contents font, below 50, but that's ALREADY HALF of all
 * occurrences of that font in the entire document — the brief's "don't
 * guess from a handful of samples" applies to a small handful of samples,
 * not to this case).
 */
const MIN_PAGE_SAMPLE_COUNT = 20;

export function buildHierarchicalGapProfiles(
  samples: readonly GapSample[],
  fontSizeByKey: ReadonlyMap<string, number>,
): Map<string, HierarchicalGapProfile> {
  const documentProfiles = buildFontGapProfiles(samples, fontSizeByKey);

  const samplesByPage = new Map<number, GapSample[]>();
  for (const s of samples) {
    const arr = samplesByPage.get(s.page);
    if (arr) arr.push(s);
    else samplesByPage.set(s.page, [s]);
  }

  const hierarchical = new Map<string, HierarchicalGapProfile>();
  for (const [fontKey, document] of documentProfiles) {
    hierarchical.set(fontKey, { fontKey, document, byPage: new Map() });
  }

  for (const [page, pageSamples] of samplesByPage) {
    const byFontOnPage = groupGapsByFont(pageSamples);
    for (const [fontKey, gaps] of byFontOnPage) {
      // [Z1a requirement] Below the sample threshold on THIS page -> don't guess, no entry (use only the document-level profile).
      if (gaps.length < MIN_PAGE_SAMPLE_COUNT) continue;
      const size = fontSizeByKey.get(fontKey) ?? 1;
      // Accept the page profile EVEN when it's not "reliable" (no clear valley) —
      // the fallback (0.25x size) is still a legitimate, conservative estimate
      // "from this page", not a guess from a handful of samples (we already have
      // >= MIN_PAGE_SAMPLE_COUNT). This is exactly the case that lets dense pages
      // (table of contents) "defend themselves" (per the Z1a brief) — their
      // distribution often has no clean bimodal valley, because ALL observed gaps
      // are already inter-entry (each table-of-contents entry is one Tj, no
      // internal fragmentation), so the fallback is the CORRECT estimate here,
      // not a stand-in.
      const pageProfile = profileFromGaps(fontKey, gaps, size);
      hierarchical.get(fontKey)?.byPage.set(page, pageProfile);
    }
  }

  return hierarchical;
}

/**
 * The effective profile for merging on a given page: when the page has its
 * OWN reliable profile for this font, it uses the MORE CONSERVATIVE (smaller)
 * of the two intra-word thresholds — document-level and page-level.
 * Otherwise (too few samples on this page, per the Z1a brief), it uses only
 * the document-level profile.
 */
export function effectiveGapProfileForPage(hierarchical: HierarchicalGapProfile, page: number): FontGapProfile {
  const pageProfile = hierarchical.byPage.get(page);
  if (!pageProfile) return hierarchical.document;
  if (!hierarchical.document.reliable) return pageProfile;

  return {
    fontKey: hierarchical.fontKey,
    intraWordThreshold: Math.min(hierarchical.document.intraWordThreshold, pageProfile.intraWordThreshold),
    interWordThreshold: Math.min(hierarchical.document.interWordThreshold, pageProfile.interWordThreshold),
    separation: Math.min(hierarchical.document.separation, pageProfile.separation),
    sampleCount: pageProfile.sampleCount,
    reliable: true,
  };
}

/**
 * [Step 6 Z1b] A reliability metric WEIGHTED BY GLYPHS — unlike raw counting
 * of font keys (`fontsWithUnreliableProfile`, RAPORT-KROK-5.md: 76-94%),
 * which treats a rare heading used on 5 glyphs the same as a body font
 * carrying 80% of the page's text. A font's `key` is font+size, so rare
 * combinations dominate the KEY count but carry a negligible share of actual
 * text — this metric reports what fraction of GLYPHS (not keys) has a
 * reliable document-level profile.
 */
export function computeReliableGlyphCoverage(
  fonts: readonly { key: string; glyphCount: number }[],
  documentProfiles: ReadonlyMap<string, HierarchicalGapProfile>,
): number {
  let totalGlyphs = 0;
  let reliableGlyphs = 0;
  for (const font of fonts) {
    totalGlyphs += font.glyphCount;
    if (documentProfiles.get(font.key)?.document.reliable) reliableGlyphs += font.glyphCount;
  }
  return totalGlyphs > 0 ? reliableGlyphs / totalGlyphs : 0;
}
