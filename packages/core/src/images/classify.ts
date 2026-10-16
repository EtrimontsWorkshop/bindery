import type { Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import { computeMaskedObjIds } from './strategy.js';

/**
 * Content/decoration/mask classification. Input: `ImageEntry[]` from the inventory pass (zero
 * decode). Operates EXCLUSIVELY on facts already gathered — does not decode here (the second
 * pass is a separate step).
 *
 * Signals in order of strength, with ONE documented exception: "absolute size" needs
 * intrinsicWidth/Height, which pdf.js only reveals when resolving the object
 * (`page.objs.get()`/`commonObjs.get()`) — the operator list (inventory pass) doesn't carry this
 * information, only the bbox in device space (after the CTM). Rejection by absolute size is
 * therefore applied AFTER decode, in `finalize.ts` — documented explicitly there, not silently
 * skipped.
 */

export type ImageClassification = 'content' | 'decoration' | 'mask' | 'undecided';

export interface ClassifiedImage {
  entry: ImageEntry;
  classification: ImageClassification;
  /** Which rule decided — debuggability, the same pattern as `matchedRuleId` in the semantic block builder. */
  reason: string;
  /**
   * Decision confidence (0-1), DERIVED from the strength of the
   * signal for the rule that decided (`reason`) — NOT a new, independent
   * model. The review screen (`packages/module`) uses it for the
   * default checkbox state: `content` with `confidence < 0.6` (the only such
   * case: `Z2-moderate-area-no-mask-evidence`, see the comment on that rule
   * — "moderate area + zero evidence" is the WEAKEST of the positive
   * signals) starts unchecked despite being classified `content`, same as
   * `undecided`. Values calibrated directly against the signal-strength
   * hierarchy already documented in this file's header ("Signals in order
   * of strength") — NOT a separate, new model.
   */
  confidence: number;
}

/**
 * Mapping from `reason` (a rule identifier from
 * `classifyImages`) to confidence (0-1) — see the comment on
 * `ClassifiedImage.confidence`. Hard evidence (group/opcode mask, print
 * bleed) = high confidence; `undecided` is by definition below 0.5
 * (conflicting or zero evidence); `Z2-moderate-area-no-mask-evidence` is the
 * only `content` case BELOW the 0.6 default-selection threshold — deliberately, it's
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
  // "Soft" versions of two former hard rules — ONE signal
  // (repetition or print bleed) without the other, independent
  // confirmation. Same confidence level as other single, conflicting
  // signals (`Z1-conflicting-geometry-mask-vs-large-area`).
  'Z11-repeated-no-bleed-evidence': 0.4,
  'Z12-bleeding-no-center-text-evidence': 0.4,
  'Z12-bleeding-masked-cutout': 0.7,
  'Z21-masked-silhouette-at-page-edge': 0.4,
  'Z12-bleeding-translucent-overlay': 0.8,
  'Z12-bleeding-translucent-panel': 0.2,
  'Z15-small-masked-raster': 0.7,
  'Z16-tiny-undecided': 0.7,
  'Z17-covered-by-later-picture': 0.8,
  'Z18-form-page-element': 0.7,
  'Z18-form-page-background': 0.7,
  'Z19-translucent-copy-of-picture': 0.8,
  'Z20-small-translucent-masked-raster': 0.8,
  'Z22-page-background-under-content': 0.8,
  'Z23-masked-strip': 0.8,
  'Z24-small-bleeding-strip': 0.7,
  'Z25-translucent-masked-strip': 0.8,
  'Z1-conflicting-geometry-mask-vs-large-area': 0.4,
  'Z1-weak-geometry-mask-evidence': 0.3,
  'Z1-no-strong-signal': 0.2,
  // A single aspect-ratio signal ON ITS
  // OWN — no longer hard `decoration` (see the comment on
  // `EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD`), just `undecided`. Same
  // confidence as other single, not-confirmed-by-a-second-signal `undecided`
  // cases below (`Z12`/`Z1-conflicting`) — not `Z1-no-strong-signal` (0.2),
  // because the aspect ratio IS a real, just unconfirmed, signal.
  'Z13-extreme-aspect-ratio-undecided': 0.4,
  // Two INDEPENDENT signals together
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
 * A resource present on >= this many CORRELATED pages (see `correlatedPageCount`) is a CANDIDATE
 * for decoration (see the call site — no longer a hard decision on its own). A decoration may
 * repeat on 40 pages, but without correlation the first occurrence of such a resource looks like
 * unique content.
 *
 * The starting value (2) was measured directly: `useful` with correlatedPages>=2: 22/133
 * (falsely caught — a region map referenced across several chapters, a repeated faction symbol).
 * `decoration` with correlatedPages>=2: 21/200 (correctly caught). Raising to >=5 gives 12/133
 * false positives (-45%) at the cost of only 19/200 true positives (-10%) — a clearly better
 * trade-off. Beyond 5 further gains are negligible (>=10 gives the same 12/133). The numbers come
 * from a one-off diagnostic script that is not maintained.
 */
const MULTI_PAGE_DECORATION_THRESHOLD = 5;

/**
 * Share of the page area above which an image is a content candidate (an image covering > 40%
 * of the page). To be verified during calibration.
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
 * Length of the bbox's longer edge (in page pt, NOT source
 * pixels — this is already available at the inventory stage, without
 * decoding, unlike `MIN_ABSOLUTE_PX` in `finalize.ts`) above which we
 * consider an image "objectively large", regardless of its percentage share
 * of the page. Distinguishes a full-page illustration (typically 400-700pt
 * on the longer edge for Letter/A4 pages) from a small icon that happened to
 * land on a small page. Value to be calibrated against real documents — a
 * starting point, clearly below a typical illustration, so as not to reject
 * real content.
 */
const LARGE_ABSOLUTE_SIZE_PT = 300;

/**
 * A manual review identified genuine
 * content (in-world ads/illustrations from a real rulebook) classified `undecided`
 * with reason `Z1-no-strong-signal` — NOT `geometry`. The
 * real cause: `maxRelativeArea` below `LARGE_AREA_CONTENT_THRESHOLD` (0.4)
 * combined with a COMPLETE ABSENCE of any evidence (not just weak evidence)
 * either way. Absence of evidence ≠ evidence against — an image with a
 * moderate (not huge) area and zero masking evidence is STILL a stronger
 * content signal than no information at all. The threshold is calibrated
 * directly on two cases identified in that review (`img_p64_1`: 25.7% of the
 * page, `img_p9_3`: 11.6% of the page — both genuine content) AND on two
 * cases that DELIBERATELY remain `undecided` (`img_p18_1`/`img_p26_1`: 2.6%
 * of the page, genuinely small on the page despite rendering at a large
 * target resolution — small decorative/portrait elements shouldn't
 * automatically become `content` just because they ARE masked/clustered).
 * Set at 9% rather than 10% after a set of ready characters: the portraits of its four cards are the same photo format
 * placed at 9.99%-10.01% of the page, and a limit inside that spread made one of them `content` and the rest `undecided`.
 */
const MEDIUM_AREA_NO_EVIDENCE_THRESHOLD = 0.09;

/**
 * The ratio of the bbox's longer to shorter edge above which an image is SUSPECTED of being a
 * narrow section-divider strip (a line with a graphic motif under a heading/border) — observed
 * directly in a real quick-start PDF, p. 7: three variants of the same tentacle motif (962x84px
 * ~11.5:1, 962x86px ~11.3:1, 478x79px ~6.1:1).
 *
 * THIS CONSTANT ON ITS OWN was never calibrated directly against negative cases (a panoramic map
 * 3000x500, a vertical full-column illustration — both typical in RPG rulebooks, both would have
 * aspect ratios ABOVE the threshold=6). When this SOLE signal (`Z13`, below) decided
 * `decoration` outright, a threshold error was IRREVERSIBLE: the image was discarded BYPASSING
 * the review screen (a human never saw it — the same pattern already fixed for
 * `MULTI_PAGE_DECORATION_THRESHOLD`, but not applied here). The fix does NOT require calibrating
 * the constant itself — it removes the CONSEQUENCES of a threshold error: `Z13` (a single
 * occurrence, THIS signal ALONE) now lands in `undecided` (visible in the review screen, with a
 * `Diagnostic` `IMAGE_EXTREME_ASPECT_RATIO_UNDECIDED` in `buildImageExtraction.ts`), instead of
 * `decoration`. `Z14` (below, `correlatedPages>=5` TOGETHER with the aspect ratio) remains HARD
 * `decoration` — TWO independent signals converging together (repetition across multiple pages +
 * aspect ratio) is a different, stronger case than ONE signal alone, the same pattern as
 * `Z1-multi-page-correlated` (repetition + print bleed) right next to it — genuine content almost
 * never has BOTH these traits at once, so the regression with decorative strips repeated across
 * 6-23 pages still gets filtered out as `decoration` PRECISELY via `Z14`, despite the `Z13`
 * change.
 */
export const EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD = 6;

/**
 * Share of an image's bbox covered by FLOWING NARRATIVE TEXT from the text flow
 * (`semantic/blockBuilder.ts`) above which the image is background/decoration, not content — a
 * signal ORTHOGONAL to pixel statistics. A genuine illustration has at most a caption underneath
 * it (a narrow strip), a background has WHOLE paragraphs on top of it.
 *
 * [discovery, calibration on real documents] The text flow speaks of `body` blocks, but in the
 * target case the text on the image is classified as `caption`, not `body` — it is the same
 * flavor-text paragraph in a decorative font that rule Z9-caption-near-image correctly caught as
 * `caption` (near the image), NOT a bug. Genuine body-text-on-image and caption-text-on-image are
 * STRUCTURALLY the same signal ("there is real flowing text here, not just a caption under the
 * image") — which is why the caller passes bboxes of `body` AND `caption` blocks together (see
 * `extractImagesFromDocument.ts`), not just `body`. `sidebar`/`heading`/`table`/`marginalia` are
 * deliberately EXCLUDED: they're either too short to ever produce high coverage, or (sidebar)
 * legitimately occur INSIDE frames alongside genuine illustrations without marking them as
 * background.
 *
 * [discovery, manual visual review] A genuine illustration (an orc portrait in a real rulebook)
 * in a "text flows around the illustration in the same column" layout produced EXACTLY as high a
 * bbox coverage (~77%) as an actual background (~72%) — the bbox alone does NOT distinguish
 * "text OVER the image" from "text IN THE SAME column as an image with a generous/transparent
 * bbox margin" without decoding pixels (outside this file's architecture — zero decode, see the
 * header). Guard: the signal does NOT apply to images with a LARGE absolute size
 * (`hasLargeAbsoluteOccurrence`, the same threshold as
 * `Z2-strong-content-overrides-weak-geometry-evidence` above) — genuine portrait illustrations
 * tend to be large, and textured card backgrounds can also be large, but since they can't be
 * safely told apart, priority goes to NOT degrading genuine content (a human reviews it anyway on
 * the review screen). Cost: a handful of actual backgrounds >=300pt remain `content` — an
 * existing gap, not a regression.
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

/** How far (pt) the entry's occurrences reach past their page's MediaBox, at most; 0 when none does. */
export function maxBleedOverhangPt(entry: ImageEntry, pageBoxByPage: ReadonlyMap<number, Rect>): number {
  let max = 0;
  for (const occ of entry.occurrences) {
    const box = pageBoxByPage.get(occ.page);
    if (!box) continue;
    max = Math.max(max, box.minX - occ.bbox.minX, box.minY - occ.bbox.minY, occ.bbox.maxX - box.maxX, occ.bbox.maxY - box.maxY);
  }
  return max;
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
 * Share of the `bbox` area covered by the sum (without
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
 * Shrinks the bbox to the central ~50% of its area (linear
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
 * Text coverage of `body`/`caption` computed EXCLUSIVELY for
 * the central ~50% of the bbox area, not the whole bbox like
 * `maxTextCoverageRatio`. Resolves a gap in the whole-bbox signal (see the
 * comment on `TEXT_COVERAGE_DECORATION_THRESHOLD`): a genuine background
 * with a paragraph IN THE CENTER and a genuine illustration flowed around by
 * text AT THE EDGE produce NEARLY IDENTICAL coverage of the WHOLE bbox — these two cases are
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
 * Opacity at or below which an image that is translucent everywhere it is painted counts as a watermark or an
 * overlay. Measured on three real rulebooks: watermarks and overlays at 0.08-0.6, illustrations at 0.85-1.
 * The limit sits a little above 0.6 because PDF stores 0.6 as a 32-bit float, which reads back as 0.600006.
 */
const TRANSLUCENT_OVERLAY_MAX_OPACITY = 0.65;

/**
 * Whether the image is painted translucent everywhere it appears (see `TRANSLUCENT_OVERLAY_MAX_OPACITY`): a watermark or
 * a texture laid over the paper, not an illustration. Measured on two real rulebooks: watermarks sit at 8%-50% opacity,
 * the pictures printed opaque at 85%-100%.
 */
export function isTranslucentEverywhere(entry: ImageEntry): boolean {
  return entry.maxOpacity !== undefined && entry.maxOpacity <= TRANSLUCENT_OVERLAY_MAX_OPACITY;
}

/**
 * Page-area share from which a bleeding translucent image is a panel (a dark rectangle laid over the page's background, as wide
 * as a map) and not a watermark crest or a texture wash: measured on a real starter set, the map panels fill 71% of the page, the
 * crests and washes of the same book far less.
 */
const LARGE_TRANSLUCENT_PANEL_MIN_AREA = 0.3;
export const LARGE_TRANSLUCENT_PANEL_REASON = 'Z12-bleeding-translucent-panel';

/**
 * Opacity at or below which a translucent image is a faint backdrop (a colored panel or halftone layer behind a
 * figure) rather than a faded picture. Measured on three real rulebooks: the backdrops of one sit at 20%; the faded
 * pictures and watermarks worth offering sit at 30%-60%.
 */
const BACKDROP_SHAPE_MAX_OPACITY = 0.25;

/** Whether the image is a faint backdrop everywhere it is painted (see `BACKDROP_SHAPE_MAX_OPACITY`). */
export function isBackdropShape(entry: ImageEntry): boolean {
  return entry.maxOpacity !== undefined && entry.maxOpacity <= BACKDROP_SHAPE_MAX_OPACITY;
}

/**
 * Limits of the tape/paper-scrap rule (`Z15-small-masked-raster`). Measured on a real rulebook: all 46 tape
 * and scrap rasters are masked, 219-269 px on the long edge, 64-94 px on the short one (aspect 2.4-3.4)
 * and cover 0.5%-2.5% of the page; the nearest real content, an emblem, is 203x218 px (aspect 1.07) at 2.7%.
 */
const SMALL_MASKED_STRIP_MAX_LONG_EDGE_PX = 300;
const SMALL_MASKED_STRIP_MIN_ASPECT = 2;
const SMALL_MASKED_STRIP_MAX_AREA = 0.03;

/**
 * Limits of the translucent-halftone rule (`Z20-small-translucent-masked-raster`). Measured on a third rulebook: the
 * halftone layers of its colored shapes and chapter banners are masked rasters painted at 20% opacity, 65-135 x
 * 105-168 px and 3.0%-5.9% of the page (31 of them); the watermark crests of the other two books, which are offered
 * as clean originals, cover 7% of the page and more, and an emblem of the first book (203x218 px, 2.7%) is painted at 30%.
 */
const SMALL_TRANSLUCENT_MASKED_MAX_AREA = 0.06;
const SMALL_TRANSLUCENT_MASKED_MAX_LONG_EDGE_PX = 300;

function isSmallTranslucentMaskedRaster(entry: ImageEntry, maskedObjIds: ReadonlySet<string>): boolean {
  if (entry.objId === null || !maskedObjIds.has(entry.objId) || !isBackdropShape(entry)) return false;
  const w = entry.intrinsicWidth;
  const h = entry.intrinsicHeight;
  if (w === null || h === null || w <= 0 || h <= 0) return false;
  return Math.max(w, h) <= SMALL_TRANSLUCENT_MASKED_MAX_LONG_EDGE_PX && entry.maxRelativeArea < SMALL_TRANSLUCENT_MASKED_MAX_AREA;
}

function isSmallMaskedStrip(entry: ImageEntry, maskedObjIds: ReadonlySet<string>): boolean {
  if (entry.objId === null || !maskedObjIds.has(entry.objId)) return false;
  const w = entry.intrinsicWidth;
  const h = entry.intrinsicHeight;
  if (w === null || h === null || w <= 0 || h <= 0) return false;
  return Math.max(w, h) <= SMALL_MASKED_STRIP_MAX_LONG_EDGE_PX && Math.max(w, h) / Math.min(w, h) >= SMALL_MASKED_STRIP_MIN_ASPECT && entry.maxRelativeArea < SMALL_MASKED_STRIP_MAX_AREA;
}

/**
 * Limits of the strip rules. Measured on a real rulebook: the strips of adhesive tape that hold photos to the page are
 * masked rasters 521-537 x 69-72 px (aspect 7.3-7.8, the box of a tilted one is 9%-10% of the page), a "NOFORN"
 * stamp laid over a table is a masked raster at 30% opacity, 469x94 px (aspect 5.0, 3.1%), the slivers of document
 * sheets at the edge of a page are 160-396 px wide at aspect 3.7-5.4 and 4%-9% of the page; the pictures worth
 * importing of the three other books are never that narrow when they are masked, translucent or cut by the page edge.
 */
const MASKED_STRIP_MIN_ASPECT = 5;
const MASKED_STRIP_MAX_AREA = 0.15;
const TRANSLUCENT_STRIP_MAX_OPACITY = 0.5;
const TRANSLUCENT_STRIP_MIN_ASPECT = 3;
const TRANSLUCENT_STRIP_MAX_AREA = 0.06;
const BLEEDING_STRIP_MIN_ASPECT = 3;
const BLEEDING_STRIP_MAX_AREA = 0.1;

function intrinsicAspect(entry: ImageEntry): number | null {
  const w = entry.intrinsicWidth;
  const h = entry.intrinsicHeight;
  if (w === null || h === null || w <= 0 || h <= 0) return null;
  return Math.max(w, h) / Math.min(w, h);
}

function isMaskedStrip(entry: ImageEntry, maskedObjIds: ReadonlySet<string>): boolean {
  if (entry.objId === null || !maskedObjIds.has(entry.objId)) return false;
  const aspect = intrinsicAspect(entry);
  return aspect !== null && aspect >= MASKED_STRIP_MIN_ASPECT && entry.maxRelativeArea < MASKED_STRIP_MAX_AREA;
}

function isTranslucentMaskedStrip(entry: ImageEntry, maskedObjIds: ReadonlySet<string>): boolean {
  if (entry.objId === null || !maskedObjIds.has(entry.objId) || entry.maxOpacity === undefined || entry.maxOpacity > TRANSLUCENT_STRIP_MAX_OPACITY) return false;
  const aspect = intrinsicAspect(entry);
  return aspect !== null && aspect >= TRANSLUCENT_STRIP_MIN_ASPECT && entry.maxRelativeArea < TRANSLUCENT_STRIP_MAX_AREA;
}

function isSmallBleedingStrip(entry: ImageEntry): boolean {
  const aspect = intrinsicAspect(entry);
  return aspect !== null && aspect >= BLEEDING_STRIP_MIN_ASPECT && entry.maxRelativeArea < BLEEDING_STRIP_MAX_AREA;
}

/**
 * Classifies all image registry entries. `'undecided'` is ALLOWED and DESIRED for conflicting
 * signals — the review screen shows these to the user unchecked by default, instead of guessing
 * on their behalf.
 */
export function classifyImages(
  entries: readonly ImageEntry[],
  pageBoxByPage: ReadonlyMap<number, Rect>,
  // Bboxes of flowing-text blocks (`body`+`caption`, see the comment on
  // `TEXT_COVERAGE_DECORATION_THRESHOLD`) grouped by page number — an EXPLICIT connection (a
  // parameter), not global state. Defaults to an empty map: callers with no text flow (e.g.
  // existing unit tests) get the behavior without this signal.
  bodyBoxesByPage: ReadonlyMap<number, readonly Rect[]> = new Map(),
  // [at the user's request, a book with a bespoke background on every page]
  // Lets a full-bleed background image be treated as content instead of
  // decoration. Defaults to `{}` (off) — behavior identical to before this
  // flag was added.
  options: { treatFullBleedAsContent?: boolean; hideTinyImages?: boolean } = {},
): ClassifiedImage[] {
  const treatFullBleedAsContent = options.treatFullBleedAsContent ?? false;
  const correlatedPageCounts = computeCorrelatedPageCounts(entries);
  const maskedObjIds = computeMaskedObjIds(entries);

  const first = entries.map((entry): ClassifiedImage => {
    // 1. Hard mask evidence — decision final, regardless of anything else.
    if (entry.maskEvidence === 'group' || entry.maskEvidence === 'opcode') {
      return { entry, classification: 'mask', reason: `Z1-mask-evidence-${entry.maskEvidence}`, confidence: confidenceForReason(`Z1-mask-evidence-${entry.maskEvidence}`) };
    }

    // Computed EARLY, because it's now used by TWO
    // independent rules below (multi-page correlation AND print bleed), not
    // just by the later H1 signal. The same pattern as
    // `maxCenterTextCoverageRatio` from step 14 — see its own comment.
    const centerTextCoverage = maxCenterTextCoverageRatio(entry, bodyBoxesByPage);

    // 2. Page count AFTER correlation — a multi-page resource is a
    // CANDIDATE for decoration, but no longer a hard decision. Threshold=2 falsely classified
    // 22/133 `useful` (a region map referenced across several chapters, a
    // repeated faction symbol) — the real distribution showed that raising
    // it to 5 would lower this to 12/133, losing only 2/21 correctly caught
    // `decoration` (from 21 to 19). Above the threshold this is NO
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
      // Narrow divider strips repeated across 6-23 pages: a SECOND independent signal
      // equivalent to print
      // bleed above — bbox aspect ratio (`Z13-extreme-aspect-ratio-divider`
      // further down in this function uses the SAME
      // `hasExtremeAspectRatioOccurrence`, but is only checked AFTER this
      // block, so it never got a chance for entries that landed here first).
      // Measured directly: a decorative divider strip used throughout the
      // book (each use is <1% of the page area, WITH NO print bleed — it
      // sits IN THE MIDDLE of the page, not at its edge) landed in
      // `undecided` on EVERY ONE of 6-23 occurrences, despite an extremely
      // elongated aspect ratio (>16:1) — a signal just as unambiguous as
      // bleed, just never checked at this point. Genuine, repeated CONTENT almost never
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
    // bbox" gets mistakenly counted as content. Also NO
    // LONGER hard — 25/49 lost `useful` items in the
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
        // right here. Publications with a bespoke illustration under every
        // page land PRECISELY in this branch.
        if (treatFullBleedAsContent) {
          return { entry, classification: 'content', reason: 'Z1-full-bleed-forced-content', confidence: confidenceForReason('Z1-full-bleed-background') };
        }
        return { entry, classification: 'decoration', reason: 'Z1-full-bleed-background', confidence: confidenceForReason('Z1-full-bleed-background') };
      }
      // A bleeding image that another image cuts out through a mask is a shape of the page's own design —
      // a paper scrap, a stain, a drop shadow, a strip of tape. Rendered on its own it shows nothing but the
      // page around it, so it is not offered. An unmasked bleeding image stays `undecided`: it may be a
      // cover or a full-page illustration.
      if (entry.objId !== null && maskedObjIds.has(entry.objId)) {
        return { entry, classification: 'decoration', reason: 'Z12-bleeding-masked-cutout', confidence: confidenceForReason('Z12-bleeding-masked-cutout') };
      }
      // A bleeding image painted translucent everywhere it appears (a watermark ornament, a texture laid
      // over the paper) is the page's own atmosphere, not an illustration: the illustrations of the same
      // book are painted opaque. Measured on a real rulebook: all 11 translucent ones sit at 10%-50% opacity,
      // all 22 other bleeding images at 100%.
      if (isTranslucentEverywhere(entry)) {
        // A big one is a panel of the page's design, and a drawing (a map) may lie on it: the extraction judges it by its pixels.
        if (entry.maxRelativeArea >= LARGE_TRANSLUCENT_PANEL_MIN_AREA && !isBackdropShape(entry)) {
          return { entry, classification: 'undecided', reason: LARGE_TRANSLUCENT_PANEL_REASON, confidence: confidenceForReason(LARGE_TRANSLUCENT_PANEL_REASON) };
        }
        return { entry, classification: 'decoration', reason: 'Z12-bleeding-translucent-overlay', confidence: confidenceForReason('Z12-bleeding-translucent-overlay') };
      }
      // A narrow sliver of a picture at the edge of the page (the visible end of a document sheet, a strip of tape)
      // is part of the page's design, not a picture to import.
      if (isSmallBleedingStrip(entry)) {
        return { entry, classification: 'decoration', reason: 'Z24-small-bleeding-strip', confidence: confidenceForReason('Z24-small-bleeding-strip') };
      }
      return { entry, classification: 'undecided', reason: 'Z12-bleeding-no-center-text-evidence', confidence: confidenceForReason('Z12-bleeding-no-center-text-evidence') };
    }

    // 3. Large page area — a content candidate.
    const isLargeArea = entry.maxRelativeArea >= LARGE_AREA_CONTENT_THRESHOLD;

    // 5. maskEvidence==='geometry' — weak evidence, NEVER decisive on its own.
    //
    // A manual review in step 7
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

    // `body` text coverage — checked AFTER the nuanced handling
    // of `geometry` above (doesn't change it), but BEFORE the "large area ->
    // content" rules: a textured background with paragraphs on it often ALSO
    // has a large relative area, and that's EXACTLY the case this signal is
    // meant to catch (see the comment on `TEXT_COVERAGE_DECORATION_THRESHOLD`).
    const textCoverage = maxTextCoverageRatio(entry, bodyBoxesByPage);
    if (textCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD && !hasLargeAbsoluteOccurrence(entry)) {
      return { entry, classification: 'decoration', reason: 'Z9-high-body-text-coverage', confidence: confidenceForReason('Z9-high-body-text-coverage') };
    }

    // The Z9 signal above has been DISABLED for large images
    // (`hasLargeAbsoluteOccurrence`), precisely for the reason
    // described at `maxCenterTextCoverageRatio`. It comes back here — but
    // computed on the CENTER, not the whole bbox, so it doesn't suffer from
    // the same problem, and lands in `undecided` (NOT `decoration`):
    // measured on the same reference set that landing directly in
    // `decoration` reduced "reachable" completeness (content+undecided,
    // i.e. anything visible on the review screen) from 63% to 45% — some
    // genuinely useful images became COMPLETELY invisible instead of needing
    // a single click in `undecided`. `centerTextCoverage`
    // already computed above — Z1-multi-page-correlated and
    // Z1-full-bleed-background now use it too.
    if (centerTextCoverage >= TEXT_COVERAGE_DECORATION_THRESHOLD) {
      return { entry, classification: 'undecided', reason: 'Z10-high-center-text-coverage', confidence: confidenceForReason('Z10-high-center-text-coverage') };
    }

    if (isLargeArea) {
      return { entry, classification: 'content', reason: 'Z1-large-relative-area', confidence: confidenceForReason('Z1-large-relative-area') };
    }

    // Zero masking evidence (not just weak) + moderate area —
    // see the comment on `MEDIUM_AREA_NO_EVIDENCE_THRESHOLD`.
    if (entry.maskEvidence === null && entry.maxRelativeArea >= MEDIUM_AREA_NO_EVIDENCE_THRESHOLD) {
      return { entry, classification: 'content', reason: 'Z2-moderate-area-no-mask-evidence', confidence: confidenceForReason('Z2-moderate-area-no-mask-evidence') };
    }

    // A narrow divider strip —
    // ONE signal (aspect ratio) ALONE no longer decides `decoration`
    // outright (the image must go through the review screen, where
    // the user sees it and decides) — it lands in `undecided`, with a
    // `Diagnostic` added in `buildImageExtraction.ts`. Checked AFTER all the
    // "large area -> content" rules (doesn't override them), but BEFORE the
    // final `undecided`/`Z1-no-strong-signal` — otherwise this case would
    // get the lowest possible confidence, even though the aspect ratio IS a
    // real (just unconfirmed) signal.
    // A small, elongated raster that another image cuts out through a mask is a strip of adhesive tape or a
    // scrap of paper stuck on a picture. Alone it is never useful, and offering it also stretches the
    // unit of the picture it sits on. The aspect gate keeps small square-ish masked content (an emblem, a
    // portrait) out of this rule.
    if (isSmallTranslucentMaskedRaster(entry, maskedObjIds)) {
      return { entry, classification: 'decoration', reason: 'Z20-small-translucent-masked-raster', confidence: confidenceForReason('Z20-small-translucent-masked-raster') };
    }
    if (isTranslucentMaskedStrip(entry, maskedObjIds)) {
      return { entry, classification: 'decoration', reason: 'Z25-translucent-masked-strip', confidence: confidenceForReason('Z25-translucent-masked-strip') };
    }
    if (isMaskedStrip(entry, maskedObjIds)) {
      return { entry, classification: 'decoration', reason: 'Z23-masked-strip', confidence: confidenceForReason('Z23-masked-strip') };
    }
    if (isSmallMaskedStrip(entry, maskedObjIds)) {
      return { entry, classification: 'decoration', reason: 'Z15-small-masked-raster', confidence: confidenceForReason('Z15-small-masked-raster') };
    }

    if (!isLargeArea && hasExtremeAspectRatioOccurrence(entry)) {
      return { entry, classification: 'undecided', reason: 'Z13-extreme-aspect-ratio-undecided', confidence: confidenceForReason('Z13-extreme-aspect-ratio-undecided') };
    }

    // No strong signal in either direction — don't guess.
    return { entry, classification: 'undecided', reason: 'Z1-no-strong-signal', confidence: confidenceForReason('Z1-no-strong-signal') };
  });
  return hideTinyAndCoveredPictures(first, options.hideTinyImages ?? false, maskedObjIds);
}

/**
 * Page-area share below which an image nobody could classify (`undecided`) is not offered. Measured on
 * a real rulebook: the form elements of a character sheet (label bars, title letters, tick boxes) are
 * 0.0%-0.5% of the page, spread over a handful of pages in dozens at a time; a 1-inch token is about 1.1%.
 */
const TINY_IMAGE_MAX_AREA = 0.005;

/**
 * A page with at least this many tiny undecided images (see `TINY_IMAGE_MAX_AREA`) is a form — a character
 * sheet built of label bars, title letters and tick boxes. Measured on a real rulebook: the two sheet pages
 * have 48 and 66 tiny images; the busiest ordinary page, with a row of small icons, has 10.
 */
const FORM_PAGE_MIN_TINY_IMAGES = 15;
/** On a form page, undecided images below this page-area share are parts of the form (its banners and boxes). */
const FORM_PAGE_ELEMENT_MAX_AREA = 0.06;

/**
 * Share of a picture that a later-painted opaque picture must cover for it to count as hidden under it.
 * Measured on a real rulebook where pinned photos are stacked over one filler picture (the same artwork
 * under each stack): the hidden ones are covered 79%-100%, the pictures that merely overlap one another
 * at most 68%.
 */
const COVERED_PICTURE_MIN_COVER = 0.75;
/**
 * A translucent picture counts as a copy of an earlier one when it covers (almost) all of itself with it and the
 * earlier picture is not much larger. Measured on a real rulebook: the 60%-opaque copies of the same cover art
 * lie on the original with 99%-100% overlap both ways; the second condition keeps a watermark laid over a
 * page-sized background from being taken for a copy of it.
 */
const TRANSLUCENT_COPY_MIN_OVERLAP = 0.9;
const TRANSLUCENT_COPY_MIN_BASE_COVER = 0.6;
/**
 * A page-filling picture (at least this share of the page) under a content picture of at least
 * `PAGE_BACKGROUND_MIN_CONTENT_AREA` is the background of that page. Measured on a real rulebook: the textured
 * section-opener backgrounds fill 100.5% of the page with a photo of 20% painted on them.
 */
const PAGE_BACKGROUND_MIN_AREA = 0.95;
const PAGE_BACKGROUND_MIN_CONTENT_AREA = 0.05;
/** Only pictures of at least this page-area share are checked for being covered. */
const COVERED_PICTURE_MIN_AREA = 0.03;

/**
 * Whether a picture is one that hides what lies under it. A masked picture (a print cut out by its mask) or a
 * page-sized one does. Any other raster may be a cut-out figure or a faded vignette with a transparent middle,
 * painted over the picture that is its subject: measured on a real rulebook, an unmasked 376x225 px vignette
 * that is 23% opaque lies over the illustration it frames and covers 100% of its bbox. Only pixels could
 * tell those apart, so such pictures never count as covering.
 */
function coversForSure(entry: ImageEntry, maskedObjIds: ReadonlySet<string>): boolean {
  return (entry.objId !== null && maskedObjIds.has(entry.objId)) || entry.maxRelativeArea >= COVERING_PAGE_SIZED_AREA;
}

/**
 * A picture that is much larger than the one it covers hides it whatever its pixels are: the small one lies behind
 * the body of the large one (a strip of paper behind a cut-out figure that is four times its size). Only a covering
 * picture of about the same size can be a vignette that frames the one under it, which is why the factor is 2.
 */
const COVERING_MUCH_LARGER_FACTOR = 2;

/** Share of a picture's box that its mask's box must keep for the mask's box to count as the picture's footprint. */
const MASK_FOOTPRINT_MIN_SHARE = 0.5;

/** Page-area share from which a picture counts as page-sized in `coversForSure`. */
const COVERING_PAGE_SIZED_AREA = 0.9;

function bboxArea(b: Rect): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
}

function intersectionRect(a: Rect, b: Rect): Rect | null {
  const r = { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
  return r.maxX > r.minX && r.maxY > r.minY ? r : null;
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Two cuts that need a look at the other images of the page:
 * - `undecided` images below `TINY_IMAGE_MAX_AREA` are decoration (form elements, specks). Only when
 *   `hideTiny` is on: it is part of the "never worth reviewing" hiding that geometry-focused tests with tiny
 *   stand-in images switch off. The same switch covers the form-page rule: on a page with a crowd of tiny
 *   images (a character sheet) the small undecided ones are parts of the form.
 * - A picture that a LATER-painted, fully opaque picture covers almost completely is not visible on the
 *   page — it is the bottom of a stack of pinned photos — and is decoration. Paint order is the
 *   operator index of the occurrence.
 */
function hideTinyAndCoveredPictures(results: readonly ClassifiedImage[], hideTiny: boolean, maskedObjIds: ReadonlySet<string>): ClassifiedImage[] {
  const isPicture = (c: ClassifiedImage): boolean => c.classification === 'content' || c.classification === 'undecided';
  const picturesByPage = new Map<number, ClassifiedImage[]>();
  for (const c of results) {
    const occ = c.entry.occurrences[0];
    if (!occ || !isPicture(c) || c.entry.maxRelativeArea < COVERED_PICTURE_MIN_AREA) continue;
    const arr = picturesByPage.get(occ.page) ?? [];
    arr.push(c);
    picturesByPage.set(occ.page, arr);
  }

  // A masked picture is visible only where its mask lets it through: the mask's box is its footprint when that is
  // smaller than the picture's own box (a tilted print is placed in the box of the whole rotated raster). A mask
  // box far smaller than the picture is not its shape and is ignored.
  const maskBoxByTarget = new Map<string, Rect>();
  for (const c of results) {
    const target = c.entry.masksImageObjId;
    const box = c.entry.occurrences[0]?.bbox;
    if (target !== undefined && box !== undefined) maskBoxByTarget.set(target, box);
  }
  const footprint = (entry: ImageEntry, box: Rect): Rect => {
    const maskBox = entry.objId === null ? undefined : maskBoxByTarget.get(entry.objId);
    const shared = maskBox !== undefined ? intersectionRect(box, maskBox) : null;
    return shared !== null && bboxArea(shared) >= MASK_FOOTPRINT_MIN_SHARE * bboxArea(box) ? shared : box;
  };

  // Every small picture of a page, however it was judged: a form page is known by how many it has.
  const smallPerPage = new Map<number, number>();
  for (const c of results) {
    const occ = c.entry.occurrences[0];
    if (occ && c.classification !== 'mask' && c.entry.maxRelativeArea < FORM_PAGE_ELEMENT_MAX_AREA) smallPerPage.set(occ.page, (smallPerPage.get(occ.page) ?? 0) + 1);
  }

  const tinyPerPage = new Map<number, number>();
  if (hideTiny) {
    for (const c of results) {
      const occ = c.entry.occurrences[0];
      if (occ && c.classification === 'undecided' && c.entry.maxRelativeArea < TINY_IMAGE_MAX_AREA) tinyPerPage.set(occ.page, (tinyPerPage.get(occ.page) ?? 0) + 1);
    }
  }

  return results.map((c): ClassifiedImage => {
    const formPage = c.entry.occurrences[0] !== undefined && (tinyPerPage.get(c.entry.occurrences[0].page) ?? 0) >= FORM_PAGE_MIN_TINY_IMAGES;
    if (hideTiny && formPage && c.classification === 'undecided' && c.entry.maxRelativeArea >= TINY_IMAGE_MAX_AREA && c.entry.maxRelativeArea < FORM_PAGE_ELEMENT_MAX_AREA) {
      return { entry: c.entry, classification: 'decoration', reason: 'Z18-form-page-element', confidence: confidenceForReason('Z18-form-page-element') };
    }
    // The picture that fills a page crowded with small images (a character sheet, whose boxes and banners are pictures) and that nobody could judge is the backdrop of the sheet.
    if (hideTiny && c.classification === 'undecided' && c.entry.maxRelativeArea >= PAGE_BACKGROUND_MIN_AREA && c.entry.occurrences[0] !== undefined && (smallPerPage.get(c.entry.occurrences[0].page) ?? 0) >= FORM_PAGE_MIN_TINY_IMAGES) {
      return { entry: c.entry, classification: 'decoration', reason: 'Z18-form-page-background', confidence: confidenceForReason('Z18-form-page-background') };
    }
    if (hideTiny && c.classification === 'undecided' && c.entry.maxRelativeArea < TINY_IMAGE_MAX_AREA) {
      return { entry: c.entry, classification: 'decoration', reason: 'Z16-tiny-undecided', confidence: confidenceForReason('Z16-tiny-undecided') };
    }
    const occ = c.entry.occurrences[0];
    if (!occ || !isPicture(c) || c.entry.maxRelativeArea < COVERED_PICTURE_MIN_AREA) return c;
    // A picture that fills the page and that nobody could judge, with a picture that was judged content painted on it
    // later, is the page's background (a textured sheet under a photo), not another picture. Not on the first page: the
    // cover is a picture of its own.
    if (
      occ.page > 1 &&
      c.classification === 'undecided' &&
      c.entry.maxRelativeArea >= PAGE_BACKGROUND_MIN_AREA &&
      (picturesByPage.get(occ.page) ?? []).some((other) => other.classification === 'content' && other.entry.maxRelativeArea >= PAGE_BACKGROUND_MIN_CONTENT_AREA && other.entry.occurrences.some((o) => o.page === occ.page && o.index > occ.index))
    ) {
      return { entry: c.entry, classification: 'decoration', reason: 'Z22-page-background-under-content', confidence: confidenceForReason('Z22-page-background-under-content') };
    }
    const ownBox = footprint(c.entry, occ.bbox);
    const area = bboxArea(ownBox);
    if (area <= 0) return c;
    const covered = (picturesByPage.get(occ.page) ?? []).some((other) => {
      if (other === c || !(coversForSure(other.entry, maskedObjIds) || other.entry.maxRelativeArea >= COVERING_MUCH_LARGER_FACTOR * c.entry.maxRelativeArea)) return false;
      const over = other.entry.occurrences.find((o) => o.page === occ.page && o.index > occ.index && o.opacity === undefined);
      return over !== undefined && intersectionArea(ownBox, footprint(other.entry, over.bbox)) / area >= COVERED_PICTURE_MIN_COVER;
    });
    if (covered) return { entry: c.entry, classification: 'decoration', reason: 'Z17-covered-by-later-picture', confidence: confidenceForReason('Z17-covered-by-later-picture') };
    // A translucent layer laid exactly over a picture painted before it (a tint or a copy of the same artwork
    // at 20%-60%) is part of that picture, not another one.
    const isTranslucentCopy =
      isTranslucentEverywhere(c.entry) &&
      (picturesByPage.get(occ.page) ?? []).some((other) => {
        if (other === c) return false;
        const base = other.entry.occurrences.find((o) => o.page === occ.page && o.index < occ.index);
        if (base === undefined) return false;
        const shared = intersectionArea(occ.bbox, base.bbox);
        return shared / area >= TRANSLUCENT_COPY_MIN_OVERLAP && shared / bboxArea(base.bbox) >= TRANSLUCENT_COPY_MIN_BASE_COVER;
      });
    return isTranslucentCopy ? { entry: c.entry, classification: 'decoration', reason: 'Z19-translucent-copy-of-picture', confidence: confidenceForReason('Z19-translucent-copy-of-picture') } : c;
  });
}
