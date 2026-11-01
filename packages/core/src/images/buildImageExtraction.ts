import { clusterByOverlap } from '../clustering.js';
import { overlapRatio, rectArea, rectIntersection, relativeArea, unionRect, type Matrix, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion, VectorShape } from '../inventory/vectorRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { classifyImages, confidenceForReason, FLUSH_UNDECIDED_REASON, LARGE_MASKED_CUTOUT_REASON, TEXT_BESIDE_BLENDED_REASON, TEXT_OVER_SMALL_REASON, LARGE_TRANSLUCENT_PANEL_REASON, EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, isBackdropShape, isTranslucentEverywhere, maxBleedOverhangPt, type ClassifiedImage, type ImageClassification } from './classify.js';
import { AUTOCROP_BRIGHTEN, brightenCroppedImage } from './brightenImage.js';
import { cardOfPiece, cardWithoutPictures } from './cardBesidePictures.js';
import { looksLikeTrackOfBoxes } from './boxGrid.js';
import { looksLikeInkSplatter } from './inkSplatter.js';
import { isFormOrTable, isPartOfSheet, looksLikeDocument, looksLikeDocumentOnDark, looksLikeLargePrintNote, measureRasterText } from './rasterText.js';
import { shrinkToCenter } from './classify.js';
import { applyClipToImage, clipShowsWholePicture, renderThroughRectangularClip } from './clipMask.js';
import { cropDecodedImage, detectContentBounds } from './cropUniformMargins.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder, OutputFormat } from './encodeImage.js';
import { isBlankSheet, looksLikeWhiteWash } from './blankSheet.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { mirrorImage, rotateQuarterTurns } from './rotateQuarterTurns.js';
import { eraseNumberMarkers } from './numberMarkers.js';
import { findSpreadPairs } from './spreadPairs.js';
import { dropLeftColumns, stitchHorizontally } from './stitchHorizontally.js';
import { halvesContinueAcrossSeam } from './spreadSeam.js';
import { findVectorFigures } from './vectorFigures.js';
import { eraseTextAroundFigure } from './eraseFigureText.js';
import { drawnShare, isBareDarkTexture, isColorfulPicture, isDrawingOnPanel, isPanelBackdrop, PANEL_MIN_TEXT_COVERAGE, PANEL_PREVIEW_LONG_EDGE_PX, PANEL_FRAMES_PICTURE_MIN_SHARE, PANEL_OVERLAY_MIN_OPAQUE_FRACTION } from './panelBackdrop.js';
import { FULL_EXTENT_BOUNDS, tightenToVisible } from './opaqueBounds.js';
import { connectedGroups, placedInksOverlap, placedMasksOverlap, type PlacedMask } from './opaqueOverlap.js';
import { currentObjIdAt, extractDirect, probeIntrinsicLongEdgePx, probeIntrinsicSizePx, probeMaskRectangularity, probeMeanBrightnessFraction, probeInkMask, probeOpaqueBounds, probeOpaqueMask, probeOpaquePixelStats, probeRawLook, probeOpaqueFraction, waitForObjects, type PdfPageForExtract } from './extract.js';
import { computeContentHash, computeDarkOpaqueShare, computeWhiteOpaqueShare, computeLuminanceStdDev, computeVisibleLuminanceStdDev, computeVisibleMeanLuminance, computeOpaqueFraction, computeUniformColorFraction, computeSmoothnessMetrics, finalizeImages, isNeverWorthReviewing, type FinalizedImage, type PreparedEntryForFinalize } from './finalize.js';
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
  /** The filled paths that are not rectangles (see `VectorShape`); without them no vector drawing is looked for. */
  shapes?: readonly VectorShape[];
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
  /** Bboxes of the `heading` blocks per page: a plate whose only text is headings (a banner with the title of a chapter) is told from a box of text with them. */
  headingBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
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
  /**
   * Also look for drawings made of vector paths (a cartoon figure, a diagram, a logo) and offer them as undecided pictures (see `vectorFigures.ts`).
   * Needs the inventory's `shapes`. Off by default: without it only rasters and the big rectangular fills of maps are offered.
   */
  includeVectorFigures?: boolean;
  /**
   * Paint over the numbered markers of a map (black discs with a white number in them) in every extracted picture that has at least three of
   * them (see `numberMarkers.ts`). Off by default.
   */
  removeNumberMarkers?: boolean;
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
/** The reason of a picture that page text covers in its middle (see `classify.ts`). */
const HIGH_TEXT_COVERAGE_REASON = 'Z10-high-center-text-coverage';
/** The classifier's reason for a picture that the page's body text covers (taken for a backdrop). */
const TEXT_COVERED_BACKDROP_REASON = 'Z9-high-body-text-coverage';
/** A box of a text-covered picture that is a note, not a page background: its share of the page at most. */
const NOTE_MAX_AREA = 0.3;
/** The share of a piece's box that the page's text crosses the edge of, from which the piece is cut out of a larger note. */
const NOTE_PIECE_MIN_TEXT_CROSSING = 0.5;
/** A picture of at least this page-area share, offered by itself, is cut away from the card of text it lies over (see `cardWithoutPictures`). */
/**
 * A raster of a unit that is only offered because page text lies over its box is a photo with notes pinned over it (a cork board), not a card of text, when it is dark on the whole
 * and has a picture's texture, and the text is not over its middle. Measured on one rulebook: the cards of text have a mean luminance of 217-233, the photos 45-116 with a texture
 * deviation of 15-41 and 0.22-0.43 of their middle under text; the empty dark backdrops of cards in other books (a green stone, a grey plate) have a deviation of 1-16 or 0.59-0.92 of
 * their middle under text.
 */
const PHOTO_UNDER_TEXT_MAX_MEAN_LUMINANCE = 170;
/** A plain card of text this light is paper (measured: 198-236 for the cards of text of one rulebook, 71-139 for the maps with labels). */
const PAPER_CARD_MIN_MEAN_LUMINANCE = 170;
/** A raster that is not one of the notes pinned on a photo and that the page labels (a map) is taken raw only when it is lighter than a black shape: the raw of a photo on black is a black shape, which is hidden. Measured: the maps 71-139, the black polaroid photo 27. */
const MAP_UNDER_LABELS_MIN_MEAN_LUMINANCE = 60;
/** A note on light paper whose middle the page's text covers this much is a box of text, whatever the texture of its torn edges and stains (a card with a raw deviation of 40 and 0.81 of its middle under text). */
const PAPER_NOTE_MIN_CENTER_COVERAGE = 0.5;
const PHOTO_UNDER_TEXT_MIN_STDDEV = 10;
const PHOTO_UNDER_TEXT_MAX_CENTER_COVERAGE = 0.5;

export function isPhotoUnderNotes(look: { meanLuminance: number; luminanceStdDev: number } | null, centerTextCoverage: number): boolean {
  return look !== null && look.meanLuminance < PHOTO_UNDER_TEXT_MAX_MEAN_LUMINANCE && look.luminanceStdDev >= PHOTO_UNDER_TEXT_MIN_STDDEV && centerTextCoverage <= PHOTO_UNDER_TEXT_MAX_CENTER_COVERAGE;
}
const PICTURE_OVER_CARD_MIN_AREA = 0.05;
/**
 * A banner: a flat plate (a title of a chapter on a band of colour) whose only text is headings. At least this share of its box is under the page's text and at least this much of that text is
 * headings, on a raster whose own pixels have no texture (a deviation of at most `BANNER_MAX_RAW_STDDEV`; the art that a title is laid over has far more, and so have the handwritten notes whose
 * lines the layout takes for headings: 9-20). Measured on the four chapter banners of one rulebook (0.43-0.54 under text, all of it headings, a blank raster under them) and on the box of text beside
 * them (0.54 under text, 0.05 of it headings), and on a banner with a warning on a dark plate (deviation 4.8).
 */
const BANNER_MIN_TEXT_COVERAGE = 0.3;
const BANNER_MIN_HEADING_SHARE = 0.9;
const BANNER_MAX_RAW_STDDEV = 6;

/** Whether the page's text over a plate, and the share of it that is headings, are those of a banner (see `BANNER_MIN_TEXT_COVERAGE`). */
export function isHeadingBannerText(textOverPlate: number, headingsOverPlate: number): boolean {
  return textOverPlate >= BANNER_MIN_TEXT_COVERAGE && headingsOverPlate >= BANNER_MIN_HEADING_SHARE * textOverPlate;
}
/**
 * A card of the page that is painted later and overlaps this share of a card's box lies over it: the render shows that card on this one, and the visible part of this one is what the clips leave.
 * Measured: the two cards that are covered that much by a later card (a note under a larger note, a card under a banner) 0.43-0.45; the cards that touch their neighbours at their edges only 0.01-0.26,
 * whose own clip would cut away their own writing. A picture bigger than the limit is a backdrop, not a neighbour.
 */
const NEIGHBOUR_CARD_MIN_OVERLAP = 0.4;
const NEIGHBOUR_CARD_MAX_AREA = 0.6;
/** A cut that leaves less than this share of the render's pixels is a mistake of the clip, not the card's shape. */
const CLIP_CUT_MIN_REMAINING_SHARE = 0.25;
/** The share of the middle of a panel's box that the page's text covers from which the text lies ON the panel (a note), not beside it (a cut-out the text wraps around). */
const TEXT_PANEL_CENTER_MIN_COVERAGE = 0.4;
/** A clip with more points than this is the outline of a subject, not the frame of a note (whose torn edge has a few points). */
const CUT_OUT_OUTLINE_MIN_POINTS = 12;
/** A raster this dark and this even (measured: mean 7.7, spread 1.2 for a shadow laid over a page; dark paintings and figures in black are well above both) shows nothing of its own. */
const DARK_CUTOUT_MAX_MEAN_LUMINANCE = 20;
const DARK_CUTOUT_MAX_STDDEV = 5;
/** The share of a render's box, and of its middle, that the page's text covers from which the render is a box of text whatever its look (a newspaper). */
const TEXT_FILLS_BOX_MIN_COVERAGE = 0.6;
/** Share of the largest picture split off from a unit from which another picture of the unit is split off too, however small it is. */
const SPLIT_PEER_MIN_SHARE = 0.75;

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
/** Page-area share from which the largest raster of a unit can be a wash or a card that the unit's small pictures lie on. */
const UNDER_PICTURES_MIN_AREA = 0.05;
/** Share of opaque pixels below which a picture is a cut-out object on a transparent ground (a figure, an item) and not a photo. */
const CUT_OUT_MAX_OPAQUE_FRACTION = 0.6;
/** Share of a plain card that page text must cover for the card to be one the text lies on (the cards of items have a line or two of it). */
const CARD_UNDER_PICTURES_MIN_TEXT_COVERAGE = 0.03;
/** A card of items is small (the cards of one rulebook are 7% of the page), light paper, and has items of consequence on it, not a speck or a crest. */
const CARD_UNDER_PICTURES_MAX_AREA = 0.1;
const CARD_UNDER_PICTURES_MIN_LUMINANCE = 200;
const CARD_ITEM_MIN_AREA = 0.02;
/** A flush card of text (a stat block on parchment) is opaque over this share and has at least this share of its box covered by text. */
const FLUSH_CARD_MIN_OPAQUE_FRACTION = 0.85;
const FLUSH_CARD_MIN_TEXT_COVERAGE = 0.15;
/** Share of the box of a rendered image that page text must cover for the image to be a panel of text (measured on one rulebook: its panels of text are 18%-90%, its pictures and drawings with captions 0%-6%). */
const TEXT_PANEL_HIDE_MIN_COVERAGE = 0.15;
/** The raster of a panel of text is a smooth, almost colorless gradient (measured on one rulebook: a luminance spread of 8-27 and a saturation of 5-31 on all its 192 panels). */
const TEXT_PANEL_MAX_RAW_STDDEV = 30;
const TEXT_PANEL_MAX_RAW_SATURATION = 32;
/** A tinted panel (parchment, dark green) is smooth too: it is told from a picture by the book repeating its look (see `repeatedPanelLooks`), not by its color alone (measured: the cards of one rulebook 11-34 and the pictures with captions from 45). */
/** The text coverage from which a render can be a tinted panel (the cards of a layout carry a few lines of text: 10%-60% of their box measured on one rulebook, its pictures with captions below 8%). */
const TEXT_PANEL_STYLE_MIN_COVERAGE = 0.08;
const TEXT_PANEL_TINTED_MAX_RAW_STDDEV = 36;
const TEXT_PANEL_TINTED_MAX_RAW_SATURATION = 140;
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
/**
 * A plain panel with a stat block on it (a character card): its raster is a smooth, opaque sheet and the text on it
 * is the point. Measured on a real rulebook: the cards cover 26%-38% of their panel with text, one card to a page, on a
 * raster with a luminance spread of 22 (a picture with something in it has 40 and more, a cut-out figure is half
 * transparent). A limit of 30% alone took some cards for bare panels and not others.
 */
const TEXT_PANEL_MIN_TEXT_COVERAGE = 0.15;
const TEXT_PANEL_MAX_STDDEV = 30;
const TEXT_PANEL_MIN_OPAQUE_FRACTION = 0.9;
/** A card is a part of a page; a smooth sheet that fills most of it is the page's own background, with the text of the page on it. */
const TEXT_PANEL_MAX_AREA = 0.8;
/** Share of opaque pixels below which a picture that fills a third of the page or more and is cut out by a mask is a sparse decoration (measured: blood splatters 8%-30%; the illustrations of the same books are opaque all over). */
const LARGE_CUTOUT_MIN_OPAQUE_FRACTION = 0.5;
/** Page-area share from which a picture that reaches the gutter may be one half of a picture across a spread. */
const SPREAD_HALF_MIN_AREA = 0.08;
/** Share of each of two pictures' boxes that their overlap must cover for the two to lie in the same place. */
const SAME_FOOTPRINT_MIN_SHARE = 0.9;
/** A small picture that is less than this share on the representative, next to a representative of at least `BESIDE_MIN_REPRESENTATIVE_AREA` of the page, is decoration beside it. */
const BESIDE_MAX_SHARE_ON_REPRESENTATIVE = 0.5;
const BESIDE_MIN_REPRESENTATIVE_AREA = 0.2;
/** A flush strip at least this long for its width, beside a representative of at least this share of the page, is the layout's margin. */
const EDGE_STRIP_MIN_ASPECT = 3;
const EDGE_STRIP_MIN_REPRESENTATIVE_AREA = 0.3;
/** Share of the box of a flush picture beside a big representative that page text must cover for the picture to be the backdrop of that text. */
const TEXT_BACKDROP_MIN_COVERAGE = 0.08;

/** Whether a flush raster is a card of text that fills a page margin: plain, opaque, with at least `FLUSH_CARD_MIN_TEXT_COVERAGE` of its box covered by page text (a stat block on parchment). */
export function isFlushCardOfText(look: { luminanceStdDev: number } | null, opaqueFraction: number | null, textCoverageOverCard: number): boolean {
  return look !== null && look.luminanceStdDev <= TEXT_PANEL_MAX_STDDEV && opaqueFraction !== null && opaqueFraction >= FLUSH_CARD_MIN_OPAQUE_FRACTION && textCoverageOverCard >= FLUSH_CARD_MIN_TEXT_COVERAGE;
}

/** Whether an image that was rendered with the page's text on it is a panel of text (a sidebar, a list, a box of rules) and not a picture: that much of its box is covered by page text. */
export function isTextPanel(source: string, textCoverageOverImage: number): boolean {
  return source === 'region-render' && textCoverageOverImage >= TEXT_PANEL_HIDE_MIN_COVERAGE;
}

/** Whether a raster is a small card of light paper that page text lies on (the cards of items of a rulebook): small, light, plain and opaque, with some text over it. */
export function isSmallCardOfText(area: number, look: { meanLuminance: number; luminanceStdDev: number } | null, opaqueFraction: number | null, textCoverageOverCard: number): boolean {
  return area <= CARD_UNDER_PICTURES_MAX_AREA && look !== null && look.meanLuminance >= CARD_UNDER_PICTURES_MIN_LUMINANCE && looksLikePlainTextCard(look, opaqueFraction) && textCoverageOverCard >= CARD_UNDER_PICTURES_MIN_TEXT_COVERAGE;
}

/** True for a small picture (below the significant share of the page) that lies mostly outside a representative of consequence. */
export function isSmallPieceBesideRepresentative(memberBox: Rect, memberArea: number, representativeBox: Rect, representativeArea: number): boolean {
  if (memberArea >= CO_MEMBER_SIGNIFICANT_AREA || representativeArea < BESIDE_MIN_REPRESENTATIVE_AREA || rectArea(memberBox) <= 0) return false;
  const shared = rectIntersection(representativeBox, memberBox);
  return shared === null || rectArea(shared) < BESIDE_MAX_SHARE_ON_REPRESENTATIVE * rectArea(memberBox);
}

/** True for a box at least `EDGE_STRIP_MIN_ASPECT` times as long as it is wide: a strip along the page edge. */
export function isLongStrip(box: Rect): boolean {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  return Math.min(w, h) > 0 && Math.max(w, h) / Math.min(w, h) >= EDGE_STRIP_MIN_ASPECT;
}

/** True for a picture that lies mostly outside the representative and has page text over at least `TEXT_BACKDROP_MIN_COVERAGE` of its box: the backdrop of that text. */
export function isBackdropOfTextBesideRepresentative(memberBox: Rect, representativeBox: Rect, textCoverageOfMember: number): boolean {
  const shared = rectIntersection(representativeBox, memberBox);
  if (shared !== null && rectArea(shared) >= BESIDE_MAX_SHARE_ON_REPRESENTATIVE * rectArea(memberBox)) return false;
  return textCoverageOfMember >= TEXT_BACKDROP_MIN_COVERAGE;
}

/** Whether the raw pixels of a panel are those of a plain card the page puts its text on: smooth and opaque (see `TEXT_PANEL_MAX_STDDEV`). */
export function looksLikePlainTextCard(look: { luminanceStdDev: number } | null, opaqueFraction: number | null): boolean {
  return look !== null && look.luminanceStdDev <= TEXT_PANEL_MAX_STDDEV && opaqueFraction !== null && opaqueFraction >= TEXT_PANEL_MIN_OPAQUE_FRACTION;
}

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
 * Whether the text that lies over a unit's picture is part of what the picture shows (a paper note, a
 * newspaper handout: the page draws the text, the resource is blank paper), so that the region has to be
 * rendered to get it. Not the case for:
 * - a full-bleed background the user asked to treat as content: its text is on top of it by design, and the
 *   background without the text is what was asked for;
 * - a picture that bleeds off the page and was kept (`Z12-bleeding-no-center-text-evidence`): the classifier
 *   has already established that the centre of such a picture is clear of text, so the text that overlaps
 *   its bbox sits at its edges or on the part that is off the page (a splatter or a stain under the page's
 *   own text, not a note with writing on it);
 * - a picture painted translucent everywhere (a watermark crest or emblem behind a quotation or a text
 *   column): the text belongs to the page and the emblem is the picture. A render of the region gives the
 *   faded emblem with the whole text column on it, the raw resource gives the emblem.
 */
export function isTextOverPicture(unitReason: string, representative: ImageEntry | null, placed: Rect | undefined, textBoxes: readonly Rect[] | undefined): boolean {
  if (unitReason === 'Z1-full-bleed-forced-content' || unitReason === 'Z12-bleeding-no-center-text-evidence' || unitReason === FLUSH_UNDECIDED_REASON || unitReason === LARGE_MASKED_CUTOUT_REASON || unitReason === TEXT_BESIDE_BLENDED_REASON) return false;
  if (representative !== null && isTranslucentEverywhere(representative)) return false;
  return unitReason.startsWith('Z10') || (placed !== undefined && textCoverage(placed, textBoxes) >= TEXT_OVER_PICTURE_FRACTION);
}

/**
 * What a picture must be for its region to be cut to the visible part (see `tightenToVisible`): a note, not line art
 * or a faded figure. Measured on four real rulebooks: the parchment notes are 56%-100% visible and the page's text
 * covers 56%-86% of their visible part; the sketches drawn in alpha are 7%-35% visible, and the faded figure whose
 * white fade runs under a text column is covered 39%.
 */
const TIGHTEN_MIN_OPAQUE_FRACTION = 0.4;
const TIGHTEN_MIN_TEXT_COVERAGE = 0.5;
/**
 * ...and the cut has to take page text out of the region: the text beside the visible part must be at least this share
 * of the box. Measured: 8%-16% for the notes that sit beside a text column, 0%-0.3% for notes whose box only holds a
 * torn margin (cutting those only crops the edge of the paper).
 */
const TIGHTEN_MIN_TEXT_BESIDE_SHARE = 0.03;

/**
 * Share of the unit's area that text blocks cut by its edge must cover before the raw image resource
 * is preferred over a render of the region. Measured on a real rulebook whose pictures sit under
 * text panels: the units with a visible slice of the page's text had 1.4%-19%; 1% catches a single cut
 * line across the width of a picture while ignoring a block that merely brushes the edge.
 */
const TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION = 0.01;

/**
 * Share of a picture's box that text blocks cutting its edge cover, from which the text is the page's own text running past the picture and
 * not the writing on it (a note's text lies inside the note): the picture is taken from its own pixels.
 */
const TEXT_RUNS_PAST_PICTURE_MIN_SHARE = 0.15;

/**
 * Whether body/caption blocks that the unit's bbox CUTS (they reach outside it) cover enough of it. Such
 * a block belongs to the surrounding page layout — a render of the region would slice it into the
 * picture. A block lying entirely INSIDE the bbox (a label on a map, a caption inside a frame) is
 * judged to belong to the picture's own composition and is not counted.
 */
export function textCrossingShare(bbox: Rect, textBoxes: readonly Rect[] | undefined): number {
  if (!textBoxes || textBoxes.length === 0) return 0;
  const area = rectArea(bbox);
  if (area <= 0) return 0;
  let crossing = 0;
  for (const t of textBoxes) {
    const inter = rectIntersection(bbox, t);
    if (!inter) continue;
    const inside = t.minX >= bbox.minX && t.maxX <= bbox.maxX && t.minY >= bbox.minY && t.maxY <= bbox.maxY;
    if (!inside) crossing += rectArea(inter);
  }
  return crossing / area;
}

function textCrossesRegionEdge(bbox: Rect, textBoxes: readonly Rect[] | undefined): boolean {
  return textCrossingShare(bbox, textBoxes) >= TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION;
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
 * deliberately hides half of a picture is far below. A mask that is a tilted rectangle may pass with less,
 * see `maskLetsMostThrough`.
 */
const MASK_MOSTLY_VISIBLE_FRACTION = 0.8;

/**
 * A mask that is a rotated rectangle only tilts or trims the picture, however much of its raster that leaves
 * black: a print tilted by 10 degrees is white over about 0.75 of its mask, one tilted by 15 degrees over
 * 0.67. Measured on a second real rulebook with strongly tilted prints: the masks of 17 such photos are white
 * over 0.72-0.80 of the raster and fill 0.95-0.99 of their smallest enclosing rectangle, while every other
 * mask that lets less than 0.8 through (a silhouette, a torn edge, a small window) fills 0.04-0.47 of it
 * (an ellipse would give 0.785). The floor on the white share keeps out a rectangular window that hides most
 * of the picture.
 */
const MASK_TILTED_RECTANGLE_MIN_FRACTION = 0.6;
const MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY = 0.9;
/**
 * The tilted-rectangle allowance is for photos only: a paper note cut out by the same kind of mask carries
 * the page's own text, which the raw resource does not have. Page text covers up to 14% of the photos that
 * were measured (a caption touching a corner) and 25% of the one paper note, so the allowance stops at 20%
 * (the stricter 30% of `TEXT_OVER_PICTURE_FRACTION` still decides what is rendered as text over a picture).
 */
const MASK_TILTED_RECTANGLE_MAX_TEXT_COVERAGE = 0.2;

/**
 * A figure cut out by a silhouette mask and stood against the edge of the page overhangs it by a point or two, which
 * the bleed rules take for a paper scrap, a stain or a shadow that runs off the page, or for a background with text on
 * it (those are hidden). Such a picture
 * is looked at once more: when its mask is a silhouette (it fills less than 0.9 of its smallest enclosing rectangle,
 * as a tilted print does; measured on a real rulebook: 0.23-0.72 for the figures cut out against the page edge) and the picture has more than one color it is a figure and
 * is offered; a rectangular mask (a print pinned at the edge) or a flat color (a splatter) keeps the old verdict. Real bleed overhangs the page mostly by 8-19 pt.
 */
const EDGE_FIGURE_MAX_OVERHANG_PT = 3;
const EDGE_FIGURE_REASON = 'Z21-masked-silhouette-at-page-edge';
const SILHOUETTE_MAX_RECTANGULARITY = MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY;
/**
 * What stands against the page edge as a silhouette may also be a splatter, a smear of smoke or a patch of ink (one
 * color, only the alpha varies), or a faded paper vignette. Measured on three real rulebooks, the luminance spread of
 * the visible pixels is 0.4-3.3 for the former, 16-19 for the latter and 36-62 for figures and emblems. Page-sized
 * results (a backdrop) are rendered, not taken raw, and are not offered.
 */
const EDGE_FIGURE_MIN_STDDEV = 25;

/** Whether a mask that is white over `whiteFraction` of its raster and has the given rectangularity lets most of the picture through. */
export function maskLetsMostThrough(whiteFraction: number, rectangularity: number | null): boolean {
  if (whiteFraction >= MASK_MOSTLY_VISIBLE_FRACTION) return true;
  return rectangularity !== null && whiteFraction >= MASK_TILTED_RECTANGLE_MIN_FRACTION && rectangularity >= MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY;
}

/** The shape is only measured when it can change the verdict: a mask below the floor or already mostly white is decided by its white share. */
async function maskResourceLetsMostThrough(page: PdfPageForExtract, maskObjId: string, tiltedRectangleAllowed: boolean): Promise<boolean> {
  const fraction = await probeMeanBrightnessFraction(page, maskObjId);
  if (fraction === null) return false;
  if (!tiltedRectangleAllowed || fraction >= MASK_MOSTLY_VISIBLE_FRACTION || fraction < MASK_TILTED_RECTANGLE_MIN_FRACTION) return maskLetsMostThrough(fraction, null);
  return maskLetsMostThrough(fraction, await probeMaskRectangularity(page, maskObjId));
}

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
  // A big translucent panel that is only let through to be checked for a drawing stands alone too: joined to the pictures on top of it, it would take them with it when it is hidden.
  // A small picture offered only because text lies over its box (a card, or an object on a card) stands alone too: it is judged by its own pixels and does not take over the unit of the pictures beside it.
  return c.reason === 'Z12-bleeding-no-center-text-evidence' || c.reason === LARGE_TRANSLUCENT_PANEL_REASON || c.reason === LARGE_MASKED_CUTOUT_REASON || c.reason === TEXT_OVER_SMALL_REASON;
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
 * with a note laid over its corner, three figures standing in a row — is split into one unit per picture.
 * Rendering their union gives a region of the page (the pictures, the text and the margin between them); taking
 * one raw resource would drop the others from every list. Only solid pictures that cover a real share of the
 * page count as pictures of their own: the faint shapes behind figures and the tape, crests and paperclips
 * that sit on them are not pictures, and stay out (or with the picture they are on), as before. Pictures that are
 * not masked cut-outs are told apart only when faint backdrops show that the page is a layout of figures on panels
 * and not a composition (a collage of pinned photos, a print with a note over its corner).
 */
/** Page-area share from which a picture painted slightly translucent is a card of the page's layout rather than a picture. */
const LAYOUT_CARD_MIN_AREA = 0.25;

/**
 * The frame of a card of text (a box of rules on parchment) has ornaments that straddle its edge: a title plaque across the top, a flourish
 * across the bottom. The card's own box cuts them in half. A piece that mostly lies over the card's width, reaches past its edge by a few
 * points and has a good part of itself inside it belongs to the card.
 */
const ORNAMENT_MIN_INSIDE_SHARE = 0.3;
const ORNAMENT_MIN_WIDTH_INSIDE_SHARE = 0.8;
const ORNAMENT_MAX_REACH_PT = 50;
/** A piece that sticks out at the sides further than this is a band of the page (a footer), not an ornament of the card. */
const ORNAMENT_MAX_SIDE_REACH_PT = 25;
/** Ornaments are small pieces: a page-area share above which a decoration is not one. */
const ORNAMENT_MAX_AREA = 0.05;

/** Pieces that come within this distance of the edge of the page are its header or footer, not an ornament of a card. */
const ORNAMENT_PAGE_MARGIN_PT = 30;

/**
 * `bbox` grown to take in the pieces that straddle its top or bottom edge (see `ORNAMENT_MIN_INSIDE_SHARE`). `pageBox` is the page the
 * card is on: a piece reaching into its margin (a running header or footer) is left out.
 */
export function extendToEdgeOrnaments(bbox: Rect, pieces: readonly Rect[], pageBox: Rect | undefined): Rect {
  let result = bbox;
  const printable = pageBox === undefined ? undefined : { minX: pageBox.minX + ORNAMENT_PAGE_MARGIN_PT, minY: pageBox.minY + ORNAMENT_PAGE_MARGIN_PT, maxX: pageBox.maxX - ORNAMENT_PAGE_MARGIN_PT, maxY: pageBox.maxY - ORNAMENT_PAGE_MARGIN_PT };
  for (const piece of pieces) {
    if (printable !== undefined && (piece.minY < printable.minY || piece.maxY > printable.maxY)) continue;
    const pieceArea = rectArea(piece);
    const shared = rectIntersection(bbox, piece);
    if (pieceArea <= 0 || shared === null) continue;
    const sharedShare = rectArea(shared) / pieceArea;
    const widthInside = (shared.maxX - shared.minX) / (piece.maxX - piece.minX);
    const reach = Math.max(bbox.minY - piece.minY, piece.maxY - bbox.maxY, 0);
    const crossesVerticalEdge = piece.minY < bbox.minY || piece.maxY > bbox.maxY;
    const sideReach = Math.max(bbox.minX - piece.minX, piece.maxX - bbox.maxX, 0);
    if (sharedShare < ORNAMENT_MIN_INSIDE_SHARE || sharedShare >= 0.999 || widthInside < ORNAMENT_MIN_WIDTH_INSIDE_SHARE || !crossesVerticalEdge || reach > ORNAMENT_MAX_REACH_PT || sideReach > ORNAMENT_MAX_SIDE_REACH_PT) continue;
    result = unionRect(result, piece);
  }
  return result;
}

/**
 * Page-area share from which a MASKED picture of a unit counts when judging whether the unit holds several pictures, in a unit whose
 * representative is a picture of `SPLIT_BANNER_REPRESENTATIVE_MIN_AREA` of the page or more (a full-page illustration under a title banner).
 * Lower than `CO_MEMBER_SIGNIFICANT_AREA`: the pieces of a banner (a left cap, a plaque, a right cap, each cut out by a mask) grow with the title
 * they carry, and the same layout gave 6.8% on one page and 4.98% on the next; the tape and crests it must not count measure up to 4.4%.
 */
const SPLIT_BANNER_MASKED_MIN_AREA = 0.045;
const SPLIT_BANNER_REPRESENTATIVE_MIN_AREA = 0.5;

/**
 * Share of a picture's own box that the page's text must cover for the picture to be a card of text (a parchment with a stat block on it). A
 * portrait with a caption line or a paragraph touching it stays well below this; the cards measured on a real adventure are at 38%.
 */
const SPLIT_TEXT_CARD_MIN_COVERAGE = 0.3;
/** A picture that a card of text is told apart from is a picture of consequence (a portrait), not a clip or a tape: at least this share of the page. */
const SPLIT_TEXT_CARD_PICTURE_MIN_AREA = 0.1;
/** A picture lying this far on the card (a photo on a newspaper clipping, a signature on a sheet) is part of it: the card is left whole. */
const SPLIT_TEXT_CARD_MAX_PICTURE_ON_CARD = 0.8;

/** Share of the smaller of two frames that they may overlap by and still be two pictures. */
const FRAMES_MAX_OVERLAP_SHARE = 0.25;
/** Two pictures without frames: the boxes of their rasters may overlap by this share of the smaller one (neighbors that touch) and still be two pictures. */
const BOXES_MAX_OVERLAP_SHARE = 0.1;

/** The outline (a polygon, flat x/y pairs) of the frame (the clip) a picture is shown in on `page`, or undefined when it is not shown in one. */
function visibleWindow(entry: ImageEntry, page: number): readonly number[] | undefined {
  const polygon = entry.occurrences.find((o) => o.page === page)?.clip?.paths[0]?.[0];
  return polygon === undefined || polygon.length < 6 ? undefined : polygon;
}

function polygonArea(polygon: readonly number[]): number {
  let twice = 0;
  for (let i = 0, j = polygon.length / 2 - 1; i < polygon.length / 2; j = i++) twice += polygon[2 * j]! * polygon[2 * i + 1]! - polygon[2 * i]! * polygon[2 * j + 1]!;
  return Math.abs(twice) / 2;
}

/** The part of `subject` that lies inside the convex polygon `clip` (Sutherland-Hodgman), as flat x/y pairs. */
function clipPolygon(subject: readonly number[], clip: readonly number[]): number[] {
  let output = [...subject];
  const n = clip.length / 2;
  let orientation = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const k = (i + 2) % n;
    orientation += (clip[2 * j]! - clip[2 * i]!) * (clip[2 * k + 1]! - clip[2 * j + 1]!) - (clip[2 * j + 1]! - clip[2 * i + 1]!) * (clip[2 * k]! - clip[2 * j]!);
  }
  const sign = orientation >= 0 ? 1 : -1;
  for (let i = 0; i < n && output.length > 0; i++) {
    const j = (i + 1) % n;
    const ax = clip[2 * i]!;
    const ay = clip[2 * i + 1]!;
    const bx = clip[2 * j]!;
    const by = clip[2 * j + 1]!;
    const inside = (x: number, y: number) => sign * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) >= 0;
    const input = output;
    output = [];
    for (let p = 0; p < input.length / 2; p++) {
      const q = (p + input.length / 2 - 1) % (input.length / 2);
      const cx = input[2 * p]!;
      const cy = input[2 * p + 1]!;
      const px = input[2 * q]!;
      const py = input[2 * q + 1]!;
      if (inside(cx, cy) !== inside(px, py)) {
        const denominator = (px - cx) * (by - ay) - (py - cy) * (bx - ax);
        if (denominator !== 0) {
          const t = ((ax - cx) * (by - ay) - (ay - cy) * (bx - ax)) / denominator;
          output.push(cx + t * (px - cx), cy + t * (py - cy));
        }
      }
      if (inside(cx, cy)) output.push(cx, cy);
    }
  }
  return output;
}

/** Tiles of one picture (a page-wide illustration cut into rasters) lie edge to edge: the boxes may overlap by this much (in points) at a seam, or be this far apart. */
const TILE_SEAM_MAX_OVERLAP_PT = 1.5;
const TILE_SEAM_MAX_GAP_PT = 0.5;
/** The seam runs along this share of the shorter side of the two tiles. */
const TILE_SEAM_MIN_ALIGNED_SHARE = 0.9;
/** The tiles of one picture have the same pixel density (a collage of different pictures hardly ever does): the densities differ by at most this share. */
const TILE_MAX_DENSITY_DIFFERENCE = 0.05;

export interface TileSource {
  box: Rect;
  pixelWidth: number;
  pixelHeight: number;
}

/** True when the two rasters meet at a seam: edge to edge along one axis, aligned along the other, and of the same pixel density. */
export function areSeamedTiles(a: TileSource, b: TileSource): boolean {
  const widthA = a.box.maxX - a.box.minX;
  const heightA = a.box.maxY - a.box.minY;
  const widthB = b.box.maxX - b.box.minX;
  const heightB = b.box.maxY - b.box.minY;
  if (widthA <= 0 || heightA <= 0 || widthB <= 0 || heightB <= 0 || a.pixelWidth <= 0 || a.pixelHeight <= 0 || b.pixelWidth <= 0 || b.pixelHeight <= 0) return false;
  const densityA = Math.sqrt((a.pixelWidth * a.pixelHeight) / (widthA * heightA));
  const densityB = Math.sqrt((b.pixelWidth * b.pixelHeight) / (widthB * heightB));
  if (Math.abs(densityA - densityB) > TILE_MAX_DENSITY_DIFFERENCE * Math.max(densityA, densityB)) return false;
  const atSeam = (end: number, start: number): boolean => end - start <= TILE_SEAM_MAX_OVERLAP_PT && start - end <= TILE_SEAM_MAX_GAP_PT;
  const alongX = Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX);
  const alongY = Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY);
  const sideBySide = (atSeam(a.box.maxX, b.box.minX) || atSeam(b.box.maxX, a.box.minX)) && alongY >= TILE_SEAM_MIN_ALIGNED_SHARE * Math.min(heightA, heightB);
  const stacked = (atSeam(a.box.maxY, b.box.minY) || atSeam(b.box.maxY, a.box.minY)) && alongX >= TILE_SEAM_MIN_ALIGNED_SHARE * Math.min(widthA, widthB);
  return sideBySide || stacked;
}

/** Whether `b` is `a` painted a second time: a raster of the same size over the same box (within a point). */
function isRepaintOf(a: { entry: ImageEntry; box: Rect }, b: { entry: ImageEntry; box: Rect }): boolean {
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1;
  return a.entry.intrinsicWidth === b.entry.intrinsicWidth && a.entry.intrinsicHeight === b.entry.intrinsicHeight && near(a.box.minX, b.box.minX) && near(a.box.minY, b.box.minY) && near(a.box.maxX, b.box.maxX) && near(a.box.maxY, b.box.maxY);
}

/** `unit` without the rasters that repaint another of its members on this page (see `isRepaintOf`). */
function withoutRepaints(unit: ExtractionUnit): ExtractionUnit {
  const boxOf = (m: ImageEntry): Rect | undefined => m.occurrences.find((o) => o.page === unit.page)?.bbox;
  const kept = unit.memberEntries.filter((m, at) => {
    const box = boxOf(m);
    return box === undefined || !unit.memberEntries.slice(0, at).some((k) => boxOf(k) !== undefined && isRepaintOf({ entry: k, box: boxOf(k)! }, { entry: m, box }));
  });
  if (kept.length === unit.memberEntries.length) return unit;
  return { ...unit, memberEntries: kept, clusterMemberCount: kept.length };
}

function windowsAreApart(a: readonly number[], b: readonly number[], maxShare: number): boolean {
  const shared = polygonArea(clipPolygon(a, b));
  return shared < maxShare * Math.min(polygonArea(a), polygonArea(b));
}

export function splitUnitsOfDistinctPictures(
  units: readonly ExtractionUnit[],
  classifiedByEntry: ReadonlyMap<ImageEntry, ClassifiedImage>,
  maskedObjIds: ReadonlySet<string>,
  textBoxesByPage?: ReadonlyMap<number, readonly Rect[]>,
): ExtractionUnit[] {
  const isSolid = (m: ImageEntry): boolean => !isBackdropShape(m);
  return units.flatMap((planned) => {
    // A raster painted a second time over the same box (the same picture, painted again to blend it or to cover its edge) is not another picture of the unit.
    const unit = withoutRepaints(planned);
    // A panel of text laid over pictures (a masked panel painted at 90%, with the page's text on it) is not part of them: a render of the unit would carry its text.
    // Each picture of the unit is a picture of its own, taken from its own pixels.
    const isTextPanelOverPictures = (m: ImageEntry): boolean => m.maxOpacity !== undefined && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && classifiedByEntry.get(m)?.reason === HIGH_TEXT_COVERAGE_REASON;
    if (unit.memberEntries.length >= 2 && unit.memberEntries.some(isTextPanelOverPictures) && unit.memberEntries.some((m) => !isTextPanelOverPictures(m) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA)) {
      return unit.memberEntries.flatMap((m): ExtractionUnit[] => {
        const c = classifiedByEntry.get(m);
        const boxes = m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox);
        if (!c || boxes.length === 0 || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA) return [];
        return [{ representativeEntry: m, memberEntries: [m], page: unit.page, bbox: boxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: 1, classification: c.classification, confidence: c.confidence, reason: c.reason }];
      });
    }
    const significant = unit.memberEntries.filter((m) => isSolid(m) && !isPanelBehindFigure(m, unit) && m.objId !== null && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
    const underFullPageIllustration = unit.representativeEntry !== null && unit.representativeEntry.maxRelativeArea >= SPLIT_BANNER_REPRESENTATIVE_MIN_AREA;
    const significantMasked = unit.memberEntries.filter((m) => isSolid(m) && m.objId !== null && m.maxRelativeArea >= (underFullPageIllustration ? SPLIT_BANNER_MASKED_MIN_AREA : CO_MEMBER_SIGNIFICANT_AREA) && maskedObjIds.has(m.objId));
    const standOnBackdrops = unit.memberEntries.some((m) => isBackdropShape(m));
    // A big card of the layout (a panel with a stat block, painted at 90%: not a faint overlay, not fully opaque) with figures standing on it: the figures are pictures of their own.
    const standOnCard = unit.memberEntries.some((m) => m.maxOpacity !== undefined && m.maxOpacity < 1 && !isTranslucentEverywhere(m) && m.maxRelativeArea >= LAYOUT_CARD_MIN_AREA);
    // A card of text (a parchment with a stat block) laid over a picture: the two are told apart, the picture is not part of the card.
    const classifierFoundCard = unit.memberEntries.some((m) => m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && classifiedByEntry.get(m)?.reason === HIGH_TEXT_COVERAGE_REASON);
    const isTextCard = (m: ImageEntry): boolean => {
      const own = m.occurrences.find((o) => o.page === unit.page)?.bbox;
      const reason = classifiedByEntry.get(m)?.reason;
      if (own === undefined || m.maxOpacity !== undefined) return false;
      if (reason === HIGH_TEXT_COVERAGE_REASON) return true;
      // When the classifier found a card of text among the members, the others are the pictures the card lies on, however much of their box the page's text blocks cover.
      if (classifierFoundCard) return false;
      return textCoverage(own, textBoxesByPage?.get(unit.page)) >= SPLIT_TEXT_CARD_MIN_COVERAGE;
    };
    const boxOnPage = (m: ImageEntry): Rect | undefined => m.occurrences.find((o) => o.page === unit.page)?.bbox;
    const standOnTextCard =
      textBoxesByPage !== undefined &&
      significant.some(
        (card) =>
          isTextCard(card) &&
          significant.some((picture) => {
            const cardBox = boxOnPage(card);
            const pictureBox = boxOnPage(picture);
            if (picture === card || isTextCard(picture) || cardBox === undefined || pictureBox === undefined || picture.maxRelativeArea < SPLIT_TEXT_CARD_PICTURE_MIN_AREA) return false;
            const shared = rectIntersection(cardBox, pictureBox);
            return shared === null || rectArea(shared) < SPLIT_TEXT_CARD_MAX_PICTURE_ON_CARD * rectArea(pictureBox);
          }),
      );
    // Pictures of which some are shown in frames of their own (a clip) and whose frames do not overlap the others (three floor plans stacked on a page,
    // a creature beside swirls of wind): the boxes of their rasters overlap where the frames do not, which is no reason to join them. The pictures whose
    // outlines overlap stay together; the groups that remain are separate pictures.
    if (significantMasked.length < 2 && !(standOnBackdrops || standOnCard || standOnTextCard) && significant.length >= 2) {
      const outlines = significant.map((m) => {
        const box = boxOnPage(m);
        return visibleWindow(m, unit.page) ?? (box === undefined ? undefined : [box.minX, box.minY, box.maxX, box.minY, box.maxX, box.maxY, box.minX, box.maxY]);
      });
      if (outlines.every((o): o is readonly number[] => o !== undefined)) {
        const parent = significant.map((_, i) => i);
        const find = (i: number): number => {
          while (parent[i] !== i) i = parent[i]!;
          return i;
        };
        const tileOf = (m: ImageEntry): TileSource | undefined => {
          const box = boxOnPage(m);
          return box === undefined || m.intrinsicWidth === null || m.intrinsicHeight === null || visibleWindow(m, unit.page) !== undefined || m.occurrences.find((o) => o.page === unit.page)?.placement?.rotated === true ? undefined : { box, pixelWidth: m.intrinsicWidth, pixelHeight: m.intrinsicHeight };
        };
        const seamed = (i: number, j: number): boolean => {
          const a = tileOf(significant[i]!);
          const b = tileOf(significant[j]!);
          return a !== undefined && b !== undefined && areSeamedTiles(a, b);
        };
        for (let i = 0; i < outlines.length; i++) for (let j = i + 1; j < outlines.length; j++) if (seamed(i, j) || !windowsAreApart(outlines[i] as readonly number[], outlines[j] as readonly number[], visibleWindow(significant[i]!, unit.page) === undefined && visibleWindow(significant[j]!, unit.page) === undefined ? BOXES_MAX_OVERLAP_SHARE : FRAMES_MAX_OVERLAP_SHARE)) parent[find(i)] = find(j);
        const components = new Map<number, ImageEntry[]>();
        significant.forEach((m, i) => components.set(find(i), [...(components.get(find(i)) ?? []), m]));
        if (components.size >= 2) {
          return [...components.values()].flatMap((members): ExtractionUnit[] => {
            const representative = members.reduce((best, m) => (m.maxRelativeArea > best.maxRelativeArea ? m : best));
            const c = classifiedByEntry.get(representative);
            const boxes = members.flatMap((m) => m.occurrences.filter((o) => o.page === unit.page).map((o) => o.bbox));
            if (!c || boxes.length === 0) return [];
            return [{ representativeEntry: representative, memberEntries: members, page: unit.page, bbox: boxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: members.length, classification: c.classification, confidence: c.confidence, reason: c.reason }];
          });
        }
      }
    }
    if (unit.memberEntries.length < 2 || (significantMasked.length < 2 && !((standOnBackdrops || standOnCard || standOnTextCard) && significant.length >= 2))) return [unit];
    const isSplitOff = (m: ImageEntry): boolean => {
      if (!isSolid(m)) return false;
      if (m === unit.representativeEntry) return true;
      const c = classifiedByEntry.get(m);
      return c !== undefined && (m.maxRelativeArea >= SPLIT_OFF_MIN_AREA || (c.classification === 'content' && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA));
    };
    // A picture of consequence that lies clear of the pictures split off (at most `FRAMES_MAX_OVERLAP_SHARE` of its box on any of them: the second figure of a pair, an
    // armor beside the others) is a picture of its own, not a leftover of the stack: only the pieces that sit on the pictures are.
    // The flush washes of the layout that are split off with them are not pictures to keep clear of.
    const splitOff = unit.memberEntries.filter((m) => isSplitOff(m) && classifiedByEntry.get(m)?.reason !== FLUSH_UNDECIDED_REASON);
    const clearOfSplitOff = (m: ImageEntry): boolean => {
      const box = boxOnPage(m);
      if (box === undefined || rectArea(box) <= 0 || !isSolid(m) || isTextCard(m) || isPanelBehindFigure(m, unit) || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA || classifiedByEntry.get(m) === undefined) return false;
      return splitOff.every((o) => {
        const shared = boxOnPage(o) === undefined ? null : rectIntersection(box, boxOnPage(o)!);
        return shared === null || rectArea(shared) <= FRAMES_MAX_OVERLAP_SHARE * rectArea(box);
      });
    };
    // A picture nearly as large as the largest one split off (the third snapshot of a stack, pinned slightly over the others) is its peer as well.
    const largestSplitOff = splitOff.reduce((largest, m) => Math.max(largest, m.maxRelativeArea), 0);
    const isPeerOfSplitOff = (m: ImageEntry): boolean =>
      isSolid(m) && !isTextCard(m) && !isPanelBehindFigure(m, unit) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && m.maxRelativeArea >= SPLIT_PEER_MIN_SHARE * largestSplitOff && classifiedByEntry.get(m) !== undefined;
    const separate = unit.memberEntries.filter((m) => isSplitOff(m) || clearOfSplitOff(m) || isPeerOfSplitOff(m));
    const isRepaintOfEarlier = (m: ImageEntry, at: number): boolean => {
      const box = boxOnPage(m);
      return box !== undefined && separate.slice(0, at).some((k) => {
        const earlier = boxOnPage(k);
        return earlier !== undefined && isRepaintOf({ entry: k, box: earlier }, { entry: m, box });
      });
    };
    return separate.filter((m, at) => !isRepaintOfEarlier(m, at)).flatMap((m): ExtractionUnit[] => {
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
  /** For a drawing of vector paths: the boxes of the shapes it is made of (see `vectorFigures.ts`). */
  shapeBoxes?: readonly Rect[];
}

/**
 * Share of opaque pixels below which a picture is a cut-out figure on a transparent ground: the text that lies
 * in its bbox lies on the page (on the transparent part, next to the figure), not on the picture. Measured on a
 * real rulebook: the cut-out figures are 25%-45% opaque, the paper notes and handouts that carry text are 100%.
 */
const TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION = 0.6;
/**
 * A member of a unit counts as covered by another when that one, painted later and fully opaque, covers this much
 * of it (the same measure as the covered-picture rule of the classifier) — and the covering picture is opaque
 * for real: at least this share of its pixels (a vignette or a cut-out figure with a transparent middle is not).
 */
const COVERED_MEMBER_MIN_COVER = 0.75;
const COVER_MIN_OPAQUE_FRACTION = 0.9;
/** Share of the region of a cut-out figure that page text must cover for the render to be judged as dragging text in. */
const CUTOUT_TEXT_MIN_COVERAGE = 0.01;

/**
 * A faded paper vignette — the soft white edge laid over an illustration so that it melts into the page — is a
 * raster that is mostly transparent and whose opaque part is the color of the paper. Measured on a real rulebook:
 * the vignette is 23% opaque with a mean brightness of 207, the cut-out figures are 33%-51% opaque with a
 * mean brightness of 53-77. It is not a picture, and the illustration under it is.
 */
const PAPER_OVERLAY_MAX_OPAQUE_FRACTION = 0.5;
const PAPER_OVERLAY_MIN_BRIGHTNESS = 185;
/** The share of the picture under it that a vignette must cover: it is laid over the illustration to melt its edge, not beside it. A pale drawing (sheets of paper) that only touches the next picture is a picture of the same illustration. */
const PAPER_OVERLAY_MIN_COVER_OF_PICTURE = 0.5;

export function isPaperOverlay(stats: { opaqueFraction: number; meanOpaqueBrightness: number }): boolean {
  return stats.opaqueFraction < PAPER_OVERLAY_MAX_OPAQUE_FRACTION && stats.meanOpaqueBrightness >= PAPER_OVERLAY_MIN_BRIGHTNESS;
}

/**
 * The other pictures of consequence of a unit, as units of their own (largest first, at most two): the pictures
 * that could stand for it if the one it stands for is hidden from the list. Translucent members are not pictures.
 */
export function alternativeRepresentatives(unit: ExtractionUnit): ExtractionUnit[] {
  return unit.memberEntries
    .filter((m) => m !== unit.representativeEntry && m.objId !== null && !isTranslucentEverywhere(m) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA)
    .sort((a, b) => b.maxRelativeArea - a.maxRelativeArea)
    .slice(0, 2)
    .map((m) => ({ ...unit, representativeEntry: m }));
}

/** Page-area share from which a faded layer counts as a panel (the misty ground a figure stands on) and not as a picture of its own. */
const PANEL_BEHIND_FIGURE_MIN_AREA = 0.1;
/** ...and up to this share (a faded picture that fills most of the page is a background art of its own) and at up to this opacity (the faded pictures worth offering sit at 50%-65%). */
const PANEL_BEHIND_FIGURE_MAX_AREA = 0.5;
const PANEL_BEHIND_FIGURE_MAX_OPACITY = 0.45;

/**
 * A large layer painted faded (at most 45% opaque everywhere it appears) in a unit that also holds an opaque picture of consequence: the misty panel the figure
 * stands in front of, not a second picture. On its own a faded picture is a picture worth offering (a watermark, a faded sketch); it is the figure
 * beside it that makes it a backdrop.
 */
export function isPanelBehindFigure(entry: ImageEntry, unit: ExtractionUnit): boolean {
  if (entry.maxOpacity === undefined || entry.maxOpacity > PANEL_BEHIND_FIGURE_MAX_OPACITY || entry.maxRelativeArea < PANEL_BEHIND_FIGURE_MIN_AREA || entry.maxRelativeArea > PANEL_BEHIND_FIGURE_MAX_AREA) return false;
  return unit.memberEntries.some((m) => m !== entry && m.maxOpacity === undefined && !isBackdropShape(m) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
}

/**
 * The members of a unit that make up its composition: everything but the faint backdrops (see `isBackdropShape`),
 * which are not part of what a raw resource or a render would have to reproduce. A unit of backdrops only keeps
 * all of them.
 */
export function compositionMembers(unit: ExtractionUnit): readonly ImageEntry[] {
  const solid = unit.memberEntries.filter((m) => !isBackdropShape(m) && !isPanelBehindFigure(m, unit));
  return solid.length > 0 ? solid : unit.memberEntries;
}

/**
 * A faint shape — a colored panel or a halftone layer painted at 20% — that a solid figure stands in front of is
 * the figure's backdrop, not the picture: taking its raw resource gives the empty panel, rendering the
 * union copies the backdrop and whatever text surrounds it. Such a unit stands for the largest solid member (at least
 * `CO_MEMBER_SIGNIFICANT_AREA` of the page) instead. The unit keeps its classification: it was judged as a picture
 * as a whole.
 */
export function withSolidRepresentativeOfBackdrop(unit: ExtractionUnit): ExtractionUnit {
  const rep = unit.representativeEntry;
  if (rep === null || !(isBackdropShape(rep) || isPanelBehindFigure(rep, unit))) return unit;
  const solid = unit.memberEntries.filter((m) => m !== rep && m.objId !== null && !isBackdropShape(m) && !isPanelBehindFigure(m, unit) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
  if (solid.length === 0) return unit;
  const largest = solid.reduce((best, cur) => (cur.maxRelativeArea > best.maxRelativeArea ? cur : best));
  return { ...unit, representativeEntry: largest };
}

/** The painting of `entry` on `page` that lies on top: the last one in the paint order (a picture painted twice shows as its upper painting does). */
export function topOccurrenceOnPage(entry: ImageEntry, page: number): ImageEntry['occurrences'][number] | undefined {
  let top: ImageEntry['occurrences'][number] | undefined;
  for (const o of entry.occurrences) if (o.page === page && (top === undefined || o.index > top.index)) top = o;
  return top;
}

/**
 * The member a unit stands for: the largest one. A watermark is not the picture of a unit that holds a real one,
 * though: when the largest member is painted translucent AND nobody found it to be content (a faint mark below
 * the share of the page from which a picture is taken for content, laid behind a pinned photo) and the unit also
 * holds a photo of consequence (a masked picture painted solid, at least `CO_MEMBER_SIGNIFICANT_AREA` of the
 * page), the unit stands for that photo. Taking the watermark's raw resource would swap the photo for the mark,
 * and rendering the union copies the page's text into the image. Measured on a real rulebook: the watermarks
 * behind pinned photos are 8%-10% of the page and undecided; a translucent emblem that is content (25% of the
 * page, with a splatter over it and a blank paper sheet under it) keeps being the picture of its unit.
 */
export function pickUnitRepresentative(group: readonly ClassifiedImage[], maskedObjIds: ReadonlySet<string>): ClassifiedImage {
  const larger = (best: ClassifiedImage, cur: ClassifiedImage): ClassifiedImage => (cur.entry.maxRelativeArea > best.entry.maxRelativeArea ? cur : best);
  const largest = group.reduce(larger);
  if (!isTranslucentEverywhere(largest.entry) || largest.classification !== 'undecided') return largest;
  const solidPhotos = group.filter((c) => !isTranslucentEverywhere(c.entry) && c.entry.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA && c.entry.objId !== null && maskedObjIds.has(c.entry.objId));
  return solidPhotos.length > 0 ? solidPhotos.reduce(larger) : largest;
}

/** Places that lie this close (points) are one place: the shadow of a picture, a copy a hair's breadth off. */
const SAME_PLACE_GAP_PT = 2;

/** The first of `boxes` with every box that lies on it or touches it, transitively, united: where one picture is painted first. */
export function firstPlaceOfPicture(boxes: readonly Rect[]): Rect {
  const touches = (a: Rect, b: Rect): boolean => a.minX <= b.maxX + SAME_PLACE_GAP_PT && b.minX <= a.maxX + SAME_PLACE_GAP_PT && a.minY <= b.maxY + SAME_PLACE_GAP_PT && b.minY <= a.maxY + SAME_PLACE_GAP_PT;
  let place = boxes[0]!;
  const taken = new Set<number>([0]);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 1; i < boxes.length; i++) {
      if (taken.has(i) || !touches(place, boxes[i]!)) continue;
      place = unionRect(place, boxes[i]!);
      taken.add(i);
      grew = true;
    }
  }
  return place;
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
function groupIntoUnits(candidates: readonly ClassifiedImage[], pageBoxByPage: ReadonlyMap<number, Rect>, maskedObjIds: ReadonlySet<string>, diagnostics: Diagnostic[]): ExtractionUnit[] {
  const groups = partitionCandidatesIntoGroups(candidates);

  return groups.map((group) => {
    const representative = pickUnitRepresentative(group, maskedObjIds);
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
    const boxesOnPage = group.flatMap((c) => c.entry.occurrences.filter((o) => o.page === page).map((o) => o.bbox));
    // One picture that the page paints in places far apart (a scoreboard at the top and again at the foot) is one picture where it is first painted: the union of its places would
    // be a region with the whole page between them.
    const bbox = group.length === 1 ? firstPlaceOfPicture(boxesOnPage) : boxesOnPage.reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null)!;
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

/** The reason of a unit that is a drawing made of vector paths (see `vectorFigures.ts`). */
export const VECTOR_FIGURE_REASON = 'Z2-vector-figure';
/** A drawing is not offered when the pictures offered on its page (the translucent panels of the layout are not pictures) cover this share of its box (the paths are the decoration of a picture), or the boxes of the page's text blocks this much of it (a table, a form: the blocks of a paragraph that wraps around a figure reach over its box, so the limit is high). */
const FIGURE_MAX_IMAGE_COVER = 0.5;
const FIGURE_MAX_TEXT_COVERAGE = 0.75;
/** A drawing that is found at the same place, of the same size, on this many pages is a running ornament. */
const FIGURE_REPEAT_PAGES = 3;
const FIGURE_REPEAT_GRID_PT = 6;
/** A render of a drawing that is white over this share of its pixels shows a plate or a few lines on an empty page: not a picture. A figure on the tinted paper of a book is nowhere near it. */
const FIGURE_MAX_WHITE_SHARE = 0.8;

/**
 * The vector drawings of the document as units to render: clusters of filled paths (a cartoon figure, a set of icons), except those that
 * lie on a picture, are mostly text, or are repeated on page after page. Each is offered as undecided.
 */
export function findVectorFigureUnits(
  shapes: readonly { page: number; bbox: Rect }[],
  images: readonly ImageEntry[],
  pageBoxByPage: ReadonlyMap<number, Rect>,
  textBoxesByPage: ReadonlyMap<number, readonly Rect[]>,
): ExtractionUnit[] {
  const shapesByPage = new Map<number, { bbox: Rect }[]>();
  for (const s of shapes) {
    const arr = shapesByPage.get(s.page) ?? [];
    arr.push(s);
    shapesByPage.set(s.page, arr);
  }
  const found: { page: number; bbox: Rect; foundBbox: Rect; shapeCount: number; shapeBoxes: Rect[] }[] = [];
  for (const [page, pageShapes] of shapesByPage) {
    const box = pageBoxByPage.get(page);
    if (box === undefined) continue;
    for (const f of findVectorFigures(pageShapes, box)) found.push({ page, ...f });
  }
  const signature = (f: { bbox: Rect; shapeCount: number }): string =>
    [f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY].map((v) => Math.round(v / FIGURE_REPEAT_GRID_PT)).join(',') + ':' + f.shapeCount;
  const pagesOfSignature = new Map<string, Set<number>>();
  for (const f of found) {
    const set = pagesOfSignature.get(signature(f)) ?? new Set<number>();
    set.add(f.page);
    pagesOfSignature.set(signature(f), set);
  }
  const imagesByPage = new Map<number, Rect[]>();
  for (const e of images) for (const o of e.occurrences) imagesByPage.set(o.page, [...(imagesByPage.get(o.page) ?? []), o.bbox]);
  return found
    .filter((f) => {
      if ((pagesOfSignature.get(signature(f))?.size ?? 0) >= FIGURE_REPEAT_PAGES) return false;
      if (textCoverage(f.foundBbox, textBoxesByPage.get(f.page)) >= FIGURE_MAX_TEXT_COVERAGE) return false;
      const area = rectArea(f.foundBbox);
      const covered = (imagesByPage.get(f.page) ?? []).reduce((sum, b) => sum + rectArea(rectIntersection(f.foundBbox, b) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0);
      return area > 0 && covered / area < FIGURE_MAX_IMAGE_COVER;
    })
    .map((f): ExtractionUnit => ({
      representativeEntry: null,
      memberEntries: [],
      page: f.page,
      bbox: f.bbox,
      clusterMemberCount: 0,
      classification: 'undecided',
      confidence: confidenceForReason(VECTOR_FIGURE_REASON),
      reason: VECTOR_FIGURE_REASON,
      shapeBoxes: f.shapeBoxes,
    }));
}

/** Placeholder `ImageEntry` for units with no real image (a purely vector region) — needed so `finalizeImages` has something to work with. */
function syntheticVectorOnlyEntry(pageNumber: number, bbox: Rect, relativeArea = 1): ImageEntry {
  return {
    objId: null,
    occurrences: [{ page: pageNumber, bbox, index: -1 }],
    pageRefs: [pageNumber],
    maxRelativeArea: relativeArea,
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
  const pageRotationByPage = new Map(inventory.perPage.map((p) => [p.pageNumber, p.rotation]));
  const bodyBlockBoxesByPage = opts.bodyBlockBoxesByPage ?? new Map();
  const headingBlockBoxesByPage = opts.headingBlockBoxesByPage ?? new Map();
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
  const imageUnits = splitUnitsOfDistinctPictures(groupIntoUnits(candidates, pageBoxByPage, maskedObjIds, diagnostics), classifiedByEntry, maskedObjIds, textBlockBoxesByPage);

  const pagesWithAnyImage = new Set<number>();
  for (const entry of inventory.images) for (const occ of entry.occurrences) pagesWithAnyImage.add(occ.page);
  const vectorOnlyUnits = [...findVectorOnlyUnits(inventory.vectors, pagesWithAnyImage), ...(opts.includeVectorFigures === true ? findVectorFigureUnits(inventory.shapes ?? [], candidates.map((c) => c.entry).filter((e) => !isTranslucentEverywhere(e)), pageBoxByPage, textBlockBoxesByPage) : [])];

  // DETERMINISTIC order, independent of input order: page ascending, within
  // a page by objId (vector regions, with no objId, at the end of each page).
  // Masked pictures that stand against the page edge: single-member units, so that they change nothing about how
  // the other pictures are grouped; the page loop drops those whose mask is not a silhouette.
  const edgeFigureUnits: ExtractionUnit[] = classified
    .filter(
      (c) =>
        (c.reason === 'Z12-bleeding-masked-cutout' || c.reason === 'Z1-full-bleed-background') &&
        c.entry.objId !== null &&
        maskedObjIds.has(c.entry.objId) &&
        c.entry.occurrences.length > 0 &&
        maxBleedOverhangPt(c.entry, pageBoxByPage) <= EDGE_FIGURE_MAX_OVERHANG_PT,
    )
    .map((c) => ({
      representativeEntry: c.entry,
      memberEntries: [c.entry],
      page: c.entry.occurrences[0]!.page,
      bbox: c.entry.occurrences[0]!.bbox,
      clusterMemberCount: 1,
      classification: 'undecided' as const,
      confidence: confidenceForReason(EDGE_FIGURE_REASON),
      reason: EDGE_FIGURE_REASON,
    }));
  const allUnits = [...imageUnits, ...edgeFigureUnits, ...vectorOnlyUnits].sort((a, b) => {
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
  // Pages with a form read from pixels, and the rasters that are ruled like one but have too little print to be taken for it alone.
  const formPages = new Set<number>();
  const possibleSheetParts: { item: PreparedEntryForFinalize<EncodedImage>; page: number }[] = [];
  // The placeholder entries of the vector drawings found: they are dropped again when what the page shows there is a picture that is offered anyway.
  const figureEntries = new Set<ImageEntry>();
  // The halves of a picture that runs across a spread: a map (each half a big translucent panel with a drawing on it) or an illustration
  // (each half a picture of its own that reaches the gutter). The latter are joined only when their pixels go on across the seam.
  const halfCandidates = allUnits.filter((u) => u.reason === LARGE_TRANSLUCENT_PANEL_REASON || ((u.classification === 'content' || u.classification === 'undecided') && u.representativeEntry !== null && u.representativeEntry.maxRelativeArea >= SPREAD_HALF_MIN_AREA));
  const spreadRightOf = findSpreadPairs(halfCandidates, pageBoxByPage, (u) => (u.memberEntries.length === 1 && u.representativeEntry?.intrinsicWidth != null && u.representativeEntry.intrinsicHeight != null ? { width: u.representativeEntry.intrinsicWidth, height: u.representativeEntry.intrinsicHeight } : undefined));
  const spreadRightHalves = new Set(spreadRightOf.values());
  let pendingLeftHalf: { item: PreparedEntryForFinalize<EncodedImage>; image: DecodedImage; page: number; isPanel: boolean; box: Rect } | null = null;
  let done = 0;
  let total = allUnits.length;

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
      // Luminance spread of what the last extracted unit shows (only measured for `EDGE_FIGURE_REASON` units).
      let edgeFigureStdDev: number | undefined;
      // The picture of the last extracted unit when it is a drawing on a big panel (a map): kept so that the two halves of a map across a spread can be joined.
      let lastPanelImage: DecodedImage | null = null;
      // The decoded image each extracted unit was encoded from: the halves of a picture across a spread are joined from it.
      const imageByItem = new WeakMap<object, DecodedImage>();
      // One unit, from the planning of how to take it to the encoded result.
      const extractUnit = async (plannedUnit: ExtractionUnit): Promise<PreparedEntryForFinalize<EncodedImage>> => {
        let unit = plannedUnit;
          // Any kind of text block counts here, not only body and caption: a heading or a sidebar that is cut by
          // the region ends up in the render just the same.
          let crossesText = textCrossesRegionEdge(plannedUnit.bbox, textBlockBoxesByPage.get(pageNumber));
          unit = withSolidRepresentativeOfBackdrop(plannedUnit);
          // A dark translucent panel of the page's layout that only touches the picture (the info panel beside a character's portrait) is not part of it: the unit is the picture alone.
          const solidRep = unit.representativeEntry;
          if (hideBackgroundImages && solidRep !== null && !isTranslucentEverywhere(solidRep) && unit.memberEntries.length > 1) {
            const panelMembers: ImageEntry[] = [];
            for (const member of unit.memberEntries) {
              if (member === solidRep || member.objId === null || !isTranslucentEverywhere(member) || maskedObjIds.has(member.objId)) continue;
              const memberId = idOnThisPage(member);
              if (memberId === null) continue;
              if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
              const memberLook = await probeRawLook(page, memberId);
              if (memberLook !== null && isBareDarkTexture(memberLook)) panelMembers.push(member);
            }
            const keptMembers = unit.memberEntries.filter((m) => !panelMembers.includes(m));
            const keptBoxes = keptMembers.map((m) => m.occurrences.find((o) => o.page === pageNumber)?.bbox).filter((b): b is Rect => b !== undefined);
            if (panelMembers.length > 0 && keptBoxes.length > 0) {
              unit = { ...unit, memberEntries: keptMembers, bbox: keptBoxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: keptMembers.length };
              crossesText = textCrossesRegionEdge(unit.bbox, textBlockBoxesByPage.get(pageNumber));
            }
          }
          // A faded paper vignette is not the picture of its unit: the illustration it frames is, and the vignette
          // is left out of the unit's other pictures.
          let overlayMember: ImageEntry | null = null;
          if (unit.representativeEntry !== null && unit.representativeEntry.objId !== null) {
            const [alternative] = alternativeRepresentatives(unit);
            const overlayId = idOnThisPage(unit.representativeEntry);
            if (alternative !== undefined && overlayId !== null) {
              if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [overlayId], settleBudgetMs);
              const stats = await probeOpaquePixelStats(page, overlayId);
              // A translucent dark texture laid behind a picture (a panel of the page's design) is no more its picture than a paper vignette is.
              // A panel that frames the picture (a card with a portrait on it) is a unit of its own and stays one.
              const panelBox = unit.representativeEntry.occurrences.find((o) => o.page === pageNumber)?.bbox;
              const altBox = alternative.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.bbox;
              const sharedWithAlt = panelBox !== undefined && altBox !== undefined ? rectIntersection(panelBox, altBox) : null;
              const framesAlt = sharedWithAlt !== null && altBox !== undefined && rectArea(sharedWithAlt) >= PANEL_FRAMES_PICTURE_MIN_SHARE * rectArea(altBox);
              const panelLook = stats !== null && !framesAlt && isTranslucentEverywhere(unit.representativeEntry) ? await probeRawLook(page, overlayId) : null;
              const coversAlt = sharedWithAlt !== null && altBox !== undefined && rectArea(sharedWithAlt) >= PAPER_OVERLAY_MIN_COVER_OF_PICTURE * rectArea(altBox);
              if (stats !== null && ((isPaperOverlay(stats) && coversAlt) || (stats.opaqueFraction >= PANEL_OVERLAY_MIN_OPAQUE_FRACTION && panelLook !== null && isBareDarkTexture(panelLook)))) {
                overlayMember = unit.representativeEntry;
                // The region is now the illustration's own: the strip the vignette adds around it is where the
                // page's text lies.
                const ownBox = alternative.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.bbox;
                unit = ownBox ? { ...alternative, bbox: ownBox } : alternative;
                crossesText = textCrossesRegionEdge(unit.bbox, textBlockBoxesByPage.get(pageNumber));
              }
            }
          }
          // The pictures of a unit of flush pictures (one illustration drawn in several pieces) sit in rasters with a transparent margin that may
          // run into the margin of the page: the region is the union of what is visible of them.
          if (unit.reason === FLUSH_UNDECIDED_REASON && unit.memberEntries.length > 1) {
            const visibleBoxes: Rect[] = [];
            for (const member of unit.memberEntries) {
              const own = member.occurrences.find((o) => o.page === pageNumber);
              const memberId = idOnThisPage(member);
              if (own === undefined) continue;
              let box = own.bbox;
              if (memberId !== null && member.objId !== null) {
                if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
                const bounds = await probeOpaqueBounds(page, memberId, FULL_EXTENT_BOUNDS);
                const size = member.intrinsicWidth !== null && member.intrinsicHeight !== null ? { width: member.intrinsicWidth, height: member.intrinsicHeight } : await probeIntrinsicSizePx(page, memberId);
                const tight = bounds !== null && size !== null && rawResourceFitsPlacement(size, own.bbox) ? tightenToVisible(own.bbox, bounds, own.placement) : null;
                if (tight !== null) box = tight;
              }
              visibleBoxes.push(box);
            }
            if (visibleBoxes.length > 0) {
              unit = { ...unit, bbox: visibleBoxes.reduce((acc, b) => unionRect(acc, b)) };
              crossesText = textCrossesRegionEdge(unit.bbox, textBlockBoxesByPage.get(pageNumber));
            }
          }
          // Only probed when it can matter: the raw resource is considered for masked units and for
          // clusters whose region is cut by page text.
          // Only the solid members make up what a raw resource or a render has to reproduce.
          // A member painted exactly where the representative is (each covering 90% of the other) is that picture again, not another picture of the
          // composition: a render of the unit would only add what the page draws around it (a ring, a frame) to the same picture.
          const repOwnBox = unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.bbox;
          const isCopyOfRepresentative = (m: ImageEntry): boolean => {
            const box = m.occurrences.find((o) => o.page === pageNumber)?.bbox;
            if (m === unit.representativeEntry || repOwnBox === undefined || box === undefined || (m.objId !== null && maskedObjIds.has(m.objId))) return false;
            const shared = rectIntersection(repOwnBox, box);
            return shared !== null && rectArea(shared) >= SAME_FOOTPRINT_MIN_SHARE * rectArea(repOwnBox) && rectArea(shared) >= SAME_FOOTPRINT_MIN_SHARE * rectArea(box);
          };
          // A small picture that lies mostly outside the representative (an ornament that sticks out of the bottom of an illustration) is a piece of the
          // page's decoration beside it: a render of the unit would stretch down to it and take the text of the page on the way.
          const isDecorationBesideRepresentative = (m: ImageEntry): boolean => {
            const box = m.occurrences.find((o) => o.page === pageNumber)?.bbox;
            if (m === unit.representativeEntry || repOwnBox === undefined || box === undefined || m.objId === null || maskedObjIds.has(m.objId) || isBackdropShape(m)) return false;
            return isSmallPieceBesideRepresentative(box, m.maxRelativeArea, repOwnBox, unit.representativeEntry?.maxRelativeArea ?? 0);
          };
          // A long strip flush with the page edge (a misty margin of the layout) that overlaps a big picture is the page's decoration too: a render of the unit
          // would stretch along the strip, over whatever text lies beside the picture.
          const isEdgeStripOverRepresentative = (m: ImageEntry): boolean => {
            const box = m.occurrences.find((o) => o.page === pageNumber)?.bbox;
            if (m === unit.representativeEntry || box === undefined || m.objId === null || maskedObjIds.has(m.objId)) return false;
            if (classifiedByEntry.get(m)?.reason !== FLUSH_UNDECIDED_REASON || (unit.representativeEntry?.maxRelativeArea ?? 0) < EDGE_STRIP_MIN_REPRESENTATIVE_AREA) return false;
            return isLongStrip(box);
          };
          // A flush picture that lies mostly outside a big representative and has the page's text on it is the backdrop of that text (a misty corner under a
          // quote), not a piece of the representative: a render of the unit would take the text with it.
          const isTextBackdropBesideRepresentative = (m: ImageEntry): boolean => {
            const box = m.occurrences.find((o) => o.page === pageNumber)?.bbox;
            if (m === unit.representativeEntry || repOwnBox === undefined || box === undefined || m.objId === null || maskedObjIds.has(m.objId)) return false;
            if (classifiedByEntry.get(m)?.reason !== FLUSH_UNDECIDED_REASON || (unit.representativeEntry?.maxRelativeArea ?? 0) < EDGE_STRIP_MIN_REPRESENTATIVE_AREA) return false;
            return isBackdropOfTextBesideRepresentative(box, repOwnBox, textCoverage(box, textBlockBoxesByPage.get(pageNumber)));
          };
          const beside = unit.memberEntries.filter((m) => isDecorationBesideRepresentative(m) || isEdgeStripOverRepresentative(m) || isTextBackdropBesideRepresentative(m));
          if (beside.length > 0) {
            const kept = unit.memberEntries.filter((m) => !beside.includes(m));
            const keptBoxes = kept.map((m) => m.occurrences.find((o) => o.page === pageNumber)?.bbox).filter((b): b is Rect => b !== undefined);
            if (keptBoxes.length > 0) unit = { ...unit, memberEntries: kept, bbox: keptBoxes.reduce((acc, b) => unionRect(acc, b)), clusterMemberCount: kept.length };
            crossesText = textCrossesRegionEdge(unit.bbox, textBlockBoxesByPage.get(pageNumber));
          }
          const composition = compositionMembers(unit).filter((m) => !isCopyOfRepresentative(m));
          const isMasked = composition.some((e) => e.objId !== null && maskedObjIds.has(e.objId));
          const compositionCount = composition.length;
          const rep = unit.representativeEntry;
          const repId = rep ? idOnThisPage(rep) : null;
          const holderIds = rep?.objId ? (maskHoldersByTarget.get(rep.objId) ?? []).map(idOnThisPage) : [];
          // Text inside the bbox of a cut-out figure lies on the transparent part around it. A block that lies
          // wholly inside the region does not count as "cut" above, but a render of the region copies it just the
          // same, so for such a picture it counts as text cutting the region.
          if (!crossesText && rep && repId && (isMasked || compositionCount > 1)) {
            const textTextBoxes = textBlockBoxesByPage.get(pageNumber);
            if (textCoverage(unit.bbox, textTextBoxes) >= CUTOUT_TEXT_MIN_COVERAGE) {
              if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [repId], settleBudgetMs);
              const opaque = await probeOpaqueFraction(page, repId);
              if (opaque !== null && opaque < TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION) crossesText = true;
            }
          }
          const considersRaw = rep?.objId !== undefined && rep?.objId !== null && (isMasked || (crossesText && compositionCount > 1));
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
              const tiltedRectangleAllowed = placed !== undefined && textCoverage(placed, textBlockBoxesByPage.get(pageNumber)) < MASK_TILTED_RECTANGLE_MAX_TEXT_COVERAGE;
              const verdicts = await Promise.all(holderIds.map((id) => (id === null ? Promise.resolve(false) : maskResourceLetsMostThrough(page, id, tiltedRectangleAllowed))));
              maskMostlyVisible = verdicts.length > 0 && verdicts.every(Boolean);
            }
          }
          // Other pictures that make up the unit: a raw resource shows only one of them.
          // A member painted translucent (a watermark) is not a picture of its own and does not count.
          // A member that an opaque picture of the same unit covers almost completely is not on the page, and
          // rendering the union would not show it either.
          const coveredMembers = new Set<ImageEntry>();
          for (const m of unit.memberEntries) {
            if (m === rep || m === overlayMember || isTranslucentEverywhere(m) || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA) continue;
            const own = m.occurrences.find((o) => o.page === pageNumber);
            if (own === undefined) continue;
            const ownArea = rectArea(own.bbox);
            for (const c of unit.memberEntries) {
              if (c === m || ownArea <= 0) continue;
              const over = c.occurrences.find((o) => o.page === pageNumber && o.index > own.index && o.opacity === undefined && !o.blended);
              const overlap = over === undefined ? null : rectIntersection(own.bbox, over.bbox);
              if (over === undefined || overlap === null || rectArea(overlap) / ownArea < COVERED_MEMBER_MIN_COVER) continue;
              const coverId = idOnThisPage(c);
              if (coverId === null) continue;
              if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [coverId], settleBudgetMs);
              const coverStats = await probeOpaquePixelStats(page, coverId);
              if (coverStats !== null && coverStats.opaqueFraction >= COVER_MIN_OPAQUE_FRACTION) {
                coveredMembers.add(m);
                break;
              }
            }
          }
          // A member that is a card of the page's text (a plain opaque panel with a lot of the page's text on it, as a box
          // of rules over an illustration) belongs to the page's layout, not to the pictures of the unit.
          const textCardMembers = new Set<ImageEntry>();
          for (const m of unit.memberEntries) {
            if (m === rep || m === overlayMember || m.objId === null || isTranslucentEverywhere(m) || m.maxRelativeArea < CO_MEMBER_SIGNIFICANT_AREA || m.maxRelativeArea > TEXT_PANEL_MAX_AREA) continue;
            const ownBox = m.occurrences.find((o) => o.page === pageNumber)?.bbox;
            const memberId = idOnThisPage(m);
            if (ownBox === undefined || memberId === null || textCoverage(ownBox, textBlockBoxesByPage.get(pageNumber)) < TEXT_PANEL_MIN_TEXT_COVERAGE) continue;
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
            const memberLook = await probeRawLook(page, memberId);
            const memberOpaque = memberLook !== null ? await probeOpaqueFraction(page, memberId) : null;
            if (looksLikePlainTextCard(memberLook, memberOpaque)) textCardMembers.add(m);
          }
          // A raster blended into the page (a wash of colour, a stain under the picture) is the page's own paint, not another picture of the unit.
          const isBlendedOnPage = (m: ImageEntry): boolean => m.occurrences.find((o) => o.page === pageNumber)?.blended === true;
          const coMemberAreaShare = unit.memberEntries.reduce((sum, m) => (m === rep || m === overlayMember || coveredMembers.has(m) || textCardMembers.has(m) || isTranslucentEverywhere(m) || isBlendedOnPage(m) ? sum : sum + m.maxRelativeArea), 0);
          // Text that lies ON the picture (a paper note, a newspaper handout) is part of what the page shows.
          const placedRep = rep?.occurrences.find((o) => o.page === pageNumber)?.bbox;
          let textOverPicture = isTextOverPicture(unit.reason, rep, placedRep, textBlockBoxesByPage.get(pageNumber));
          // A note or a scrap is placed in a box that also holds its transparent margin (a shadow, a splatter), and the
          // page's own text beside it lies in that margin. Judged and rendered by the part that is visible, the text
          // that is on the picture stays (it is the note's writing) and the text next to it is left out.
          let tightenedToVisible = false;
          if (textOverPicture && rep?.objId && repId && placedRep && !maskedObjIds.has(rep.objId) && coMemberAreaShare < CO_MEMBER_SIGNIFICANT_AREA) {
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [repId], settleBudgetMs);
            const bounds = await probeOpaqueBounds(page, repId);
            const rawSize = rep.intrinsicWidth !== null && rep.intrinsicHeight !== null ? { width: rep.intrinsicWidth, height: rep.intrinsicHeight } : await probeIntrinsicSizePx(page, repId);
            const opaque = await probeOpaqueFraction(page, repId);
            let tight = bounds !== null && rawSize !== null && rawResourceFitsPlacement(rawSize, placedRep) ? tightenToVisible(placedRep, bounds, rep.occurrences.find((o) => o.page === pageNumber)?.placement) : null;
            // Only a picture that is mostly visible and that the page's text mostly covers (a note with its writing) is
            // judged by its visible part; line art or a faded figure with text beside it keeps the earlier judgement.
            if (tight !== null) {
              const pageText = textBlockBoxesByPage.get(pageNumber);
              // The text that lies in the box but not on the visible part: what the cut takes out of the region.
              const textBesideShare = (textCoverage(placedRep, pageText) * rectArea(placedRep) - textCoverage(tight, pageText) * rectArea(tight)) / rectArea(placedRep);
              if (opaque === null || opaque < TIGHTEN_MIN_OPAQUE_FRACTION || textCoverage(tight, pageText) < TIGHTEN_MIN_TEXT_COVERAGE || textBesideShare < TIGHTEN_MIN_TEXT_BESIDE_SHARE) tight = null;
            }
            if (tight !== null) {
              tightenedToVisible = true;
              unit = { ...unit, bbox: tight };
              crossesText = textCrossesRegionEdge(tight, textBlockBoxesByPage.get(pageNumber));
              textOverPicture = isTextOverPicture(unit.reason, rep, tight, textBlockBoxesByPage.get(pageNumber));
            }
          }
          if (textOverPicture && repId && !tightenedToVisible) {
            // Text in the bbox of a cut-out figure lies on the transparent part around it, not on the picture.
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [repId], settleBudgetMs);
            const opaque = await probeOpaqueFraction(page, repId);
            if (opaque !== null && opaque < TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION) textOverPicture = false;
          }
          let textIsOnPlainCard = false;
          // A plain opaque panel with a lot of the page's text on it is the text's card: what the page shows, not the bare raster.
          if (!textOverPicture && rep?.objId && repId && placedRep && !isTranslucentEverywhere(rep) && rep.maxRelativeArea <= TEXT_PANEL_MAX_AREA && textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)) >= TEXT_PANEL_MIN_TEXT_COVERAGE) {
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [repId], settleBudgetMs);
            const panelRawLook = await probeRawLook(page, repId);
            const panelRawOpaque = panelRawLook !== null ? await probeOpaqueFraction(page, repId) : null;
            if (looksLikePlainTextCard(panelRawLook, panelRawOpaque)) {
              textOverPicture = true;
              textIsOnPlainCard = true;
            }
          }
          // A plain raster that is mostly blank (a faded sketch in a corner of a white sheet) passes for the card of the page's text, but text that
          // runs past its edge is the page's own text (a column the picture lies across), not writing on the card: the picture is taken raw.
          if (textIsOnPlainCard && textCrossingShare(unit.bbox, textBlockBoxesByPage.get(pageNumber)) >= TEXT_RUNS_PAST_PICTURE_MIN_SHARE) {
            textOverPicture = false;
          }
          // A photo with notes pinned over it: the photo is what is offered, taken from its own pixels (the render would carry the notes), and it is not a card of text.
          // The same holds for a map with its labels laid over it by the page: taken from its own pixels, it is the map without them.
          const photoLook = (unit.reason === TEXT_OVER_SMALL_REASON || textOverPicture) && repId !== null ? await probeRawLook(page, repId) : null;
          const isPhotoUnderText = isPhotoUnderNotes(photoLook, textCoverage(shrinkToCenter(unit.bbox), textBlockBoxesByPage.get(pageNumber))) && (unit.reason === TEXT_OVER_SMALL_REASON || (photoLook?.meanLuminance ?? 0) >= MAP_UNDER_LABELS_MIN_MEAN_LUMINANCE);
          if (isPhotoUnderText) {
            textOverPicture = false;
            textIsOnPlainCard = false;
          }
          // Light paper that is a plain card of the page's text (a strip of parchment with writing turned on its side) is a box of text, whatever the share of the page's text over it.
          const textOnPaperCard = textIsOnPlainCard && photoLook !== null && photoLook.meanLuminance >= PAPER_CARD_MIN_MEAN_LUMINANCE;
          const decision = decideExtractionStrategy({
            entry: rep,
            isMasked,
            clusterMemberCount: Math.max(1, compositionCount),
            textCrossesRegionEdge: crossesText,
            rawResourceFitsPlacement: fitsPlacement,
            maskMostlyVisible,
            coMemberAreaShare,
            textOverPicture,
          });
          // A table or a form drawn on a plain sheet: what the render shows is the page's own text, not a picture.
          let blankSheet = false;
          if (decision.strategy === 'region-render' && compositionCount === 1 && repId) {
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [repId], settleBudgetMs);
            const look = await probeRawLook(page, repId);
            blankSheet = look !== null && isBlankSheet(look, { textOverPicture: decision.reason === 'Z2-text-over-picture-is-content', pageShare: rep?.maxRelativeArea ?? 0 });
          }
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

          // A card of text is rendered with the ornaments of its frame that straddle its edge.
          if (decision.strategy === 'region-render' && decision.reason === 'Z2-text-over-picture-is-content') {
            const ornaments = classified
              .filter((c) => (c.classification === 'mask' || c.classification === 'decoration') && c.entry.maxRelativeArea < ORNAMENT_MAX_AREA)
              .flatMap((c) => c.entry.occurrences.filter((o) => o.page === pageNumber).map((o) => o.bbox));
            const extended = extendToEdgeOrnaments(unit.bbox, ornaments, pageBoxByPage.get(pageNumber));
            unit = { ...unit, bbox: extended };
          }
          // A note drawn from several pieces: the piece that is offered lies inside the box of the note, which the classifier took for a backdrop because the page's text covers it.
          // Only a piece whose edge cuts the note's text (measured: 0.71 for a piece of a note, 0.39 for a card of items): the rest of the note lies beyond it.
          if (decision.strategy === 'region-render' && (unit.reason === TEXT_OVER_SMALL_REASON || unit.reason === HIGH_TEXT_COVERAGE_REASON) && textCrossingShare(unit.bbox, textBlockBoxesByPage.get(pageNumber)) >= NOTE_PIECE_MIN_TEXT_CROSSING) {
            const wholeNotes = classified
              .filter((c) => c.classification === 'decoration' && c.reason === TEXT_COVERED_BACKDROP_REASON && c.entry !== rep && c.entry.maxRelativeArea <= NOTE_MAX_AREA)
              .flatMap((c) => c.entry.occurrences.filter((o) => o.page === pageNumber).map((o) => o.bbox));
            unit = { ...unit, bbox: cardOfPiece(unit.bbox, wholeNotes) };
          }
          // What lies over what is the order in which the page paints them.
          const paintedAt = (u: ExtractionUnit): number => u.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.index ?? -1;
          const isCardOfText = (u: ExtractionUnit): boolean => u.reason === HIGH_TEXT_COVERAGE_REASON || u.reason === TEXT_OVER_SMALL_REASON;
          // A card of text with a picture lying over it that is offered by itself (a photo pinned to a note): the card is what the picture leaves of it.
          if (decision.strategy === 'region-render' && unit.reason === HIGH_TEXT_COVERAGE_REASON) {
            const picturesOverCard = pageUnits
              .filter((other) => other !== plannedUnit && other.classification === 'content' && !isCardOfText(other) && (other.representativeEntry?.maxRelativeArea ?? 0) >= PICTURE_OVER_CARD_MIN_AREA && paintedAt(other) > paintedAt(plannedUnit))
              .map((other) => other.bbox);
            unit = { ...unit, bbox: cardWithoutPictures(unit.bbox, picturesOverCard) };
          }
          // A picture judged content with a card of text lying over its edge (a note pinned to the foot of a photo): the picture is what the card leaves of it, not the card's top strip as well.
          // Not for a picture that is itself a note: the boxes of tilted notes overlap by more than their shapes do, and the cut would take their own lines.
          else if (decision.strategy === 'region-render' && unit.classification === 'content' && !isCardOfText(unit)) {
            const cardsOverPicture = pageUnits.filter((other) => other !== plannedUnit && isCardOfText(other) && paintedAt(other) > paintedAt(plannedUnit)).map((other) => other.bbox);
            unit = { ...unit, bbox: cardWithoutPictures(unit.bbox, cardsOverPicture) };
          }
          let extractResult = await extractDirect(
            page,
            objIdForExtraction,
            unit.bbox,
            renderer,
            { targetLongEdgePx: effectiveTargetLongEdgePx, signal },
            pageNumber,
          );
          diagnostics.push(...extractResult.diagnostics);
          // A dark translucent panel with a drawing on it (a floor plan, a map): the raw resource is the bare texture, the picture is
          // what the page shows on it, so the region is rendered instead.
          const isLargePanel = unit.reason === LARGE_TRANSLUCENT_PANEL_REASON;
          const placementOfRep = rep?.occurrences.find((o) => o.page === pageNumber)?.placement;
          let drawnOnPanel = false;
          if (
            hideBackgroundImages &&
            extractResult.source !== 'region-render' &&
            rep?.objId &&
            repId &&
            placedRep &&
            rep.maxOpacity !== undefined &&
            isTranslucentEverywhere(rep) &&
            !maskedObjIds.has(rep.objId) &&
            // A mirrored or turned raster does not line up with the render, so the two cannot be compared.
            placementOfRep === undefined
          ) {
            const panelCoverage = textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber));
            const panelLook = panelCoverage < PANEL_MIN_TEXT_COVERAGE ? await probeRawLook(page, repId) : null;
            const opaqueEnough = panelLook !== null && computeOpaqueFraction(extractResult.image) >= PANEL_OVERLAY_MIN_OPAQUE_FRACTION;
            // A big translucent raster full of color (a city map under a diagram) is a picture in itself; a dark bare texture is one only with something drawn on it.
            const isColorfulMap = isLargePanel && opaqueEnough && panelLook !== null && !isBareDarkTexture(panelLook) && isColorfulPicture(panelLook);
            if (opaqueEnough && panelLook !== null && (isBareDarkTexture(panelLook) || isColorfulMap)) {
              // Within the page: a panel that bleeds off the edge would otherwise add a blank strip to the render.
              const pageBox = pageBoxByPage.get(pageNumber);
              const withinPage = (box: Rect): Rect => (pageBox === undefined ? box : { minX: Math.max(box.minX, pageBox.minX), minY: Math.max(box.minY, pageBox.minY), maxX: Math.min(box.maxX, pageBox.maxX), maxY: Math.min(box.maxY, pageBox.maxY) });
              // What is rendered is the whole unit (a sign that sticks out of the panel comes with it); what is compared with the raster is the panel's own box.
              const panelBox = withinPage(unit.bbox);
              let drawn = isColorfulMap;
              if (!isColorfulMap) {
                const preview = await renderer.renderRegion(page, withinPage(placedRep), { targetLongEdgePx: PANEL_PREVIEW_LONG_EDGE_PX, signal });
                drawn = isDrawingOnPanel({ textCoverage: panelCoverage, drawnShare: drawnShare(preview, extractResult.image) });
              }
              if (drawn) {
                drawnOnPanel = true;
                const panelLongEdge = await probeIntrinsicLongEdgePx(page, repId);
                extractResult = await extractDirect(
                  page,
                  null,
                  panelBox,
                  renderer,
                  { targetLongEdgePx: computeTargetLongEdgePx({ intrinsicLongEdgesPx: panelLongEdge === null ? [] : [panelLongEdge], representativeMaxRelativeArea: rep.maxRelativeArea, defaultLongEdgePx: targetLongEdgePx, maxLongEdgePx }), signal },
                  pageNumber,
                );
              }
            }
          }

          // Cropping the empty margin —
          // EXCLUSIVELY for units revealed by `Z1-full-bleed-forced-content`
          // (see `cropUniformMargins.ts`), NOT for ordinary content already
          // correctly extracted by the PDF's own structure (which already
          // has the right bbox — cropping its pixels would be pointless and
          // risky).
          let image = extractResult.image;
          // The text of the page that runs past a drawing is painted over: only what lies over the drawing's shapes stays.
          if (unit.reason === VECTOR_FIGURE_REASON && unit.shapeBoxes !== undefined && (pageRotationByPage.get(pageNumber) ?? 0) === 0) {
            image = eraseTextAroundFigure(image, unit.bbox, unit.shapeBoxes, textBlockBoxesByPage.get(pageNumber) ?? []);
          }
          // The page shows a picture painted under a clipping path only where the clip lets it through; the raw
          // resource is the whole sheet (a figure with the neighbor that the page cuts away). What decides whether
          // the picture is worth listing (a blank background, a sparse prop) is measured on the whole resource, as it
          // always was, so that cutting it down does not change what is listed.
          const wholeResource = image;
          const clip = unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.clip;
          // A picture the page turns and shows through a plain rectangle comes out as the page shows it: the window, upright, with no tilted frame.
          const throughWindow = clip !== undefined && extractResult.source !== 'region-render' ? renderThroughRectangularClip(image, clip) : null;
          // A card of text that other cards lie against, taken as a render of its region, shows slices of its neighbours at its edges: the clip it was painted under is what the page shows of it.
          const cardRegionClip = clip !== undefined && extractResult.source === 'region-render' && (unit.reason === HIGH_TEXT_COVERAGE_REASON || unit.reason === TEXT_OVER_SMALL_REASON) && !clipShowsWholePicture(clip) ? clip : undefined;
          const unitArea = rectArea(unit.bbox);
          const hasNeighbourCards = cardRegionClip !== undefined && unitArea > 0 && pageUnits.some((other) => {
            if (other === plannedUnit || !(isCardOfText(other) || other.classification === 'content') || (other.representativeEntry?.maxRelativeArea ?? 0) >= NEIGHBOUR_CARD_MAX_AREA || paintedAt(other) <= paintedAt(plannedUnit)) return false;
            const shared = rectIntersection(unit.bbox, other.bbox);
            return shared !== null && rectArea(shared) >= NEIGHBOUR_CARD_MIN_OVERLAP * unitArea;
          });
          if (cardRegionClip !== undefined && hasNeighbourCards) {
            const regionCtm: Matrix = [unit.bbox.maxX - unit.bbox.minX, 0, 0, unit.bbox.maxY - unit.bbox.minY, unit.bbox.minX, unit.bbox.minY];
            // The neighbours painted later lie over this card: where their clips cover it the page shows them, not the card.
            const holes = pageUnits
              .filter((other) => other !== plannedUnit && (isCardOfText(other) || other.classification === 'content') && (other.representativeEntry?.maxRelativeArea ?? 0) < NEIGHBOUR_CARD_MAX_AREA && paintedAt(other) > paintedAt(plannedUnit))
              .flatMap((other) => {
                const otherClip = other.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.clip;
                if (otherClip !== undefined) return !clipShowsWholePicture(otherClip) ? [{ paths: otherClip.paths, ctm: regionCtm }] : [];
                // A card of text that is not cut by a clip (its shape is in its pixels) is taken by its box: it lies over this one by a good part of it, which is why this is done at all.
                const b = other.bbox;
                return isCardOfText(other) ? [{ paths: [[[b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY]]], ctm: regionCtm }] : [];
              });
            const cut = applyClipToImage(image, { paths: cardRegionClip.paths, ctm: regionCtm }, { holes });
            // A clip that leaves hardly anything of the render is not the card's shape: the render is kept as it is.
            if (cut.width * cut.height >= CLIP_CUT_MIN_REMAINING_SHARE * image.width * image.height) image = cut;
          }
          if (throughWindow !== null) image = throughWindow;
          else if (clip !== undefined && extractResult.source !== 'region-render' && !clipShowsWholePicture(clip)) image = applyClipToImage(image, clip, { hiddenBecomesPaper: unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.blended === true });
          // A picture stored sideways and turned upright on the page: the raw resource has to be turned the same way.
          // A picture painted more than once on a page (a shadow under it, a copy turned the other way) is shown as the last of its paintings shows it.
          const topPainting = rep === null ? undefined : topOccurrenceOnPage(rep, pageNumber);
          const quarterTurns = topPainting?.placement?.quarterTurns;
          if (throughWindow === null && quarterTurns !== undefined && extractResult.source !== 'region-render' && compositionCount === 1) image = rotateQuarterTurns(image, quarterTurns);
          // A picture the page paints mirrored (a negative scale) comes out of the raw resource the other way round.
          const placementOfPainted = topPainting?.placement;
          if (throughWindow === null && (placementOfPainted?.flipX || placementOfPainted?.flipY) && extractResult.source !== 'region-render' && compositionCount === 1) {
            image = mirrorImage(image, placementOfPainted.flipX === true, placementOfPainted.flipY === true);
          }
          // The numbers of a map's key are painted over when the user asked for it.
          if (opts.removeNumberMarkers === true) image = eraseNumberMarkers(image) ?? image;
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
          const luminanceStdDev = unit.classification === 'content' ? computeLuminanceStdDev(wholeResource) : undefined;
          // Also for `content`: the rule that hides a smooth background must not hide a smooth painted portrait.
          const visibleLuminanceStdDev = hideBackgroundImages ? computeVisibleLuminanceStdDev(wholeResource) : undefined;
          // Of the visible pixels: the rules that tell a light sheet from a dark picture (`finalize.ts`) judge candidates of every class.
          const meanLuminance = hideBackgroundImages ? computeVisibleMeanLuminance(wholeResource) : undefined;
          if (plannedUnit.reason === EDGE_FIGURE_REASON) edgeFigureStdDev = computeVisibleLuminanceStdDev(image);
          const darkOpaqueShare = hideBackgroundImages ? computeDarkOpaqueShare(wholeResource) : undefined;
          // Of what is saved (after the clip): a strip cut from a larger sheet by the page's clip may show only white.
          const whiteOpaqueShare = hideBackgroundImages ? computeWhiteOpaqueShare(image) : undefined;
          // [User request] For BOTH candidates shown in the review list — see `UNIFORM_COLOR_MIN_FRACTION` in `finalize.ts`.
          const uniformColorFraction = hideBackgroundImages ? computeUniformColorFraction(wholeResource) : undefined;
          const smoothness = hideBackgroundImages ? computeSmoothnessMetrics(wholeResource) : undefined;
          const opaqueFraction = hideBackgroundImages ? computeOpaqueFraction(wholeResource) : undefined;
          // A panel the page draws behind a box of text: not a picture (see `panelBackdrop.ts`).
          let panelBackdrop = false;
          if (hideBackgroundImages && compositionCount === 1 && rep !== null && rep.objId !== null && placedRep !== undefined && opaqueFraction !== undefined) {
            const rawLook = extractResult.source !== 'region-render' && repId ? await probeRawLook(page, repId) : null;
            panelBackdrop = isPanelBackdrop({
              translucent: isTranslucentEverywhere(rep),
              masked: maskedObjIds.has(rep.objId),
              opaqueFraction,
              textCoverage: textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)),
              extractedRaw: extractResult.source !== 'region-render',
              confidence: unit.confidence,
              look: rawLook,
            });
          }
          // A big picture cut out by a mask that is mostly transparent (a splatter, a smudge) is a decoration whose box happens to be big.
          const sparseLargeCutout = unit.reason === LARGE_MASKED_CUTOUT_REASON && opaqueFraction !== undefined && opaqueFraction < LARGE_CUTOUT_MIN_OPAQUE_FRACTION;
          // A big picture cut out by a mask whose raster is a plain dark texture (a vignette, a shadow laid over the page that reaches off its edge) shows nothing of its own.
          const cutoutLook = unit.reason === LARGE_MASKED_CUTOUT_REASON && repId !== null ? await probeRawLook(page, repId) : null;
          const darkLargeCutout = cutoutLook !== null && cutoutLook.meanLuminance <= DARK_CUTOUT_MAX_MEAN_LUMINANCE && cutoutLook.luminanceStdDev <= DARK_CUTOUT_MAX_STDDEV;
          // A small picture offered only because text lies over its box is kept when it is a cut-out object (mostly transparent: an item on a card); a card or a photo, opaque all over, under text is not.
          const rawOpaque = unit.reason === TEXT_OVER_SMALL_REASON && repId !== null ? await probeOpaqueFraction(page, repId) : null;
          // A raster blended into the page (a strip of tape, a stain) with text under it is not a box of text: it is hidden, not offered as one.
          const isOverlayOfPage = unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.blended === true;
          const textCard = unit.reason === TEXT_OVER_SMALL_REASON && !isPhotoUnderText && (rawOpaque === null || rawOpaque >= CUT_OUT_MAX_OPAQUE_FRACTION);
          // A flush card of text (a stat block on parchment) is the backdrop of its text, not a picture, whether it was extracted raw or as a render with its text on it.
          const flushCardLook = unit.reason === FLUSH_UNDECIDED_REASON && repId !== null ? await probeRawLook(page, repId) : null;
          const flushCard = flushCardLook !== null && isFlushCardOfText(flushCardLook, repId === null ? null : await probeOpaqueFraction(page, repId), placedRep ? textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)) : 0);
          // A render of a picture of the page's layout (not a drawing of paths) with at least 15% of its box covered by page text, on a plain raster: a candidate for a panel of text
          // (a sidebar, a list, a box of rules). Whether the panels are hidden is decided for the whole book (see `isBookOfTextPanels`).
          let textPanelCandidate = false;
          let textPanelKey: string | undefined;
          let textPanelLook: { stdDev: number; saturation: number; mean: number; coverage: number; textOnCenter: boolean } | undefined;
          const panelCoverage = textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber));
          // A picture shown through the outline of its subject (many points) is a cut-out that the text wraps around: the boxes of the wrapped text reach over its middle, but the text is not on it.
          const isCutOutByOutline = unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.clip?.paths.some((path) => path.some((polygon) => polygon.length / 2 > CUT_OUT_OUTLINE_MIN_POINTS)) === true;
          const centerCoverage = textCoverage(shrinkToCenter(unit.bbox), textBlockBoxesByPage.get(pageNumber));
          // Text over most of a render and over most of its middle (a newspaper, a page of a document) is what the render shows, whatever the look of the raster under it.
          const textFillsBox = extractResult.source === 'region-render' && unit.representativeEntry !== null && !isCutOutByOutline && panelCoverage >= TEXT_FILLS_BOX_MIN_COVERAGE && centerCoverage >= TEXT_FILLS_BOX_MIN_COVERAGE;
          if (unit.representativeEntry !== null && repId !== null && extractResult.source === 'region-render' && panelCoverage >= TEXT_PANEL_STYLE_MIN_COVERAGE) {
            const panelLook = await probeRawLook(page, repId);
            textPanelCandidate = isTextPanel(extractResult.source, panelCoverage) && panelLook !== null && panelLook.luminanceStdDev <= TEXT_PANEL_MAX_RAW_STDDEV && panelLook.meanSaturation <= TEXT_PANEL_MAX_RAW_SATURATION;
            if (panelLook !== null && panelLook.luminanceStdDev <= TEXT_PANEL_TINTED_MAX_RAW_STDDEV && panelLook.meanSaturation <= TEXT_PANEL_TINTED_MAX_RAW_SATURATION) {
              textPanelKey = `${unit.representativeEntry.intrinsicWidth}x${unit.representativeEntry.intrinsicHeight}:${panelLook.luminanceStdDev.toFixed(1)}:${panelLook.meanSaturation.toFixed(1)}`;
              textPanelLook = { stdDev: panelLook.luminanceStdDev, saturation: panelLook.meanSaturation, mean: panelLook.meanLuminance, coverage: panelCoverage, textOnCenter: unit.reason === HIGH_TEXT_COVERAGE_REASON || (!isCutOutByOutline && centerCoverage >= TEXT_PANEL_CENTER_MIN_COVERAGE) };
            }
          }
          // A big translucent panel was only let through to be checked for a drawing; without one it is the page's own backdrop.
          if (isLargePanel && !drawnOnPanel) panelBackdrop = true;
          // Grid suggestion — NOT limited to 'content' (unlike
          // `luminanceStdDev` above): 'undecided' can also end up on stage by
          // the user's manual decision in the review screen), and the cost of
          // computing it is negligible relative to the decode already
          // performed anyway.
          const suggestedGrid = detectGrid(image) ?? undefined;
          const encoded = await encoder.encode(image, { format: opts.outputFormat, quality: opts.outputQuality });
          lastPanelImage = isLargePanel && drawnOnPanel ? image : null;

          const pageBoxOfUnit = pageBoxByPage.get(pageNumber);
          const entryForFinalize = unit.representativeEntry ?? syntheticVectorOnlyEntry(pageNumber, unit.bbox, unit.reason === VECTOR_FIGURE_REASON && pageBoxOfUnit !== undefined && rectArea(pageBoxOfUnit) > 0 ? rectArea(unit.bbox) / rectArea(pageBoxOfUnit) : 1);
          // A purely vector region forced to 'content' (line
          // above) is a deliberate, confident decision (a successful render
          // of a vector-drawn map) — it gets high confidence, NOT the lower
          // `undecided` confidence inherited from `unit.confidence` (which
          // described something else: "no image to extract directly").
          if (unit.representativeEntry === null && unit.reason === VECTOR_FIGURE_REASON) figureEntries.add(entryForFinalize);
          const confidence = unit.representativeEntry || unit.reason === VECTOR_FIGURE_REASON ? unit.confidence : confidenceForReason('Z1-large-relative-area');
          // A form or a table that is a picture with its text drawn into it (a filled character sheet): the page has no text of it to find, so the pixels are read.
          const hiddenByPixels = blankSheet || panelBackdrop || sparseLargeCutout || darkLargeCutout || textCard || flushCard || (unit.reason === VECTOR_FIGURE_REASON && unit.representativeEntry === null && whiteOpaqueShare !== undefined && whiteOpaqueShare >= FIGURE_MAX_WHITE_SHARE);
          const rasterMeasure = hideBackgroundImages && !hiddenByPixels && unit.classification !== 'decoration' && unit.classification !== 'mask' ? measureRasterText(image) : null;
          const rasterForm = rasterMeasure !== null && (isFormOrTable(rasterMeasure) || looksLikeDocument(rasterMeasure) || looksLikeLargePrintNote(rasterMeasure) || looksLikeDocumentOnDark(rasterMeasure));
          // A splatter of blood or paint laid on the page is the page's decoration, not a picture.
          // A splatter painted with a blend mode is rendered on the page's tinted paper, where its ink is not on white: its own raster shows it on white.
          let splatterOnTint = false;
          if (hideBackgroundImages && !hiddenByPixels && !rasterForm && unit.classification !== 'decoration' && unit.classification !== 'mask' && extractResult.source === 'region-render' && repId !== null && isBlendedOnPage(unit.representativeEntry ?? rep!)) {
            const rawOfRep = await extractDirect(page, repId, unit.bbox, renderer, { targetLongEdgePx, signal }, pageNumber);
            splatterOnTint = rawOfRep.source !== 'region-render' && looksLikeInkSplatter(rawOfRep.image);
          }
          const inkSplatter = hideBackgroundImages && !hiddenByPixels && !rasterForm && unit.classification !== 'decoration' && unit.classification !== 'mask' && (splatterOnTint || looksLikeInkSplatter(image));
          // A track of tick boxes (stress, wounds) belongs to the character sheet and is no picture either.
          const boxTrack = hideBackgroundImages && !hiddenByPixels && !rasterForm && !inkSplatter && unit.classification !== 'decoration' && unit.classification !== 'mask' && looksLikeTrackOfBoxes(image);
          // A banner (a title on a plate of colour) is no picture and no box of text: it is not offered at all.
          let headingBanner = false;
          if (hideBackgroundImages && !hiddenByPixels && extractResult.source === 'region-render' && repId !== null && unit.classification !== 'decoration' && unit.classification !== 'mask') {
            const everyText = textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber));
            const headings = textCoverage(unit.bbox, headingBlockBoxesByPage.get(pageNumber));
            if (isHeadingBannerText(everyText, headings)) {
              const bannerLook = await probeRawLook(page, repId);
              headingBanner = bannerLook !== null && bannerLook.luminanceStdDev <= BANNER_MAX_RAW_STDDEV;
            }
          }
          const result: PreparedEntryForFinalize<EncodedImage> = {
            entry: entryForFinalize,
            classification: hiddenByPixels || rasterForm || inkSplatter || boxTrack || headingBanner ? 'decoration' : unit.representativeEntry || unit.reason === VECTOR_FIGURE_REASON ? unit.classification : 'content',
            confidence,
            extractSource: extractResult.source,
            contentHash,
            width: image.width,
            height: image.height,
            luminanceStdDev,
            meanLuminance,
            visibleLuminanceStdDev,
            darkOpaqueShare,
            whiteOpaqueShare,
            uniformColorFraction,
            smoothness,
            opaqueFraction,
            suggestedGrid,
            textPanelCandidate,
            textPanelKey,
            textFillsBox: textFillsBox ? true : undefined,
            textOnPaperCard: textOnPaperCard || (unit.reason === HIGH_TEXT_COVERAGE_REASON && extractResult.source === 'region-render' && photoLook !== null && photoLook.meanLuminance >= PAPER_CARD_MIN_MEAN_LUMINANCE && centerCoverage >= PAPER_NOTE_MIN_CENTER_COVERAGE) ? true : undefined,
            textPanelLook,
            holdsText: !headingBanner && ((rasterForm && unit.representativeEntry !== null) || ((textCard || flushCard) && !blankSheet && !panelBackdrop && !sparseLargeCutout && !darkLargeCutout && !isOverlayOfPage)) ? true : undefined,
            payload: encoded,
          };
          imageByItem.set(result, image);
          if (rasterForm) formPages.add(unit.page);
          else if (rasterMeasure !== null && !inkSplatter && !boxTrack && isPartOfSheet(rasterMeasure)) possibleSheetParts.push({ item: result, page: unit.page });
          return result;
      };

      // The right piece of a picture stored in two pieces on one page waits for the left one, which is extracted first.
      const unitOfMembers = (u: ExtractionUnit, members: readonly ImageEntry[], boxes: readonly Rect[]): ExtractionUnit => {
        const representative = members.reduce((best, m) => (m.maxRelativeArea > best.maxRelativeArea ? m : best));
        const judged = classifiedByEntry.get(representative);
        return {
          representativeEntry: representative,
          memberEntries: members,
          page: u.page,
          bbox: boxes.reduce((acc, b) => unionRect(acc, b)),
          clusterMemberCount: members.length,
          classification: judged?.classification ?? u.classification,
          confidence: judged?.confidence ?? u.confidence,
          reason: judged?.reason ?? u.reason,
        };
      };
      // The pictures of a unit that are not one picture: a white wash the page lays under its pictures is a unit of its own, and small pictures whose boxes overlap
      // but whose visible pixels do not (cut-out objects laid out side by side, a rack of weapons) are separate pictures.
      // Pictures drawn on white paper and multiplied onto the page (figures that stand on the page's own tint): their rasters overlap by their paper, which shows
      // nothing. When the inked parts of the rasters do not overlap, they are separate pictures, each taken from its own pixels (a render would carry the page's text).
      const splitBlendedByInk = async (u: ExtractionUnit): Promise<ExtractionUnit[] | null> => {
        const placedInk: { entry: ImageEntry; item: PlacedMask }[] = [];
        for (const member of u.memberEntries) {
          const own = member.occurrences.find((o) => o.page === pageNumber);
          const memberId = idOnThisPage(member);
          if (own === undefined || memberId === null || member.objId === null || own.blended !== true || own.clip !== undefined || own.placement?.rotated === true) return null;
          if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
          const mask = await probeInkMask(page, memberId);
          if (mask === null) return null;
          placedInk.push({ entry: member, item: { box: own.bbox, flipX: own.placement?.flipX === true, flipY: own.placement?.flipY === true, mask } });
        }
        // Tiles that lie edge to edge (a row of icons cut from one strip) are one picture even though their inked parts do not overlap.
        const tileOf = (p: (typeof placedInk)[number]): TileSource | undefined => (p.entry.intrinsicWidth === null || p.entry.intrinsicHeight === null ? undefined : { box: p.item.box, pixelWidth: p.entry.intrinsicWidth, pixelHeight: p.entry.intrinsicHeight });
        const groups = connectedGroups(placedInk.length, (i, j) => {
          if (placedInksOverlap(placedInk[i]!.item, placedInk[j]!.item)) return true;
          const a = tileOf(placedInk[i]!);
          const b = tileOf(placedInk[j]!);
          return a !== undefined && b !== undefined && areSeamedTiles(a, b);
        });
        if (groups.length < 2) return null;
        return groups.map((indices) => unitOfMembers(u, indices.map((i) => placedInk[i]!.entry), indices.map((i) => placedInk[i]!.item.box)));
      };
      const splitByVisiblePixels = async (u: ExtractionUnit): Promise<ExtractionUnit[]> => {
        if (u.memberEntries.length < 2 || u.representativeEntry === null || spreadRightOf.has(u) || spreadRightHalves.has(u)) return [u];
        const byInk = await splitBlendedByInk(u);
        if (byInk !== null) return byInk;
        const pieces: ExtractionUnit[] = [];
        let rest = u;
        const wash = u.representativeEntry;
        const washId = idOnThisPage(wash);
        const washBox = wash.occurrences.find((o) => o.page === pageNumber)?.bbox;
        if (wash.objId !== null && washId !== null && washBox !== undefined && wash.maxRelativeArea >= UNDER_PICTURES_MIN_AREA) {
          if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [washId], settleBudgetMs);
          const washLook = await probeRawLook(page, washId);
          // A white mist, or a plain card of paper the page's text lies on: what the small pictures of the unit lie on, not a picture of the unit.
          const isCardOfText = isSmallCardOfText(wash.maxRelativeArea, washLook, await probeOpaqueFraction(page, washId), textCoverage(washBox, textBlockBoxesByPage.get(pageNumber)));
          const others = u.memberEntries.filter((m) => m !== wash);
          // A card of text that has only cut-out objects (on a transparent ground) lying on it: the cards of items, not a note with a photo pinned to it.
          let onlyCutOuts = isCardOfText && others.every((m) => m.maxRelativeArea >= CARD_ITEM_MIN_AREA);
          for (const m of onlyCutOuts ? others : []) {
            const memberId = idOnThisPage(m);
            if (memberId === null) { onlyCutOuts = false; break; }
            if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
            const opaque = await probeOpaqueFraction(page, memberId);
            if (opaque === null || opaque >= CUT_OUT_MAX_OPAQUE_FRACTION) { onlyCutOuts = false; break; }
          }
          if ((looksLikeWhiteWash(washLook) && !maskedObjIds.has(wash.objId)) || onlyCutOuts) {
            const otherBoxes = others.map((m) => m.occurrences.find((o) => o.page === pageNumber)?.bbox).filter((b): b is Rect => b !== undefined);
            if (others.length > 0 && otherBoxes.length === others.length) {
              const card = unitOfMembers(u, [wash], [washBox]);
              // The card the text lies on is not a picture of the page: it is hidden, and the pictures that lay on it are offered.
              pieces.push(onlyCutOuts ? { ...card, classification: 'decoration' } : card);
              rest = unitOfMembers(u, others, otherBoxes);
            }
          }
        }
        if (rest.memberEntries.length < 2) return [...pieces, rest];
        const placed: { entry: ImageEntry; item: PlacedMask; framed: boolean }[] = [];
        for (const member of rest.memberEntries) {
          const own = member.occurrences.find((o) => o.page === pageNumber);
          const memberId = idOnThisPage(member);
          if (own === undefined || memberId === null || member.objId === null || maskedObjIds.has(member.objId) || isTranslucentEverywhere(member) || member.maxRelativeArea >= INDEPENDENT_IMAGE_AREA_THRESHOLD) return [...pieces, rest];
          // A picture in a frame, turned or blended is taken for opaque all over its box: its pixels are not mapped.
          if (own.clip !== undefined || own.placement?.rotated === true || own.blended === true) {
            placed.push({ entry: member, framed: true, item: { box: own.bbox, flipX: false, flipY: false, mask: { width: 1, height: 1, opaque: new Uint8Array([1]) } } });
            continue;
          }
          if (settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, [memberId], settleBudgetMs);
          const mask = await probeOpaqueMask(page, memberId);
          if (mask === null) return [...pieces, rest];
          placed.push({ entry: member, framed: false, item: { box: own.bbox, flipX: own.placement?.flipX === true, flipY: own.placement?.flipY === true, mask } });
        }
        // The tiles of one picture lie edge to edge: their visible pixels hardly overlap, but they are not separate pictures.
        const tileOf = (p: (typeof placed)[number]): TileSource | undefined => (p.framed || p.entry.intrinsicWidth === null || p.entry.intrinsicHeight === null ? undefined : { box: p.item.box, pixelWidth: p.entry.intrinsicWidth, pixelHeight: p.entry.intrinsicHeight });
        const groups = connectedGroups(placed.length, (i, j) => {
          if (placedMasksOverlap(placed[i]!.item, placed[j]!.item)) return true;
          const a = tileOf(placed[i]!);
          const b = tileOf(placed[j]!);
          return a !== undefined && b !== undefined && areSeamedTiles(a, b);
        });
        if (groups.length < 2) return [...pieces, rest];
        return [...pieces, ...groups.map((indices) => unitOfMembers(u, indices.map((i) => placed[i]!.entry), indices.map((i) => placed[i]!.item.box)))];
      };
      const pageUnits: ExtractionUnit[] = [];
      for (const planned of unitsByPage.get(pageNumber) ?? []) pageUnits.push(...(await splitByVisiblePixels(planned)));
      // A unit split into its pictures is more units to extract: the total grows with them, so the progress never runs past it.
      total += pageUnits.length - (unitsByPage.get(pageNumber)?.length ?? 0);
      const rightPieceOf = new Map<ExtractionUnit, ExtractionUnit>();
      for (const [leftUnit, rightUnit] of spreadRightOf) if (leftUnit.page === pageNumber && rightUnit.page === pageNumber) rightPieceOf.set(leftUnit, rightUnit);
      const rightPieces = new Set(rightPieceOf.values());
      const orderedUnits = pageUnits.flatMap((u) => (rightPieces.has(u) ? [] : rightPieceOf.has(u) ? [u, rightPieceOf.get(u)!] : [u]));
      for (const plannedUnit of orderedUnits) {
        checkAborted(signal);
        if (plannedUnit.reason === EDGE_FIGURE_REASON) {
          const rep = plannedUnit.representativeEntry;
          const maskIds = rep?.objId ? (maskHoldersByTarget.get(rep.objId) ?? []).map(idOnThisPage).filter((id): id is string => id !== null) : [];
          if (maskIds.length > 0 && settleBudgetMs > 0) settleBudgetMs -= await waitForObjects(page, maskIds, settleBudgetMs);
          const rectangularity = maskIds.length > 0 ? await probeMaskRectangularity(page, maskIds[0]!) : null;
          if (rectangularity === null || rectangularity >= SILHOUETTE_MAX_RECTANGULARITY) {
            done++;
            onProgress?.(done, total);
            continue;
          }
        }
        try {
          // The picture a unit stands for may turn out to be one that is hidden from the list as a background or
          // a prop (a faded vignette painted over the illustration it frames): then the next picture of
          // consequence in the unit gets its turn, instead of the whole unit vanishing.
          const candidates = [plannedUnit, ...alternativeRepresentatives(plannedUnit)];
          edgeFigureStdDev = undefined;
          let item = await extractUnit(candidates[0]!);
          if (plannedUnit.reason === EDGE_FIGURE_REASON && (item.extractSource === 'region-render' || (edgeFigureStdDev ?? 0) < EDGE_FIGURE_MIN_STDDEV)) {
            done++;
            onProgress?.(done, total);
            continue;
          }
          for (let i = 1; i < candidates.length && isNeverWorthReviewing(item); i++) {
            const alternative = await extractUnit(candidates[i]!);
            if (!isNeverWorthReviewing(alternative)) item = alternative;
          }
          const isPanelHalf = plannedUnit.reason === LARGE_TRANSLUCENT_PANEL_REASON;
          // A panel half is joined when a drawing was found on it. Any other half is joined when it is the left one and is offered; the right
          // half may be a picture that is not offered by itself (a trailing wisp of the drawing, mostly transparent): it still belongs to the left one.
          const halfImage = isPanelHalf ? lastPanelImage : (imageByItem.get(item) ?? null);
          const offered = isPanelHalf || !isNeverWorthReviewing(item);
          // The left half of a picture across a spread waits through the rest of its page for the right half on the next one.
          if (pendingLeftHalf !== null && plannedUnit.page > pendingLeftHalf.page + 1) {
            prepared.push(pendingLeftHalf.item);
            pendingLeftHalf = null;
          }
          if (halfImage !== null && offered && spreadRightOf.has(plannedUnit)) {
            if (pendingLeftHalf !== null) prepared.push(pendingLeftHalf.item);
            pendingLeftHalf = { item, image: halfImage, page: plannedUnit.page, isPanel: isPanelHalf, box: plannedUnit.bbox };
          } else if (pendingLeftHalf !== null && spreadRightHalves.has(plannedUnit)) {
            // Two halves cut with a margin overlap on the page: the right one shows again the columns the left one ends with.
            const overlapPt = pendingLeftHalf.page === plannedUnit.page ? pendingLeftHalf.box.maxX - plannedUnit.bbox.minX : 0;
            const rightHalf = halfImage !== null && overlapPt > 0 && plannedUnit.bbox.maxX > plannedUnit.bbox.minX ? dropLeftColumns(halfImage, (overlapPt * halfImage.width) / (plannedUnit.bbox.maxX - plannedUnit.bbox.minX)) : halfImage;
            if (rightHalf !== null && pendingLeftHalf.isPanel === isPanelHalf && (isPanelHalf || halvesContinueAcrossSeam(pendingLeftHalf.image, rightHalf, { blankSeamJoins: pendingLeftHalf.page === plannedUnit.page }))) {
              const joined = stitchHorizontally(pendingLeftHalf.image, rightHalf);
              const joinedPayload = await encoder.encode(joined, { format: opts.outputFormat, quality: opts.outputQuality });
              prepared.push({ ...pendingLeftHalf.item, width: joined.width, height: joined.height, contentHash: await computeContentHash(joined), suggestedGrid: detectGrid(joined) ?? undefined, payload: joinedPayload });
            } else {
              prepared.push(pendingLeftHalf.item, item);
            }
            pendingLeftHalf = null;
          } else {
            prepared.push(item);
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          diagnostics.push({
            severity: 'error',
            code: 'IMAGE_EXTRACTION_FAILED',
            params: { objId: plannedUnit.representativeEntry?.objId ?? '(vector-region)', error: err instanceof Error ? err.message : String(err) },
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

  if (pendingLeftHalf !== null) prepared.push(pendingLeftHalf.item);
  // The other part of a sheet whose first part was recognised (its second page, drawn in a handwriting): text in a picture as well.
  for (const part of possibleSheetParts) {
    if (!formPages.has(part.page)) continue;
    part.item.classification = 'decoration';
    part.item.holdsText = true;
  }
  const finalized = finalizeImages(prepared, nearStatblockOrHeadingObjIds, diagnostics);

  const isOffered = (i: { classification: ImageClassification }): boolean => i.classification === 'content' || i.classification === 'undecided';
  const offeredBoxesByPage = new Map<number, Rect[]>();
  for (const i of finalized.images) {
    if (figureEntries.has(i.entry) || !isOffered(i)) continue;
    for (const o of i.entry.occurrences) offeredBoxesByPage.set(o.page, [...(offeredBoxesByPage.get(o.page) ?? []), o.bbox]);
  }
  // A drawing whose box is mostly covered by a picture that is offered (a plan drawn on a panel that is itself offered) is that picture again.
  const images = finalized.images.filter((i) => {
    if (!figureEntries.has(i.entry)) return true;
    const own = i.entry.occurrences[0];
    if (own === undefined || rectArea(own.bbox) <= 0) return true;
    const covered = (offeredBoxesByPage.get(own.page) ?? []).reduce((sum, b) => sum + rectArea(rectIntersection(own.bbox, b) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0);
    return covered / rectArea(own.bbox) < FIGURE_MAX_IMAGE_COVER;
  });

  return {
    images,
    correlationClosedByBBox: finalized.correlationClosedByBBox,
    correlationClosedByHash: finalized.correlationClosedByHash,
    duplicatesRemoved: finalized.duplicatesRemoved,
    diagnostics,
  };
}
