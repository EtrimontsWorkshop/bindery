import { clusterByOverlap } from '../clustering.js';
import { overlapRatio, rectArea, rectIntersection, relativeArea, unionRect, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion } from '../inventory/vectorRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { classifyImages, confidenceForReason, EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, type ClassifiedImage, type ImageClassification } from './classify.js';
import { AUTOCROP_BRIGHTEN, brightenCroppedImage } from './brightenImage.js';
import { cropDecodedImage, detectContentBounds } from './cropUniformMargins.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder, OutputFormat } from './encodeImage.js';
import { currentObjIdAt, extractDirect, probeIntrinsicLongEdgePx, probeIntrinsicSizePx, probeMeanBrightnessFraction, waitForObjects, type PdfPageForExtract } from './extract.js';
import { computeContentHash, computeLuminanceStdDev, computeOpaqueFraction, computeUniformColorFraction, computeSmoothnessMetrics, finalizeImages, type FinalizedImage, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import { computeTargetLongEdgePx } from './renderResolution.js';
import { CO_MEMBER_SIGNIFICANT_AREA, computeMaskedObjIds, decideExtractionStrategy } from './strategy.js';

/**
 * Image-extraction orchestration: classification -> strategy -> extraction (region render when
 * needed) -> finalization, with memory and determinism discipline. Mirrors the pattern of
 * `buildPageLayout.ts`: a single entry point tying all the stages together into one pass per
 * document.
 */

export interface InventoryForImages {
  images: readonly ImageEntry[];
  vectors: readonly VectorRegion[];
  perPage: readonly { pageNumber: number; box: Rect; rotation: number }[];
}

export interface PdfDocumentLikeForImages {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForExtract & { cleanup(): void }>;
}

export interface BuildImageExtractionOptions {
  /**
   * Used AS A STARTING POINT, NOT as the sole region-render resolution — see
   * `renderResolution.ts`. Still the only resolution for purely vector regions (no image, so the
   * "value from settings" applies).
   */
  targetLongEdgePx?: number;
  /** Hard ceiling on region-render resolution — guards against an absurd file size from a spread with very high native resource resolution. */
  maxLongEdgePx?: number;
  outputFormat?: OutputFormat;
  outputQuality?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** `objId` of images adjacent to a `statblock`/`heading` block — `portrait` signal. */
  nearStatblockOrHeadingObjIds?: ReadonlySet<string>;
  /** Bboxes of `body` blocks (text flow) per page — see `classify.ts`. Links the text flow to the image flow, EXPLICITLY via this parameter. */
  bodyBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /**
   * Bboxes of ALL text blocks (headings, sidebars and the rest, not only `body`/`caption`) per page. Used to
   * tell a picture that text lies ON (a paper note, a newspaper handout — the text is part of what the page
   * shows) from one that has text only beside it. Falls back to `bodyBlockBoxesByPage` when absent.
   */
  textBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /** Bypasses `Z1-full-bleed-background`/`Z9-high-body-text-coverage` for full-bleed images, treating them as content instead of background. Off by default. */
  treatFullBleedAsContent?: boolean;
  /** [at the user's request, EXPERIMENTAL] See `cropUniformMargins.ts`. No effect when `treatFullBleedAsContent` is off. Off by default. */
  autoCropUniformMargins?: boolean;
  /** [User request] Hide single-color and smooth-background images from the auto-detected list (see `UNIFORM_COLOR_MIN_FRACTION` and `SMOOTH_BACKGROUND_COARSE_MAX` in `finalize.ts`). On by default; only geometry-focused tests with flat-color stand-in images turn it off. */
  hideBackgroundImages?: boolean;
  /** [at the user's request] See `brightenImage.ts`. No effect when a given image wasn't actually cropped by `autoCropUniformMargins`. Off by default. */
  brightenAutoCroppedImages?: boolean;
  /**
   * How long, per page, to wait for resources that the planning of a unit needs (the picture and the
   * masks that cut it) to show up in `page.objs` after `getOperatorList()`. In a browser they arrive
   * asynchronously. The time is spent only while a needed resource is missing, and once a page's budget
   * is used up its remaining units do not wait again. Defaults to 1500 ms; 0 disables waiting.
   */
  objectSettleTimeoutMs?: number;
}

export interface BuildImageExtractionResult {
  images: FinalizedImage<EncodedImage>[];
  correlationClosedByBBox: number;
  correlationClosedByHash: number;
  duplicatesRemoved: number;
  diagnostics: Diagnostic[];
}

/** Reasonable default target for scenes/handouts — configurable per call, for calibration against real documents. */
const DEFAULT_TARGET_LONG_EDGE_PX = 2048;
/**
 * Page-area share from which a picture split off a unit is offered even when it is only `undecided` (below it,
 * only `content` pictures are split off, so that small leftovers of the stack do not clutter the list).
 */
const SPLIT_OFF_MIN_AREA = 0.1;

/** A unit member painted at or below this opacity is a watermark, not a picture, and is left out of `coMemberAreaShare`. */
const CO_MEMBER_TRANSLUCENT_MAX_OPACITY = 0.6;

/** Default for `objectSettleTimeoutMs`. */
const DEFAULT_OBJECT_SETTLE_TIMEOUT_MS = 1500;

/** Default hard ceiling — configurable via `maxLongEdgePx`. */
const DEFAULT_MAX_LONG_EDGE_PX = 4096;
/** Same threshold as `LARGE_AREA_CONTENT_THRESHOLD` in `classify.ts` — consistency between "large image = content" and "large vector with no image = a drawn map". */
const LARGE_VECTOR_AREA_THRESHOLD = 0.4;
/**
 * a SECOND-ORDER safeguard (not the main mechanism — see
 * `groupIntoUnits`): a cluster (>1 member) whose union of bboxes exceeds this
 * share of the page area is forced to `undecided`, regardless of the
 * Starting value (e.g. 85%)
 * — deliberately HIGH, because the MAIN fix (clustering EXCLUSIVELY
 * content/undecided candidates, recomputed from scratch) already eliminates
 * the typical case (a chain of background tiles made of `decoration`/`mask`
 * entries). This safeguard only catches a rarer case: a dense chain of SMALL
 * but individually `content`/`undecided` fragments that still ends up
 * spanning nearly the entire page.
 */
const CLUSTER_AREA_SAFEGUARD_THRESHOLD = 0.85;

/**
 * Two "independently large" candidates (>= this share of the page area, each on its own —
 * likely finished, standalone content images, not fragments of one composition) are merged into
 * a SINGLE "anchor" only if their overlap (`overlapRatio` — intersection area / area of the
 * SMALLER one) reaches this threshold. Small elements (below the area threshold) are NEVER
 * "anchors" — they're still merged with the loose `rectsOverlap` as always (see
 * `partitionCandidatesIntoGroups`), because they practically NEVER reach this area threshold
 * individually (fixture `extract-cluster`: 60x60/40x40pt icons are <1% of the page each).
 *
 * Both constants were tuned for ONE specific reported case, never systematically calibrated —
 * checked against a real rulebook with 380 images over 97 pages (up to 18 images on a single
 * page). A second sample rulebook was rejected as test material: it exports EVERY page as a
 * single flat raster, so it doesn't exercise multi-image clustering at all. Sweeping BOTH
 * constants independently across their FULL reasonable range
 * (`INDEPENDENT_IMAGE_AREA_THRESHOLD`: 0.01-0.9; `EDGE_TOUCH_MAX_OVERLAP_RATIO`: 0.01-0.9)
 * produced a STABLE result — the group count only varies within a narrow band (186-212 out of
 * 262 candidates), the single largest cluster stays identical (11 members) across the whole
 * range of both parameters — ZERO cliff, zero explosion into one mega-cluster, zero collapse
 * into pure singletons. The existing golden regression tests (`extract-independent-touching`,
 * `extract-anchor-loose-fragment`, `extract-shared-resource-multipage`) still pass. Conclusion:
 * the starting values (0.1 / 0.2) sit safely in the MIDDLE of a wide plateau — there's no
 * evidence they're wrong, so they STAY UNCHANGED (changing something without a reason is worse
 * than not changing it).
 */
const INDEPENDENT_IMAGE_AREA_THRESHOLD = 0.1;
const EDGE_TOUCH_MAX_OVERLAP_RATIO = 0.2;

function isAnchorCandidate(c: ClassifiedImage): boolean {
  return c.entry.maxRelativeArea >= INDEPENDENT_IMAGE_AREA_THRESHOLD;
}

/**
 * The first version of this fix (a
 * single gate on `clusterByOverlap`, blocking ONLY the direct merge of two
 * "anchors") fixed `img_p15_1`+`img_p15_2` (p. 16, touching DIRECTLY), but
 * NOT `img_p13_1`+`img_p13_2` (p. 14) — reported by the user as still not
 * working. Cause: clustering is TRANSITIVE (union-find) — two anchors A and
 * B, whose gate blocks a DIRECT merge, still end up in ONE cluster if each of
 * them INDEPENDENTLY overlaps a third, SMALL element C (the gate doesn't
 * block pairs where at least one member is small, so A-C and B-C merge
 * normally, and A-C-B puts A and B in one cluster even though A-B itself was
 * blocked). Observed directly: `img_p13_3`/`img_p13_4` (each ~1.5% of the
 * page) sit IN THE OVERLAP ZONE of `img_p13_1` (26.9%) and `img_p13_2`
 * (10.2%), bridging them back together.
 *
 * Fix: TWO-STAGE partitioning instead of a flat gated `clusterByOverlap`.
 * (1) Split out the "anchors" (>= the area threshold) and cluster ONLY them,
 * requiring strong overlap (`overlapRatio >= EDGE_TOUCH_MAX_OVERLAP_RATIO`)
 * to merge — two anchors touching weakly NEVER end up in one anchor group,
 * no matter how many small elements "bridge" them. (2) Every SMALL
 * (non-anchor) element is attached to the ONE anchor group with which it has
 * the LARGEST intersection area (not to all it touches) — `img_p13_3`
 * overlaps `img_p13_2` across ~91% of its own area, but `img_p13_1` only
 * ~9%, so it goes EXCLUSIVELY into `img_p13_2`'s group. (3) Small elements
 * with no overlap with any anchor on that page are clustered among
 * themselves the old way (loose `rectsOverlap`, no change) — preserving the
 * original tile-chain-gluing mechanism (step 7/8, `img_p7_6`) on pages WITH
 * NO anchor at all.
 */
/**
 * An image
 * forced to `content` SOLELY because it's a full-bleed background with text
 * on top (`Z1-full-bleed-forced-content`, see `classify.ts`) MUST be
 * EXCLUDED from the clustering below, otherwise the whole point of the flag
 * ("a clean image with no text") is defeated: its bbox by DEFINITION
 * "contains" (rectsOverlap and overlapRatio ~1.0 relative to the smaller
 * one) EVERY other image/vector on the same page, so the normal anchor logic
 * (`isAnchorCandidate`/`EDGE_TOUCH_MAX_OVERLAP_RATIO`) would merge it with
 * EVERY other candidate into ONE unit, forcing `clusterMemberCount > 1` ->
 * `region-render` of the WHOLE page (with text) instead of `direct` (raw
 * asset, no text) — measured directly on a user export: a page instead of a
 * clean illustration.
 */
function isForcedFullBleedContent(c: ClassifiedImage): boolean {
  return c.reason === 'Z1-full-bleed-forced-content';
}

/**
 * Share of a picture's own area that text blocks must cover for the text to count as part of the picture.
 * Measured on a real rulebook across the masked pictures: photos have 0-13% (a caption laid over a corner,
 * a neighbor's note), paper notes and newspaper handouts 40%-95%.
 */
const TEXT_OVER_PICTURE_FRACTION = 0.3;

/** The share (0-1) of `bbox` covered by `textBoxes`, overlaps between the boxes counted twice and the sum capped. */
export function textCoverage(bbox: Rect, textBoxes: readonly Rect[] | undefined): number {
  if (!textBoxes || textBoxes.length === 0) return 0;
  const area = rectArea(bbox);
  if (area <= 0) return 0;
  let covered = 0;
  for (const t of textBoxes) {
    const inter = rectIntersection(bbox, t);
    if (inter) covered += rectArea(inter);
  }
  return Math.min(1, covered / area);
}

/**
 * Share of the unit's area that text blocks cut by its edge must cover before the raw image resource
 * is preferred over a render of the region. Measured on a real rulebook whose pictures sit under
 * text panels: the units with a visible slice of the page's text had 1.4%-19%; 1% catches a single cut
 * line across the width of a picture while ignoring a block that merely brushes the edge.
 */
const TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION = 0.01;

/**
 * Whether body/caption blocks that the unit's bbox CUTS (they reach outside it) cover enough of it. Such
 * a block belongs to the surrounding page layout — a render of the region would slice it into the
 * picture. A block lying entirely INSIDE the bbox (a label on a map, a caption inside a frame) is
 * judged to belong to the picture's own composition and is not counted.
 */
function textCrossesRegionEdge(bbox: Rect, textBoxes: readonly Rect[] | undefined): boolean {
  if (!textBoxes || textBoxes.length === 0) return false;
  const area = rectArea(bbox);
  if (area <= 0) return false;
  let crossing = 0;
  for (const t of textBoxes) {
    const inter = rectIntersection(bbox, t);
    if (!inter) continue;
    const inside = t.minX >= bbox.minX && t.maxX <= bbox.maxX && t.minY >= bbox.minY && t.maxY <= bbox.maxY;
    if (!inside) crossing += rectArea(inter);
  }
  return crossing / area >= TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION;
}

/**
 * How far the long-to-short edge ratio of a raw resource may differ from the one of the place it is
 * painted in and still count as "the same picture". Measured on a real rulebook: a picture of 470x473 px
 * painted into a 239x240 pt box differs by 1%; a paper-texture strip of 1601x119 px painted under a
 * 243x417 pt picture differs by a factor of 23. Rotation by 90 degrees does not matter (the ratio is
 * taken long edge over short edge).
 */
const RAW_RESOURCE_PLACEMENT_ASPECT_TOLERANCE = 0.25;

/**
 * The share of a masked picture that its mask must let through for the raw resource to stand in for the
 * rendered region. Measured on a real rulebook: the masks of photos pinned to the page as tilted prints
 * are white over 91%-95% of their raster (the rest is the black margin that tilts the edge); a mask that
 * deliberately hides half of a picture is far below.
 */
const MASK_MOSTLY_VISIBLE_FRACTION = 0.8;

/**
 * Whether the raw pixels of a resource have the proportions of the box they are painted in. The
 * resource of a masked or clustered unit is not always the picture: it can be a texture or a fill that the
 * composition stretches under or over the real artwork, and then "the raw resource" is a different image
 * than what the page shows.
 */
export function rawResourceFitsPlacement(raw: { width: number; height: number }, placed: Rect): boolean {
  const placedW = placed.maxX - placed.minX;
  const placedH = placed.maxY - placed.minY;
  if (raw.width <= 0 || raw.height <= 0 || placedW <= 0 || placedH <= 0) return false;
  const rawRatio = Math.max(raw.width, raw.height) / Math.min(raw.width, raw.height);
  const placedRatio = Math.max(placedW, placedH) / Math.min(placedW, placedH);
  return Math.abs(rawRatio - placedRatio) / placedRatio <= RAW_RESOURCE_PLACEMENT_ASPECT_TOLERANCE;
}

/**
 * An image that bleeds off the page and has no evidence of being content (`Z12-bleeding-no-center-text-evidence`)
 * is typically a piece of the page's own design — a coloured tab at the page edge, a corner ornament —
 * not part of the picture it happens to overlap. Merging it into a neighbor's unit stretches that unit's
 * bbox to the edge of the page (and past the picture), so the region render of the unit pulls in whatever
 * text and margins lie in between. Such an image stays a unit of its own: it is still offered in the
 * review screen (as `undecided`, unchecked by default), but it no longer changes what the picture next
 * to it looks like. Observed on a real rulebook whose photos sit next to page-edge tabs and corner pieces.
 */
function isBleedingUndecided(c: ClassifiedImage): boolean {
  return c.reason === 'Z12-bleeding-no-center-text-evidence';
}

function partitionCandidatesIntoGroups(candidates: readonly ClassifiedImage[]): ClassifiedImage[][] {
  const forcedFullBleed = candidates.filter(isForcedFullBleedContent);
  const bleedingUndecided = candidates.filter(isBleedingUndecided);
  const clusterable = candidates.filter((c) => !isForcedFullBleedContent(c) && !isBleedingUndecided(c));

  const anchors = clusterable.filter(isAnchorCandidate);
  const rest = clusterable.filter((c) => !isAnchorCandidate(c));

  const anchorClusterId = clusterByOverlap(
    anchors,
    (c) => c.entry.occurrences[0]!.page,
    (c) => c.entry.occurrences[0]!.bbox,
    (_a, _b, bboxA, bboxB) => overlapRatio(bboxA, bboxB) >= EDGE_TOUCH_MAX_OVERLAP_RATIO,
  );
  const anchorGroups = new Map<string, ClassifiedImage[]>();
  for (const a of anchors) {
    const key = anchorClusterId.get(a)!;
    const arr = anchorGroups.get(key) ?? [];
    arr.push(a);
    anchorGroups.set(key, arr);
  }
  const groupKeyOfAnchor = new Map<ClassifiedImage, string>();
  for (const [key, group] of anchorGroups) for (const a of group) groupKeyOfAnchor.set(a, key);

  const anchorsByPage = new Map<number, ClassifiedImage[]>();
  for (const a of anchors) {
    const page = a.entry.occurrences[0]!.page;
    const arr = anchorsByPage.get(page) ?? [];
    arr.push(a);
    anchorsByPage.set(page, arr);
  }

  const unassignedRest: ClassifiedImage[] = [];
  for (const c of rest) {
    const page = c.entry.occurrences[0]!.page;
    const bboxC = c.entry.occurrences[0]!.bbox;
    let bestAnchor: ClassifiedImage | null = null;
    let bestOverlapArea = 0;
    for (const a of anchorsByPage.get(page) ?? []) {
      const inter = rectIntersection(a.entry.occurrences[0]!.bbox, bboxC);
      if (!inter) continue;
      const area = rectArea(inter);
      if (area > bestOverlapArea) {
        bestOverlapArea = area;
        bestAnchor = a;
      }
    }
    // The mere fact of "some"
    // overlap with the best anchor is NOT ENOUGH — observed directly:
    // `img_p13_4` (~1.5% of the page) touched the only anchor on the page
    // (`img_p13_1`, 26.9%) EXCLUSIVELY at a narrow corner (overlapRatio
    // relative to its OWN area ~9%), yet its bbox extended ~200pt BEYOND the
    // anchor — attaching it still reproduced a near-identical, overly wide
    // union bbox as before the fix (because `img_p13_2`, the decoration
    // between them, had already been correctly excluded from the candidates,
    // but ITS PLACE was taken by `img_p13_4`). The same threshold as for
    // merging two anchors is required (`overlapRatio >= EDGE_TOUCH_MAX_OVERLAP_RATIO`,
    // computed relative to the SMALLER of the two — here almost always
    // element C itself) — below the threshold, the element goes into the
    // shared clustering of the rest (or becomes its own separate, small
    // unit), and is NOT pulled into the anchor.
    if (bestAnchor && overlapRatio(bestAnchor.entry.occurrences[0]!.bbox, bboxC) >= EDGE_TOUCH_MAX_OVERLAP_RATIO) {
      anchorGroups.get(groupKeyOfAnchor.get(bestAnchor)!)!.push(c);
    } else {
      unassignedRest.push(c);
    }
  }

  const groups: ClassifiedImage[][] = [...anchorGroups.values()];
  if (unassignedRest.length > 0) {
    const restClusterId = clusterByOverlap(
      unassignedRest,
      (c) => c.entry.occurrences[0]!.page,
      (c) => c.entry.occurrences[0]!.bbox,
    );
    const restGroups = new Map<string, ClassifiedImage[]>();
    for (const c of unassignedRest) {
      const key = restClusterId.get(c)!;
      const arr = restGroups.get(key) ?? [];
      arr.push(c);
      restGroups.set(key, arr);
    }
    groups.push(...restGroups.values());
  }
  groups.push(...forcedFullBleed.map((c) => [c]), ...bleedingUndecided.map((c) => [c]));
  return groups;
}

/**
 * A unit that holds several distinct pictures — pinned prints stacked and overlapping on a page, a photo
 * with a note laid over its corner — is split into one unit per picture. Rendering their union gives a
 * region of the page (the pictures, the text and the margin between them); taking one raw resource would
 * drop the others from every list. Only pictures that are masked cut-outs and that cover a real share of
 * the page count as pictures of their own; the tape, crests and paperclips that sit on them stay with the
 * picture they are on, as before.
 */
export function splitUnitsOfDistinctPictures(
  units: readonly ExtractionUnit[],
  classifiedByEntry: ReadonlyMap<ImageEntry, ClassifiedImage>,
  maskedObjIds: ReadonlySet<string>,
): ExtractionUnit[] {
  return units.flatMap((unit) => {
    const significantMasked = unit.memberEntries.filter((m) => m.objId !== null && maskedObjIds.has(m.objId) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
    if (unit.memberEntries.length < 2 || significantMasked.length < 2) return [unit];
    const separate = unit.memberEntries.filter((m) => {
      if (m === unit.representativeEntry) return true;
      const c = classifiedByEntry.get(m);
      return c !== undefined && (m.maxRelativeArea >= SPLIT_OFF_MIN_AREA || (c.classification === 'content' && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA));
    });
    return separate.flatMap((m): ExtractionUnit[] => {
      const c = classifiedByEntry.get(m);
      const boxes = m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox);
      if (!c || boxes.length === 0) return [];
      return [
        {
          representativeEntry: m,
          memberEntries: [m],
          page: unit.page,
          bbox: boxes.reduce((acc, b) => unionRect(acc, b)),
          clusterMemberCount: 1,
          classification: c.classification,
          confidence: c.confidence,
          reason: c.reason,
        },
      ];
    });
  });
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('buildImageExtraction aborted by AbortSignal', 'AbortError');
}

export interface ExtractionUnit {
  /** `null` = a purely vector region (a drawn map), no image to extract. */
  representativeEntry: ImageEntry | null;
  memberEntries: readonly ImageEntry[];
  page: number;
  bbox: Rect;
  clusterMemberCount: number;
  classification: ImageClassification;
  /** See `ClassifiedImage.confidence` — the cluster representative's confidence, possibly lowered when `undecided` is forced (see `IMAGE_CLUSTER_AREA_OVERREACH` below). */
  confidence: number;
  /** The representative's `reason` — used EXCLUSIVELY to detect `Z1-full-bleed-forced-content` (the decision to try `autoCropUniformMargins`), for nothing else. */
  reason: string;
}

/**
 * Groups candidates (content/undecided) into clusters of overlapping bboxes
 * (a cluster = ONE extraction unit, not N). A unit's bbox is the UNION of
 * all occurrences of all members — so that a region render (when the
 * strategy requires it) covers the whole composition, not just one element
 * of it.
 *
 * Clustering is RECOMPUTED FROM SCRATCH here, on the
 * FILTERED set of candidates (`clusterByOverlap`), and NOT read from
 * `entry.clusterId` — that field is computed in `imageRegistry.ts`
 * over ALL occurrences, INCLUDING future decoration/mask entries. Filtering
 * the RESULT of such pre-computed clustering (simply dropping decoration/mask
 * members from the finished group) does NOT break the chain that those very
 * entries bridged — two genuinely separate, distant content images connected
 * EXCLUSIVELY by a chain of small, overlapping decoration tiles between them
 * would remain in ONE group even after dropping those tiles from the member
 * list. Observed directly: `img_p7_6` from a real rulebook
 * — an entire page of text rendered as an "image". Recomputing from scratch
 * on the candidates alone means that removing the bridging decoration/mask
 * FROM THE GRAPH actually breaks the chain, not just filters its members out
 * of the result.
 */
function groupIntoUnits(candidates: readonly ClassifiedImage[], pageBoxByPage: ReadonlyMap<number, Rect>, diagnostics: Diagnostic[]): ExtractionUnit[] {
  const groups = partitionCandidatesIntoGroups(candidates);

  return groups.map((group) => {
    const representative = group.reduce((best, cur) => (cur.entry.maxRelativeArea > best.entry.maxRelativeArea ? cur : best));
    const page = representative.entry.occurrences[0]!.page;
    // Union ONLY of occurrences ON
    // THE SAME page as the unit — observed directly: `g_d0_img_p7_8` (one PDF
    // resource used in 5 DIFFERENT places on 5 DIFFERENT pages, 8/9/15/16/19,
    // NOT "the same element in the same position" — this is typically a
    // shared icon/marker used contextually in different places). The old
    // version unioned the bboxes of ALL occurrences of the entity, INCLUDING
    // those on OTHER pages — the bbox of the unit rendered on page 8 thus
    // also included coordinates from occurrences on pages 9/15/16/19, giving
    // a nonsensical but accidentally large (~48% of the page) union, which,
    // when region-rendering on page 8, caught nearly all of that page's
    // content (observed: an entire statblock page extracted as an "image").
    // The bug was LATENT — previously EVERY entry present on
    // >=2 correlated pages was hard-classified `decoration` (never entering
    // the candidates), so this code path had never been exercised on a real
    // multi-page entry. Raising the threshold to 5 pages (+ soft
    // fallback to `undecided` instead of `decoration`) let such an entry into
    // extraction for the first time, surfacing the dormant bug.
    const bbox = group
      .flatMap((c) => c.entry.occurrences.filter((o) => o.page === page).map((o) => o.bbox))
      .reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
    let classification = representative.classification;
    let confidence = representative.confidence;
    let reason = representative.reason;

    // Second-order safeguard (see the comment on the constant) — only for
    // ACTUAL clusters (>1 member); a single image occupying the whole page
    // is probably a genuine map/scene, not a clustering side effect.
    const pageBox = pageBoxByPage.get(page);
    if (group.length > 1 && pageBox && relativeArea(bbox, pageBox) > CLUSTER_AREA_SAFEGUARD_THRESHOLD) {
      if (classification !== 'undecided') {
        diagnostics.push({
          severity: 'warning',
          code: 'IMAGE_CLUSTER_AREA_OVERREACH',
          params: { imageCount: group.length, percent: (relativeArea(bbox, pageBox) * 100).toFixed(0), classification },
          pageNumber: page,
        });
      }
      classification = 'undecided';
      // Forcing 'undecided' invalidates the representative's
      // original `reason`/`confidence` — this cluster is no longer "a large
      // area with no mask", but a "forced safeguard", so it gets the same
      // low confidence as `Z1-no-strong-signal` (the weakest `undecided`
      // category).
      confidence = confidenceForReason('Z1-no-strong-signal');
      reason = 'Z1-no-strong-signal';
    }

    return {
      representativeEntry: representative.entry,
      memberEntries: group.map((c) => c.entry),
      page,
      bbox,
      clusterMemberCount: group.length,
      classification,
      confidence,
      reason,
    };
  });
}

/**
 * Pages with NO image at all, but with a large vector region (rectangular
 * fill/stroke — `walkOperators` doesn't detect arbitrary paths, only
 * axis-aligned rectangles, see `vectorRegistry.ts`) are a candidate for "a
 * vector-drawn map" — the only way to extract anything is to render the
 * whole region, since there's no image for direct extraction.
 */
function findVectorOnlyUnits(vectors: readonly VectorRegion[], pagesWithAnyImage: ReadonlySet<number>): ExtractionUnit[] {
  const bigVectorsByPage = new Map<number, VectorRegion[]>();
  for (const v of vectors) {
    if (v.relativeArea < LARGE_VECTOR_AREA_THRESHOLD) continue;
    if (pagesWithAnyImage.has(v.page)) continue;
    const arr = bigVectorsByPage.get(v.page) ?? [];
    arr.push(v);
    bigVectorsByPage.set(v.page, arr);
  }
  const units: ExtractionUnit[] = [];
  for (const [page, vecs] of bigVectorsByPage) {
    const bbox = vecs.map((v) => v.bbox).reduce((acc, b) => unionRect(acc, b));
    units.push({
      representativeEntry: null,
      memberEntries: [],
      page,
      bbox,
      clusterMemberCount: 0,
      classification: 'undecided',
      confidence: confidenceForReason('Z1-no-strong-signal'),
      reason: 'Z1-no-strong-signal',
    });
  }
  return units;
}

/** Placeholder `ImageEntry` for units with no real image (a purely vector region) — needed so `finalizeImages` has something to work with. */
function syntheticVectorOnlyEntry(pageNumber: number, bbox: Rect): ImageEntry {
  return {
    objId: null,
    occurrences: [{ page: pageNumber, bbox, index: -1 }],
    pageRefs: [pageNumber],
    maxRelativeArea: 1,
    isMaskLayer: false,
    maskEvidence: null,
    intrinsicWidth: null,
    intrinsicHeight: null,
  };
}

export async function buildImageExtraction(
  doc: PdfDocumentLikeForImages,
  inventory: InventoryForImages,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: BuildImageExtractionOptions = {},
): Promise<BuildImageExtractionResult> {
  const { signal, onProgress } = opts;
  checkAborted(signal); // must be checked NOW, not only inside the per-page loop — a document with no units to process (the loop never runs) would otherwise silently ignore an already-aborted signal.
  const autoCropUniformMargins = opts.autoCropUniformMargins ?? false;
  const hideBackgroundImages = opts.hideBackgroundImages ?? true;
  const brightenAutoCroppedImages = opts.brightenAutoCroppedImages ?? false;
  const targetLongEdgePx = opts.targetLongEdgePx ?? DEFAULT_TARGET_LONG_EDGE_PX;
  const maxLongEdgePx = opts.maxLongEdgePx ?? DEFAULT_MAX_LONG_EDGE_PX;
  const nearStatblockOrHeadingObjIds = opts.nearStatblockOrHeadingObjIds ?? new Set<string>();
  const diagnostics: Diagnostic[] = [];

  const pageBoxByPage = new Map(inventory.perPage.map((p) => [p.pageNumber, p.box]));
  const bodyBlockBoxesByPage = opts.bodyBlockBoxesByPage ?? new Map();
  const textBlockBoxesByPage = opts.textBlockBoxesByPage ?? bodyBlockBoxesByPage;
  const classified = classifyImages(inventory.images, pageBoxByPage, bodyBlockBoxesByPage, {
    treatFullBleedAsContent: opts.treatFullBleedAsContent ?? false,
    hideTinyImages: hideBackgroundImages,
  });
  // `Z13-extreme-aspect-ratio-undecided` (see `classify.ts`) lands in
  // `undecided`, not `decoration` — visible in the review screen, but the
  // user should know WHY the image ended up there (aspect ratio, not "no
  // signal at all"), hence its own Diagnostic instead of a silent
  // classification change.
  for (const c of classified) {
    if (c.reason !== 'Z13-extreme-aspect-ratio-undecided') continue;
    diagnostics.push({
      severity: 'info',
      code: 'IMAGE_EXTREME_ASPECT_RATIO_UNDECIDED',
      params: { threshold: EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD },
      pageNumber: c.entry.occurrences[0]?.page,
    });
  }
  const maskedObjIds = computeMaskedObjIds(inventory.images);
  // Resources that carry a mask, keyed by the resource they mask. They are classified `mask` and never
  // become units of their own, so a unit finds its masks here.
  const maskHoldersByTarget = new Map<string, ImageEntry[]>();
  for (const e of inventory.images) {
    if ((e.maskEvidence !== 'group' && e.maskEvidence !== 'opcode') || !e.masksImageObjId || e.objId === null) continue;
    const holders = maskHoldersByTarget.get(e.masksImageObjId) ?? [];
    holders.push(e);
    maskHoldersByTarget.set(e.masksImageObjId, holders);
  }
  const objectSettleTimeoutMs = opts.objectSettleTimeoutMs ?? DEFAULT_OBJECT_SETTLE_TIMEOUT_MS;

  const candidates = classified.filter((c) => c.classification === 'content' || c.classification === 'undecided');
  const classifiedByEntry = new Map(classified.map((c) => [c.entry, c]));
  const imageUnits = splitUnitsOfDistinctPictures(groupIntoUnits(candidates, pageBoxByPage, diagnostics), classifiedByEntry, maskedObjIds);

  const pagesWithAnyImage = new Set<number>();
  for (const entry of inventory.images) for (const occ of entry.occurrences) pagesWithAnyImage.add(occ.page);
  const vectorOnlyUnits = findVectorOnlyUnits(inventory.vectors, pagesWithAnyImage);

  // DETERMINISTIC order, independent of input order: page ascending, within
  // a page by objId (vector regions, with no objId, at the end of each page).
  const allUnits = [...imageUnits, ...vectorOnlyUnits].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return (a.representativeEntry?.objId ?? '￿').localeCompare(b.representativeEntry?.objId ?? '￿');
  });

  const unitsByPage = new Map<number, ExtractionUnit[]>();
  for (const u of allUnits) {
    const arr = unitsByPage.get(u.page) ?? [];
    arr.push(u);
    unitsByPage.set(u.page, arr);
  }

  const prepared: PreparedEntryForFinalize<EncodedImage>[] = [];
  let done = 0;
  const total = allUnits.length;

  // Sequentially, page by page — NEVER Promise.all across multiple pages (same pattern as
  // `inventory.ts`). `page.cleanup()` after every page (measured: -58% peak RSS).
  for (const pageNumber of [...unitsByPage.keys()].sort((a, b) => a - b)) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      // `page.objs`/`page.commonObjs` are empty until
      // `getOperatorList()` (or a render) has processed this page — this page
      // comes from a FRESH document open (`doc`), independent of the one used
      // for the inventory pass, so its `page.objs` was NEVER populated.
      // Without this call, EVERY `extractDirect` attempt (even for the
      // simplest, single image) fell back to a region render, even though
      // `has()` should have returned `true` — the same pattern as
      // `buildTextLayout.ts` (getOperatorList BEFORE getTextContent).
      const operatorList = await page.getOperatorList();
      checkAborted(signal);
      // Time left on this page for waiting on resources that are not registered yet (see `objectSettleTimeoutMs`).
      let settleBudgetMs = objectSettleTimeoutMs;
      // The id this document gave the resource that `entry` paints on this page (see `currentObjIdAt`).
      const idOnThisPage = (entry: ImageEntry): string | null => currentObjIdAt(operatorList, entry.occurrences.find((o) => o.page === pageNumber)?.index, entry.objId);
      for (const unit of unitsByPage.get(pageNumber)!) {
        checkAborted(signal);
        try {
          const isMasked = unit.memberEntries.some((e) => e.objId !== null && maskedObjIds.has(e.objId));
          const crossesText = textCrossesRegionEdge(unit.bbox, bodyBlockBoxesByPage.get(pageNumber));
          // Only probed when it can matter: the raw resource is considered for masked units and for
          // clusters whose region is cut by page text.
          const rep = unit.representativeEntry;
          const repId = rep ? idOnThisPage(rep) : null;
          const holderIds = rep?.objId ? (maskHoldersByTarget.get(rep.objId) ?? []).map(idOnThisPage) : [];
          const considersRaw = rep?.objId !== undefined && rep?.objId !== null && (isMasked || (crossesText && unit.clusterMemberCount > 1));
          let fitsPlacement = false;
          let maskMostlyVisible = false;
          if (rep && repId && considersRaw) {
            const needed = [repId, ...(isMasked ? holderIds : [])].filter((id): id is string => id !== null);
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, needed, settleBudgetMs);
            // The shape of the raw resource: known from the operator list without decoding it; the probe
            // is the fallback for the opcodes that do not carry it.
            const placed = rep.occurrences.find((o) => o.page === pageNumber)?.bbox;
            const rawSize =
              rep.intrinsicWidth !== null && rep.intrinsicHeight !== null ? { width: rep.intrinsicWidth, height: rep.intrinsicHeight } : await probeIntrinsicSizePx(page, repId);
            fitsPlacement = rawSize !== null && placed !== undefined && rawResourceFitsPlacement(rawSize, placed);
            // The mask of a masked picture is a resource of its own (it points at the picture); how much of
            // the picture it lets through decides whether the mask matters.
            if (fitsPlacement && isMasked) {
              const fractions = await Promise.all(holderIds.map((id) => (id === null ? Promise.resolve(null) : probeMeanBrightnessFraction(page, id))));
              maskMostlyVisible = fractions.length > 0 && fractions.every((f) => f !== null && f >= MASK_MOSTLY_VISIBLE_FRACTION);
            }
          }
          // Other pictures that make up the unit: a raw resource shows only one of them.
          // A member painted translucent (a watermark) is not a picture of its own and does not count.
          const coMemberAreaShare = unit.memberEntries.reduce((sum, m) => (m === rep || (m.maxOpacity !== undefined && m.maxOpacity <= CO_MEMBER_TRANSLUCENT_MAX_OPACITY) ? sum : sum + m.maxRelativeArea), 0);
          // Text that lies ON the picture (a paper note, a newspaper handout) is part of what the page shows.
          const placedRep = rep?.occurrences.find((o) => o.page === pageNumber)?.bbox;
          // Not for a full-bleed background the user asked to treat as content: its text is on top of it by
          // design, and the background without the text is what was asked for.
          const textOverPicture =
            unit.reason !== 'Z1-full-bleed-forced-content' &&
            (unit.reason.startsWith('Z10') || (placedRep !== undefined && textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)) >= TEXT_OVER_PICTURE_FRACTION));
          const decision = decideExtractionStrategy({
            entry: rep,
            isMasked,
            clusterMemberCount: Math.max(1, unit.clusterMemberCount),
            textCrossesRegionEdge: crossesText,
            rawResourceFitsPlacement: fitsPlacement,
            maskMostlyVisible,
            coMemberAreaShare,
            textOverPicture,
          });
          const objIdForExtraction = decision.strategy === 'direct' ? repId : null;

          // Region-render resolution is DERIVED from the native
          // resolution of the resources in the region, not from a constant —
          // see `renderResolution.ts`. Irrelevant for the `direct` strategy
          // (direct extraction always returns the full source resolution,
          // `targetLongEdgePx` is ignored there) — we probe only when
          // we're actually rendering a region.
          let effectiveTargetLongEdgePx = targetLongEdgePx;
          if (decision.strategy === 'region-render') {
            const intrinsicLongEdgesPx: number[] = [];
            for (const member of unit.memberEntries) {
              if (member.objId === null) continue;
              const longEdge = await probeIntrinsicLongEdgePx(page, idOnThisPage(member) ?? member.objId);
              if (longEdge !== null) intrinsicLongEdgesPx.push(longEdge);
            }
            effectiveTargetLongEdgePx = computeTargetLongEdgePx({
              intrinsicLongEdgesPx,
              representativeMaxRelativeArea: unit.representativeEntry?.maxRelativeArea ?? null,
              defaultLongEdgePx: targetLongEdgePx,
              maxLongEdgePx,
            });
          }

          const extractResult = await extractDirect(
            page,
            objIdForExtraction,
            unit.bbox,
            renderer,
            { targetLongEdgePx: effectiveTargetLongEdgePx, signal },
            pageNumber,
          );
          diagnostics.push(...extractResult.diagnostics);

          // Cropping the empty margin —
          // EXCLUSIVELY for units revealed by `Z1-full-bleed-forced-content`
          // (see `cropUniformMargins.ts`), NOT for ordinary content already
          // correctly extracted by the PDF's own structure (which already
          // has the right bbox — cropping its pixels would be pointless and
          // risky).
          let image = extractResult.image;
          if (autoCropUniformMargins && unit.reason === 'Z1-full-bleed-forced-content') {
            const bounds = detectContentBounds(image);
            if (bounds) {
              image = cropDecodedImage(image, bounds);
              // [at the user's request] EXCLUSIVELY for images actually
              // cropped on this line (`bounds` non-empty) — see the
              // rationale in `brightenImage.ts`. An image for which
              // `detectContentBounds` returned `null` (nothing sensible to
              // crop) does NOT go through this transformation.
              if (brightenAutoCroppedImages) image = brightenCroppedImage(image, AUTOCROP_BRIGHTEN);
            }
          }

          // [memory budget] hash + encode IMMEDIATELY; `extractResult.image`
          // (raw RGBA, up to 48MB for 4000x3000) is NOT kept around further —
          // only the hash + dimensions + already-compressed bytes go into `prepared`.
          const contentHash = await computeContentHash(image);
          // Computed ONLY for 'content' candidates — 'undecided'
          // is not subject to this reclassification (see `finalize.ts`), so
          // we save an extra pixel pass where it wouldn't be used anyway.
          const luminanceStdDev = unit.classification === 'content' ? computeLuminanceStdDev(image) : undefined;
          // [User request] For BOTH candidates shown in the review list — see `UNIFORM_COLOR_MIN_FRACTION` in `finalize.ts`.
          const uniformColorFraction = hideBackgroundImages ? computeUniformColorFraction(image) : undefined;
          const smoothness = hideBackgroundImages ? computeSmoothnessMetrics(image) : undefined;
          const opaqueFraction = hideBackgroundImages ? computeOpaqueFraction(image) : undefined;
          // Grid suggestion — NOT limited to 'content' (unlike
          // `luminanceStdDev` above): 'undecided' can also end up on stage by
          // the user's manual decision in the review screen), and the cost of
          // computing it is negligible relative to the decode already
          // performed anyway.
          const suggestedGrid = detectGrid(image) ?? undefined;
          const encoded = await encoder.encode(image, { format: opts.outputFormat, quality: opts.outputQuality });

          const entryForFinalize = unit.representativeEntry ?? syntheticVectorOnlyEntry(pageNumber, unit.bbox);
          // A purely vector region forced to 'content' (line
          // above) is a deliberate, confident decision (a successful render
          // of a vector-drawn map) — it gets high confidence, NOT the lower
          // `undecided` confidence inherited from `unit.confidence` (which
          // described something else: "no image to extract directly").
          const confidence = unit.representativeEntry ? unit.confidence : confidenceForReason('Z1-large-relative-area');
          prepared.push({
            entry: entryForFinalize,
            classification: unit.representativeEntry ? unit.classification : 'content',
            confidence,
            extractSource: extractResult.source,
            contentHash,
            width: image.width,
            height: image.height,
            luminanceStdDev,
            uniformColorFraction,
            smoothness,
            opaqueFraction,
            suggestedGrid,
            payload: encoded,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          diagnostics.push({
            severity: 'error',
            code: 'IMAGE_EXTRACTION_FAILED',
            params: { objId: unit.representativeEntry?.objId ?? '(vector-region)', error: err instanceof Error ? err.message : String(err) },
            pageNumber,
          });
        }
        done++;
        onProgress?.(done, total);
      }
    } finally {
      page.cleanup();
    }
  }

  const finalized = finalizeImages(prepared, nearStatblockOrHeadingObjIds, diagnostics);

  return {
    images: finalized.images,
    correlationClosedByBBox: finalized.correlationClosedByBBox,
    correlationClosedByHash: finalized.correlationClosedByHash,
    duplicatesRemoved: finalized.duplicatesRemoved,
    diagnostics,
  };
}
