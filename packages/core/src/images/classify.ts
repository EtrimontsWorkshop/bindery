import type { Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';

/**
 * Content/decoration/mask classification (Step 7 Z1, MDD phase 3
 * "Decision"). Input: `ImageEntry[]` from the inventory pass (step 4, zero
 * decode). Operate EXCLUSIVELY on facts already gathered — do not decode
 * here (pass 2 is Z4, a separate step).
 *
 * Signals in order of strength from the brief, with ONE documented
 * exception: "absolute size" (step 4 of the brief) needs
 * intrinsicWidth/Height, which pdf.js only reveals when resolving the object
 * (`page.objs.get()`/`commonObjs.get()`) — the operator list (inventory
 * pass) doesn't carry this information, only the bbox in device space
 * (after the CTM). Rejection by absolute size is therefore applied AFTER
 * decode, in `finalize.ts` (Z5) — documented explicitly there, not silently
 * skipped.
 */

export type ImageClassification = 'content' | 'decoration' | 'mask' | 'undecided';

export interface ClassifiedImage {
  entry: ImageEntry;
  classification: ImageClassification;
  /** Which rule decided — debuggability, the same pattern as `matchedRuleId` in Z6 of step 6. */
  reason: string;
  /**
   * [Step 11 Z4] Decision confidence (0-1), DERIVED from the strength of the
   * signal for the rule that decided (`reason`) — NOT a new, independent
   * model. The review screen (phase 9, `packages/module`) uses it for the
   * default checkbox state: `content` with `confidence < 0.6` (the only such
   * case: `Z2-moderate-area-no-mask-evidence`, see the comment on that rule
   * — "moderate area + zero evidence" is the WEAKEST of the positive
   * signals) starts unchecked despite being classified `content`, same as
   * `undecided`. Values calibrated directly against the signal-strength
   * hierarchy already documented in this file's header ("Signals in order
   * of strength from the brief") — NOT a separate, new model.
   */
  confidence: number;
}

/**
 * [Step 11 Z4] Mapping from `reason` (a rule identifier from
 * `classifyImages`) to confidence (0-1) — see the comment on
 * `ClassifiedImage.confidence`. Hard evidence (group/opcode mask, print
 * bleed) = high confidence; `undecided` is by definition below 0.5
 * (conflicting or zero evidence); `Z2-moderate-area-no-mask-evidence` is the
 * only `content` case BELOW the 0.6 threshold from Z4 — deliberately, it's
 * the weakest positive signal in the whole file.
 */
const CONFIDENCE_BY_REASON: Readonly<Record<string, number>> = {
  'Z1-mask-evidence-group': 0.95,
  'Z1-mask-evidence-opcode': 0.95,
  'Z1-full-bleed-background': 0.9,
  'Z1-large-relative-area': 0.9,
  'Z1-multi-page-correlated': 0.85,
  'Z2-strong-content-overrides-weak-geometry-evidence': 0.85,
  'Z9-high-body-text-coverage': 0.8,
  'Z2-moderate-area-no-mask-evidence': 0.5,
  'Z10-high-center-text-coverage': 0.35,
  // [Step 15 Z3, A10] "Soft" versions of two former hard rules — ONE signal
  // (repetition or print bleed) without the other, independent
  // confirmation. Same confidence level as other single, conflicting
  // signals (`Z1-conflicting-geometry-mask-vs-large-area`).
  'Z11-repeated-no-bleed-evidence': 0.4,
  'Z12-bleeding-no-center-text-evidence': 0.4,
  'Z1-conflicting-geometry-mask-vs-large-area': 0.4,
  'Z1-weak-geometry-mask-evidence': 0.3,
  'Z1-no-strong-signal': 0.2,
  // [Step 43 Z1, fix for "silent loss"] A single aspect-ratio signal ON ITS
  // OWN — no longer hard `decoration` (see the comment on
  // `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`), just `undecided`. Same
  // confidence as other single, not-confirmed-by-a-second-signal `undecided`
  // cases below (`Z12`/`Z1-conflicting`) — not `Z1-no-strong-signal` (0.2),
  // because the aspect ratio IS a real, just unconfirmed, signal.
  'Z13-extreme-aspect-ratio-undecided': 0.4,
  // [user report, "Archiwa Imperium"] Two INDEPENDENT signals together
  // (repetition ACROSS MULTIPLE pages + extreme bbox aspect ratio) — same
  // confidence as `Z1-multi-page-correlated` (repetition + print bleed),
  // because it's CONCEPTUALLY the same pattern, just with a different second
  // signal.
  'Z14-repeated-extreme-aspect-ratio': 0.85,
};
/** Default confidence for an unrecognized `reason` (e.g. a future rule with no entry) — a safe middle ground, since `< 0.6` ends up in the review screen anyway. */
const DEFAULT_CONFIDENCE = 0.5;

export function confidenceForReason(reason: string): number {
  return CONFIDENCE_BY_REASON[reason] ?? DEFAULT_CONFIDENCE;
}

/**
 * A resource present on >= this many CORRELATED pages (see
 * `correlatedPageCount`) is a CANDIDATE for decoration (since step 15 — see
 * A10 at the call site, no longer a hard decision on its own) — MDD: "a
 * decoration on 40 pages", but without correlation the first occurrence of
 * such a resource looks like unique content (U1).
 *
 * [Step 15 Z3, calibrated against the step-14 reference set — 556 manually
 * labeled images] The starting value from the brief/MDD (=2) measured
 * directly: `useful` with correlatedPages>=2: 22/133 (falsely caught — a
 * region map referenced across several chapters, a repeated faction symbol).
 * `decoration` with correlatedPages>=2: 21/200 (correctly caught). Raising
 * to >=5 gives 12/133 false positives (-45%) at the cost of only 19/200 true
 * positives (-10%) — a clearly better trade-off. Beyond 5 further gains are
 * negligible (>=10 gives the same 12/133). `tools/analyze-correlation-threshold.ts`
 * (a one-off diagnostic script, not meant to be maintained) has the full data.
 */
const MULTI_PAGE_DECORATION_THRESHOLD = 5;

/**
 * Share of the page area above which an image is a content candidate —
 * value taken directly from MDD §Phase 3 ("an image covering > 40% of the
 * page is a content candidate"). To be verified during calibration.
 */
const LARGE_AREA_CONTENT_THRESHOLD = 0.4;

/**
 * Tolerance margin (in bbox/MediaBox units, usually pt) when checking
 * whether a bbox "extends" past the MediaBox — small, unavoidable CTM
 * rounding shouldn't falsely mark an image as print bleed. Small compared
 * to typical print bleed (usually >=9pt/3mm).
 */
const BLEED_TOLERANCE_PT = 1;

/**
 * [Step 8 Z2] Length of the bbox's longer edge (in page pt, NOT source
 * pixels — this is already available at the inventory stage, without
 * decoding, unlike `MIN_ABSOLUTE_PX` in `finalize.ts`) above which we
 * consider an image "objectively large", regardless of its percentage share
 * of the page. Distinguishes a full-page illustration (typically 400-700pt
 * on the longer edge for Letter/A4 pages) from a small icon that happened to
 * land on a small page. Value to be calibrated against `samples/` — a
 * starting point, clearly below a typical illustration, so as not to reject
 * real content.
 */
const LARGE_ABSOLUTE_SIZE_PT = 300;

/**
 * [Step 8 Z2, discovery] A manual review in step 7 identified genuine
 * content (in-world ads/illustrations from CP-RED) classified `undecided`
 * with reason `Z1-no-strong-signal` — NOT `geometry` (empirically verified:
 * searching ALL 9 files in `samples/` found NOT A SINGLE `undecided` entry
 * with `maskEvidence==='geometry'` — the Step 8 brief's diagnosis of "weak
 * geometry evidence" as the cause does not hold up against this data). The
 * real cause: `maxRelativeArea` below `LARGE_AREA_CONTENT_THRESHOLD` (0.4)
 * combined with a COMPLETE ABSENCE of any evidence (not just weak evidence)
 * either way. Absence of evidence ≠ evidence against — an image with a
 * moderate (not huge) area and zero masking evidence is STILL a stronger
 * content signal than no information at all. The threshold is calibrated
 * directly on two cases identified in step 7 (`img_p64_1`: 25.7% of the
 * page, `img_p9_3`: 11.6% of the page — both genuine content) AND on two
 * cases that DELIBERATELY remain `undecided` (`img_p18_1`/`img_p26_1`: 2.6%
 * of the page, genuinely small on the page despite rendering at a large
 * target resolution — small decorative/portrait elements shouldn't
 * automatically become `content` just because they ARE masked/clustered).
 */
const MEDIUM_AREA_NO_EVIDENCE_THRESHOLD = 0.1;

/**
 * [Step 17, a live-reported bug; Step 43 Z1, fix after a constants audit —
 * A10 "silent loss"] The ratio of the bbox's longer to shorter edge above
 * which an image is SUSPECTED of being a narrow section-divider strip (a
 * line with a graphic motif under a heading/border) — observed directly on
 * `CHA23131 Call of Cthulhu 7th Edition Quick-Start Rules.pdf`, p. 7: three
 * variants of the same tentacle motif (962x84px ~11.5:1, 962x86px ~11.3:1,
 * 478x79px ~6.1:1).
 *
 * [Step 43, Z2 audit of the report] THIS CONSTANT ON ITS OWN was never
 * calibrated directly against negative cases (a panoramic map 3000x500, a
 * vertical full-column illustration — both typical in RPG rulebooks, both
 * would have aspect ratios ABOVE the threshold=6). When this SOLE signal
 * (`Z13`, below) decided `decoration` outright, a threshold error was
 * IRREVERSIBLE: the image was discarded BYPASSING the review screen
 * (violating A5 — a human never saw it — and A10, which already fixed this
 * exact same pattern for `MULTI_PAGE_DECORATION_THRESHOLD` in steps 14-15,
 * but wasn't applied here). The fix does NOT require calibrating the
 * constant itself — it removes the CONSEQUENCES of a threshold error: `Z13`
 * (a single occurrence, THIS signal ALONE) now lands in `undecided`
 * (visible in the review screen, with a `Diagnostic`
 * `IMAGE_EXTREME_ASPECT_RATIO_UNDECIDED` in `buildImageExtraction.ts`),
 * instead of `decoration`. `Z14` (below, `correlatedPages>=5` TOGETHER with
 * the aspect ratio) remains HARD `decoration` — TWO independent signals
 * converging together (repetition across multiple pages + aspect ratio) is
 * a different, stronger case than ONE signal alone, the same pattern as
 * `Z1-multi-page-correlated` (repetition + print bleed) right next to it —
 * genuine content almost never has BOTH these traits at once, so the
 * "Archiwa Imperium" regression (decorative strips repeated across 6-23
 * pages) still gets filtered out as `decoration` PRECISELY via `Z14`,
 * despite the `Z13` change.
 */
export const EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD = 6;

/**
 * [Step 9 Z2] Share of an image's bbox covered by FLOWING NARRATIVE TEXT
 * from the text flow (`semantic/blockBuilder.ts`) above which the image is
 * background/decoration, not content — a signal ORTHOGONAL to pixel
 * statistics (Step 8 left `img_p14_5` unresolved, a textured parchment
 * background indistinguishable via luminance stddev/chroma/gradient). A
 * genuine illustration has at most a caption underneath it (a narrow strip),
 * a background has WHOLE paragraphs on top of it.
 *
 * [discovery, calibration against `samples/`] The brief speaks explicitly of
 * `body` blocks, but `img_p14_5` (the target case) has text on it classified
 * as `caption`, not `body` — this is the same flavor-text paragraph in a
 * decorative font that rule Z9-caption-near-image (Z1a, same step) correctly
 * caught as `caption` (near the image), NOT as a bug. Genuine
 * body-text-on-image and caption-text-on-image are STRUCTURALLY the same
 * signal ("there is real flowing text here, not just a caption under the
 * image") — which is why the caller passes bboxes of `body` AND `caption`
 * blocks together (see `extractImagesFromDocument.ts`), not just `body`.
 * `sidebar`/`heading`/`table`/`marginalia` are deliberately EXCLUDED: they're
 * either too short to ever produce high coverage, or (sidebar) legitimately
 * occur INSIDE frames alongside genuine illustrations without marking them
 * as background.
 *
 * [discovery, manual visual review] A genuine illustration (an orc portrait,
 * `Wrath_&_Glory` p. 16) in a "text flows around the illustration in the
 * same column" layout produced EXACTLY as high a bbox coverage (~77%) as an
 * actual background (`img_p10_1`, ~72%) — the bbox alone does NOT
 * distinguish "text OVER the image" from "text IN THE SAME column as an
 * image with a generous/transparent bbox margin" without decoding pixels
 * (outside this file's architecture — zero decode, see the header). Guard:
 * the signal does NOT apply to images with a LARGE absolute size
 * (`hasLargeAbsoluteOccurrence`, the same threshold as
 * `Z2-strong-content-overrides-weak-geometry-evidence` above) — genuine
 * portrait illustrations tend to be large, and textured card backgrounds can
 * also be large, but since they can't be safely told apart, priority goes to
 * NOT degrading genuine content (MDD A5 — a human reviews it anyway in phase
 * 9). Cost: a handful of actual backgrounds >=300pt (e.g. `img_p10_1`)
 * remain `content` — the SAME (not a new) gap as Step 8, not a regression.
 */
const TEXT_COVERAGE_DECORATION_THRESHOLD = 0.15;

/**
 * Groups entries by CANONICAL objId (its own objId, unless `correlatedWith`
 * points to another — see `correlateImagesByBBox` in step 5/6) and returns,
 * for each entry, the NUMBER OF UNIQUE PAGES across the whole correlation
 * group — this is the right signal for classifying "a multi-page decoration"
 * (U1), not plain `entry.pageRefs.length`, which after objId splitting only
 * sees a fragment.
 */
function computeCorrelatedPageCounts(entries: readonly ImageEntry[]): Map<ImageEntry, number> {
  const canonicalKey = (e: ImageEntry): string => e.correlatedWith ?? e.objId ?? '';
  const pagesByCanonical = new Map<string, Set<number>>();
  for (const e of entries) {
    if (e.objId === null) continue; // inline entries have no objId to correlate on — handled separately, see below
    const key = canonicalKey(e);
    const pages = pagesByCanonical.get(key) ?? new Set<number>();
    for (const p of e.pageRefs) pages.add(p);
    pagesByCanonical.set(key, pages);
  }
  const result = new Map<ImageEntry, number>();
  for (const e of entries) {
    if (e.objId === null) {
      result.set(e, e.pageRefs.length);
      continue;
    }
    result.set(e, pagesByCanonical.get(canonicalKey(e))?.size ?? e.pageRefs.length);
  }
  return result;
}

/** Whether ANY occurrence extends past its page's MediaBox — a print-bleed/background signal (F0). */
function hasBleedingOccurrence(entry: ImageEntry, pageBoxByPage: ReadonlyMap<number, Rect>): boolean {
  return entry.occurrences.some((occ) => {
    const pageBox = pageBoxByPage.get(occ.page);
    if (!pageBox) return false;
    return (
      occ.bbox.minX < pageBox.minX - BLEED_TOLERANCE_PT ||
      occ.bbox.minY < pageBox.minY - BLEED_TOLERANCE_PT ||
      occ.bbox.maxX > pageBox.maxX + BLEED_TOLERANCE_PT ||
      occ.bbox.maxY > pageBox.maxY + BLEED_TOLERANCE_PT
    );
  });
}

/** Whether ANY occurrence has a bbox longer edge >= the threshold — see `LARGE_ABSOLUTE_SIZE_PT`. */
function hasLargeAbsoluteOccurrence(entry: ImageEntry): boolean {
  return entry.occurrences.some((occ) => Math.max(occ.bbox.maxX - occ.bbox.minX, occ.bbox.maxY - occ.bbox.minY) >= LARGE_ABSOLUTE_SIZE_PT);
}

/** Whether ANY occurrence has a bbox aspect ratio >= the threshold — see `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`. */
function hasExtremeAspectRatioOccurrence(entry: ImageEntry): boolean {
  return entry.occurrences.some((occ) => {
    const w = occ.bbox.maxX - occ.bbox.minX;
    const h = occ.bbox.maxY - occ.bbox.minY;
    if (w <= 0 || h <= 0) return false;
    return Math.max(w, h) / Math.min(w, h) >= EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD;
  });
}

/**
 * [Step 9 Z2] Share of the `bbox` area covered by the sum (without
 * subtracting overlap BETWEEN blocks — `body` blocks on the same page
 * practically never overlap, so this is a safe approximation, not a true
 * geometric union) of intersections with `body` blocks on THE SAME page.
 * Zero blocks on the page = 0.
 */
function computeTextCoverageRatio(bbox: Rect, page: number, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  const boxes = bodyBoxesByPage.get(page);
  if (!boxes || boxes.length === 0) return 0;
  const area = Math.max(0, bbox.maxX - bbox.minX) * Math.max(0, bbox.maxY - bbox.minY);
  if (area <= 0) return 0;
  let covered = 0;
  for (const b of boxes) {
    const ix = Math.max(0, Math.min(bbox.maxX, b.maxX) - Math.max(bbox.minX, b.minX));
    const iy = Math.max(0, Math.min(bbox.maxY, b.maxY) - Math.max(bbox.minY, b.minY));
    covered += ix * iy;
  }
  return Math.min(1, covered / area);
}

/** Maximum text coverage ACROSS ALL occurrences — the same "any occurrence" pattern as `hasBleedingOccurrence`/`hasLargeAbsoluteOccurrence`. */
function maxTextCoverageRatio(entry: ImageEntry, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  let max = 0;
  for (const occ of entry.occurrences) {
    const ratio = computeTextCoverageRatio(occ.bbox, occ.page, bodyBoxesByPage);
    if (ratio > max) max = ratio;
  }
  return max;
}

/**
 * [Step 14 H1] Shrinks the bbox to the central ~50% of its area (linear
 * scale 1/sqrt(2) around the center) — see `maxCenterTextCoverageRatio`.
 */
function shrinkToCenter(bbox: Rect): Rect {
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const shrink = (1 - Math.SQRT1_2) / 2;
  return {
    minX: bbox.minX + w * shrink,
    maxX: bbox.maxX - w * shrink,
    minY: bbox.minY + h * shrink,
    maxY: bbox.maxY - h * shrink,
  };
}

/**
 * [Step 14 H1] Text coverage of `body`/`caption` computed EXCLUSIVELY for
 * the central ~50% of the bbox area, not the whole bbox like
 * `maxTextCoverageRatio`. Resolves the gap discovered in Step 9 (see the
 * comment on `TEXT_COVERAGE_DECORATION_THRESHOLD`): a genuine background
 * with a paragraph IN THE CENTER and a genuine illustration flowed around by
 * text AT THE EDGE produce NEARLY IDENTICAL coverage of the WHOLE bbox
 * (~72-77% in both cases, measured manually in Step 9) — these two cases are
 * distinguished by SPATIAL DISTRIBUTION, not amount: a background has text
 * IN THE MIDDLE, an illustration has a CLEAN center.
 *
 * Measured against a reference set (600 manually labeled images from 3
 * rulebooks, not in this repo): raised `content` classification precision
 * from 36% to 95% on that sample.
 */
function maxCenterTextCoverageRatio(entry: ImageEntry, bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]>): number {
  let max = 0;
  for (const occ of entry.occurrences) {
    const ratio = computeTextCoverageRatio(shrinkToCenter(occ.bbox), occ.page, bodyBoxesByPage);
    if (ratio > max) max = ratio;
  }
  return max;
}

/**
 * Classifies all image registry entries. `'undecided'` is ALLOWED and
 * DESIRED for conflicting signals (per the brief) — the review screen
 * (phase 9) shows these to the user unchecked by default, instead of
 * guessing on their behalf.
 */
export function classifyImages(
  entries: readonly ImageEntry[],
  pageBoxByPage: ReadonlyMap<number, Rect>,
  // [Step 9 Z2] Bboxes of flowing-text blocks (`body`+`caption`, see the
  // comment on `TEXT_COVERAGE_DECORATION_THRESHOLD`) grouped by page number
  // — an EXPLICIT connection (a parameter), not global state, per the Step 9
  // brief. Defaults to an empty map: callers with no text flow (e.g.
  // existing unit tests) get exactly the pre-Z2 behavior.
  bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]> = new Map(),
  // [at the user's request, a book with a bespoke background on every page]
  // See the comment on `treatFullBleedAsContent` in `schema.ts`. Defaults to
  // `{}` (off) — behavior identical to before this flag was added.
  options: { treatFullBleedAsContent?: boolean } = {},
): ClassifiedImage[] {
  const treatFullBleedAsContent = options.treatFullBleedAsContent ?? false;
  const correlatedPageCounts = computeCorrelatedPageCounts(entries);

  return entries.map((entry): ClassifiedImage => {
    // 1. Hard mask evidence — decision final, regardless of anything else.
    if (entry.maskEvidence === 'group' || entry.maskEvidence === 'opcode') {
      return { entry, classification: 'mask', reason: `Z1-mask-evidence-${entry.maskEvidence}`, confidence: confidenceForReason(`Z1-mask-evidence-${entry.maskEvidence}`) };
    }

    // [Step 15 Z3, A10] Computed EARLY, because it's now used by TWO
    // independent rules below (multi-page correlation AND print bleed), not
    // just by the later H1 signal (Z10). The same pattern as
    // `maxCenterTextCoverageRatio` from step 14 — see its own comment.
    const centerTextCoverage = maxCenterTextCoverageRatio(entry, bodyBoxesByPage);

    // 2. Page count AFTER correlation (U1) — a multi-page resource is a
    // CANDIDATE for decoration, but no longer a hard decision. [Step 15 Z3,
    // discovery on the step-14 reference set] Threshold=2 falsely classified
    // 22/133 `useful` (a region map referenced across several chapters, a
    // repeated faction symbol) — the real distribution showed that raising
    // it to 5 would lower this to 12/133, losing only 2/21 correctly caught
    // `decoration` (from 21 to 19). Per A10: above the threshold this is NO
    // LONGER `decoration` outright, just `undecided`, UNLESS accompanied by
    // a SECOND, independent signal — print bleed (`hasBleedingOccurrence`).
    // A genuine map/symbol referenced repeatedly almost NEVER extends past
    // the MediaBox (a deliberately placed illustration, not page background)
    // — two agreeing signals together give the same confidence as the
    // former hard rule.
    const correlatedPages = correlatedPageCounts.get(entry) ?? entry.pageRefs.length;
    if (correlatedPages >= MULTI_PAGE_DECORATION_THRESHOLD) {
      if (hasBleedingOccurrence(entry, pageBoxByPage)) {
        return { entry, classification: 'decoration', reason: 'Z1-multi-page-correlated', confidence: confidenceForReason('Z1-multi-page-correlated') };
      }
      // [user report, "Archiwa Imperium", narrow divider strips repeated
      // across 6-23 pages] A SECOND independent signal equivalent to print
      // bleed above — bbox aspect ratio (`Z13-extreme-aspect-ratio-divider`
      // further down in this function uses the SAME
      // `hasExtremeAspectRatioOccurrence`, but is only checked AFTER this
      // block, so it never got a chance for entries that landed here first).
      // Measured directly: a decorative divider strip used throughout the
      // book (each use is <1% of the page area, WITH NO print bleed — it
      // sits IN THE MIDDLE of the page, not at its edge) landed in
      // `undecided` on EVERY ONE of 6-23 occurrences, despite an extremely
      // elongated aspect ratio (>16:1) — a signal just as unambiguous as
      // bleed, just never checked at this point. Genuine, repeated CONTENT
      // (e.g. a region map, a faction symbol from Step 15 Z3) almost never
      // has such an aspect ratio, so this is a safe extension — it doesn't
      // narrow the completeness of `content`/`undecided` for real content,
      // it only closes the gap for this one, narrow shape.
      if (hasExtremeAspectRatioOccurrence(entry)) {
        return { entry, classification: 'decoration', reason: 'Z14-repeated-extreme-aspect-ratio', confidence: confidenceForReason('Z14-repeated-extreme-aspect-ratio') };
      }
      return { entry, classification: 'undecided', reason: 'Z11-repeated-no-bleed-evidence', confidence: confidenceForReason('Z11-repeated-no-bleed-evidence') };
    }

    // 6. Full-bleed position — checked early (a hard geometric signal,
    // independent of the uncertainty of signals 3-5), before any "large
    // bbox" gets mistakenly counted as content. [Step 15 Z3, A10] Also NO
    // LONGER hard — step 14 found that 25/49 lost `useful` items in the
    // reference sample were lost PRECISELY here (a full-page map/spread
    // illustration legitimately extends past the bleed just like a textured
    // background). Second, independent signal: text coverage AT THE CENTER
    // (the same `centerTextCoverage` as Z10 below) — a genuine background
    // has a paragraph on it, a deliberate full-bleed illustration usually
    // doesn't.
    if (hasBleedingOccurrence(entry, pageBoxByPage)) {
      if (centerTextCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD) {
        // [at the user's request] `treatFullBleedAsContent` bypasses the
        // assumption "full bleed + text on top = repeating background"
        // right here — see the comment on the flag in `schema.ts`.
        // Publications with a bespoke illustration under every page land
        // PRECISELY in this branch.
        if (treatFullBleedAsContent) {
          return { entry, classification: 'content', reason: 'Z1-full-bleed-forced-content', confidence: confidenceForReason('Z1-full-bleed-background') };
        }
        return { entry, classification: 'decoration', reason: 'Z1-full-bleed-background', confidence: confidenceForReason('Z1-full-bleed-background') };
      }
      return { entry, classification: 'undecided', reason: 'Z12-bleeding-no-center-text-evidence', confidence: confidenceForReason('Z12-bleeding-no-center-text-evidence') };
    }

    // 3. Large page area — a content candidate.
    const isLargeArea = entry.maxRelativeArea >= LARGE_AREA_CONTENT_THRESHOLD;

    // 5. maskEvidence==='geometry' — weak evidence, NEVER decisive on its own.
    //
    // [Step 8 Z2, discovery] A manual review in step 7 (RAPORT-KROK-7.md)
    // revealed full-page illustrations classified `undecided` despite being
    // "genuinely good content" — weak `geometry` evidence (often fictitious:
    // an image drawn right BEFORE/AFTER another with a similar bbox, with no
    // actual masking) overrode strong, mutually consistent content signals.
    // The overriding rule: a conjunction of a LARGE relative area, a SINGLE
    // occurrence after correlation (already guaranteed — otherwise we'd have
    // returned 'decoration' above), and a large ABSOLUTE size beats weak
    // geometric evidence -> `content`. `group`/`opcode` (hard evidence,
    // checked at the very top of the function) are NEVER subject to this rule.
    if (entry.maskEvidence === 'geometry') {
      if (isLargeArea && hasLargeAbsoluteOccurrence(entry)) {
        return { entry, classification: 'content', reason: 'Z2-strong-content-overrides-weak-geometry-evidence', confidence: confidenceForReason('Z2-strong-content-overrides-weak-geometry-evidence') };
      }
      if (isLargeArea) {
        return { entry, classification: 'undecided', reason: 'Z1-conflicting-geometry-mask-vs-large-area', confidence: confidenceForReason('Z1-conflicting-geometry-mask-vs-large-area') };
      }
      return { entry, classification: 'undecided', reason: 'Z1-weak-geometry-mask-evidence', confidence: confidenceForReason('Z1-weak-geometry-mask-evidence') };
    }

    // [Step 9 Z2] `body` text coverage — checked AFTER the nuanced handling
    // of `geometry` above (doesn't change it), but BEFORE the "large area ->
    // content" rules: a textured background with paragraphs on it often ALSO
    // has a large relative area, and that's EXACTLY the case this signal is
    // meant to catch (see the comment on `TEXT_COVERAGE_DECORATION_THRESHOLD`).
    const textCoverage = maxTextCoverageRatio(entry, bodyBoxesByPage);
    if (textCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD && !hasLargeAbsoluteOccurrence(entry)) {
      return { entry, classification: 'decoration', reason: 'Z9-high-body-text-coverage', confidence: confidenceForReason('Z9-high-body-text-coverage') };
    }

    // [Step 14 H1] The Z9 signal above has been DISABLED for large images
    // (`hasLargeAbsoluteOccurrence`) since step 9, precisely for the reason
    // described at `maxCenterTextCoverageRatio`. It comes back here — but
    // computed on the CENTER, not the whole bbox, so it doesn't suffer from
    // the same problem, and lands in `undecided` (NOT `decoration`):
    // measured on the same reference set that landing directly in
    // `decoration` reduced "reachable" completeness (content+undecided,
    // i.e. anything visible on the review screen) from 63% to 45% — some
    // genuinely useful images became COMPLETELY invisible instead of needing
    // a single click in `undecided`. [Step 15 Z3] `centerTextCoverage`
    // already computed above — Z1-multi-page-correlated and
    // Z1-full-bleed-background now use it too.
    if (centerTextCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD) {
      return { entry, classification: 'undecided', reason: 'Z10-high-center-text-coverage', confidence: confidenceForReason('Z10-high-center-text-coverage') };
    }

    if (isLargeArea) {
      return { entry, classification: 'content', reason: 'Z1-large-relative-area', confidence: confidenceForReason('Z1-large-relative-area') };
    }

    // [Step 8 Z2] Zero masking evidence (not just weak) + moderate area —
    // see the comment on `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD`.
    if (entry.maskEvidence === null && entry.maxRelativeArea >= MEDIUM_AREA_NO_EVIDENCE_THRESHOLD) {
      return { entry, classification: 'content', reason: 'Z2-moderate-area-no-mask-evidence', confidence: confidenceForReason('Z2-moderate-area-no-mask-evidence') };
    }

    // [Step 17, fixed in Step 43 Z1 — see the comment on
    // `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`] A narrow divider strip —
    // ONE signal (aspect ratio) ALONE no longer decides `decoration`
    // outright (A5/A10: the image must go through the review screen, where
    // the user sees it and decides) — it lands in `undecided`, with a
    // `Diagnostic` added in `buildImageExtraction.ts`. Checked AFTER all the
    // "large area -> content" rules (doesn't override them), but BEFORE the
    // final `undecided`/`Z1-no-strong-signal` — otherwise this case would
    // get the lowest possible confidence, even though the aspect ratio IS a
    // real (just unconfirmed) signal.
    if (!isLargeArea && hasExtremeAspectRatioOccurrence(entry)) {
      return { entry, classification: 'undecided', reason: 'Z13-extreme-aspect-ratio-undecided', confidence: confidenceForReason('Z13-extreme-aspect-ratio-undecided') };
    }

    // No strong signal in either direction — don't guess.
    return { entry, classification: 'undecided', reason: 'Z1-no-strong-signal', confidence: confidenceForReason('Z1-no-strong-signal') };
  });
}
