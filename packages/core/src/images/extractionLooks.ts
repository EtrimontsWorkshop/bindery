import { rectArea, rectIntersection, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import { FLUSH_UNDECIDED_REASON, FULL_PAGE_DOCUMENT_REASON, LARGE_MASKED_CUTOUT_REASON, TEXT_BESIDE_BLENDED_REASON, TEXT_OVER_SMALL_REASON, LARGE_TRANSLUCENT_PANEL_REASON, isTranslucentEverywhere, type ClassifiedImage } from './classify.js';
import type { OpaqueMask } from './opaqueOverlap.js';
import { probeMaskRectangularity, probeMeanBrightnessFraction, type PdfPageForExtract } from './extract.js';
import { CO_MEMBER_SIGNIFICANT_AREA } from './strategy.js';

/**
 * Image extraction, rules about what a picture LOOKS like and how the page's text lies over it: paper, card, photo,
 * panel, banner, cover; text coverage and text crossing an edge; masks. Each rule is a threshold with the reason it
 * was measured, and a small function that applies it. Moved out of `buildImageExtraction.ts` unchanged.
 */

/** Reasonable default target for scenes/handouts — configurable per call, for calibration against real documents. */
export const DEFAULT_TARGET_LONG_EDGE_PX = 2048;
/**
 * Page-area share from which a picture split off a unit is offered even when it is only `undecided` (below it,
 * only `content` pictures are split off, so that small leftovers of the stack do not clutter the list).
 */
export const SPLIT_OFF_MIN_AREA = 0.1;
/** The reason of a picture that page text covers in its middle (see `classify.ts`). */
export const HIGH_TEXT_COVERAGE_REASON = 'Z10-high-center-text-coverage';
/** The classifier's reason for a picture that the page's body text covers (taken for a backdrop). */
export const TEXT_COVERED_BACKDROP_REASON = 'Z9-high-body-text-coverage';
/** A box of a text-covered picture that is a note, not a page background: its share of the page at most. */
export const NOTE_MAX_AREA = 0.3;
/** The share of a piece's box that the page's text crosses the edge of, from which the piece is cut out of a larger note. */
export const NOTE_PIECE_MIN_TEXT_CROSSING = 0.5;
/** A picture of at least this page-area share, offered by itself, is cut away from the card of text it lies over (see `cardWithoutPictures`). */
/**
 * A raster of a unit that is only offered because page text lies over its box is a photo with notes pinned over it (a cork board), not a card of text, when it is dark on the whole
 * and has a picture's texture, and the text is not over its middle. Measured on one rulebook: the cards of text have a mean luminance of 217-233, the photos 45-116 with a texture
 * deviation of 15-41 and 0.22-0.43 of their middle under text; the empty dark backdrops of cards in other books (a green stone, a grey plate) have a deviation of 1-16 or 0.59-0.92 of
 * their middle under text.
 */
export const PHOTO_UNDER_TEXT_MAX_MEAN_LUMINANCE = 170;
/** A plain card of text this light is paper (measured: 198-236 for the cards of text of one rulebook, 71-139 for the maps with labels). */
export const PAPER_CARD_MIN_MEAN_LUMINANCE = 170;
/** A raster that is not one of the notes pinned on a photo and that the page labels (a map) is taken raw only when it is lighter than a black shape: the raw of a photo on black is a black shape, which is hidden. Measured: the maps 71-139, the black polaroid photo 27. */
export const MAP_UNDER_LABELS_MIN_MEAN_LUMINANCE = 60;
/** A note on light paper whose middle the page's text covers this much is a box of text, whatever the texture of its torn edges and stains (a card with a raw deviation of 40 and 0.81 of its middle under text). */
export const PAPER_NOTE_MIN_CENTER_COVERAGE = 0.5;
export const PHOTO_UNDER_TEXT_MIN_STDDEV = 10;
export const PHOTO_UNDER_TEXT_MAX_CENTER_COVERAGE = 0.5;

export function isPhotoUnderNotes(look: { meanLuminance: number; luminanceStdDev: number } | null, centerTextCoverage: number): boolean {
  return look !== null && look.meanLuminance < PHOTO_UNDER_TEXT_MAX_MEAN_LUMINANCE && look.luminanceStdDev >= PHOTO_UNDER_TEXT_MIN_STDDEV && centerTextCoverage <= PHOTO_UNDER_TEXT_MAX_CENTER_COVERAGE;
}
export const PICTURE_OVER_CARD_MIN_AREA = 0.05;
/**
 * A banner: a flat plate (a title of a chapter on a band of colour) whose only text is headings. At least this share of its box is under the page's text and at least this much of that text is
 * headings, on a raster whose own pixels have no texture (a deviation of at most `BANNER_MAX_RAW_STDDEV`; the art that a title is laid over has far more, and so have the handwritten notes whose
 * lines the layout takes for headings: 9-20). Measured on the four chapter banners of one rulebook (0.43-0.54 under text, all of it headings, a blank raster under them) and on the box of text beside
 * them (0.54 under text, 0.05 of it headings), and on a banner with a warning on a dark plate (deviation 4.8).
 */
export const BANNER_MIN_TEXT_COVERAGE = 0.3;
export const BANNER_MIN_HEADING_SHARE = 0.9;
export const BANNER_MAX_RAW_STDDEV = 6;

/** Whether the page's text over a plate, and the share of it that is headings, are those of a banner (see `BANNER_MIN_TEXT_COVERAGE`). */
export function isHeadingBannerText(textOverPlate: number, headingsOverPlate: number): boolean {
  return textOverPlate >= BANNER_MIN_TEXT_COVERAGE && headingsOverPlate >= BANNER_MIN_HEADING_SHARE * textOverPlate;
}
/**
 * A card of the page that is painted later and overlaps this share of a card's box lies over it: the render shows that card on this one, and the visible part of this one is what the clips leave.
 * Measured: the two cards that are covered that much by a later card (a note under a larger note, a card under a banner) 0.43-0.45; the cards that touch their neighbours at their edges only 0.01-0.26,
 * whose own clip would cut away their own writing. A picture bigger than the limit is a backdrop, not a neighbour.
 */
export const NEIGHBOUR_CARD_MIN_OVERLAP = 0.4;
export const NEIGHBOUR_CARD_MAX_AREA = 0.6;
/** A cut that leaves less than this share of the render's pixels is a mistake of the clip, not the card's shape. */
export const CLIP_CUT_MIN_REMAINING_SHARE = 0.25;
/** The share of the middle of a panel's box that the page's text covers from which the text lies ON the panel (a note), not beside it (a cut-out the text wraps around). */
export const TEXT_PANEL_CENTER_MIN_COVERAGE = 0.4;
/** A clip with more points than this is the outline of a subject, not the frame of a note (whose torn edge has a few points). */
export const CUT_OUT_OUTLINE_MIN_POINTS = 12;
/** A raster this dark and this even (measured: mean 7.7, spread 1.2 for a shadow laid over a page; dark paintings and figures in black are well above both) shows nothing of its own. */
export const DARK_CUTOUT_MAX_MEAN_LUMINANCE = 20;
export const DARK_CUTOUT_MAX_STDDEV = 5;
/** The share of a render's box, and of its middle, that the page's text covers from which the render is a box of text whatever its look (a newspaper). */
export const TEXT_FILLS_BOX_MIN_COVERAGE = 0.6;
/** Share of the largest picture split off from a unit from which another picture of the unit is split off too, however small it is. */
export const SPLIT_PEER_MIN_SHARE = 0.75;

/** Default for `objectSettleTimeoutMs`. */
export const DEFAULT_OBJECT_SETTLE_TIMEOUT_MS = 1500;
/** How long a page waits for the worker to send the resources its operator list depends on before giving up on the worker (see `waitForDependencies`). */
export const DEPENDENCY_TIMEOUT_MS = 60_000;

/** Default hard ceiling — configurable via `maxLongEdgePx`. */
export const DEFAULT_MAX_LONG_EDGE_PX = 4096;
/** Same threshold as `LARGE_AREA_CONTENT_THRESHOLD` in `classify.ts` — consistency between "large image = content" and "large vector with no image = a drawn map". */
export const LARGE_VECTOR_AREA_THRESHOLD = 0.4;
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
export const CLUSTER_AREA_SAFEGUARD_THRESHOLD = 0.85;

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
export const INDEPENDENT_IMAGE_AREA_THRESHOLD = 0.1;
/**
 * A large picture of a unit is looked at by its pixels when less than this share of its raster is opaque: a cut-out (a shield, a bow drawn
 * on a transparent ground, its box over the box of the next item). Measured on one book: such items 0.2-0.5 opaque.
 */
export const LARGE_CUT_OUT_MAX_OPAQUE_SHARE = 0.9;
export function opaqueShare(mask: OpaqueMask): number {
  return mask.opaque.length === 0 ? 1 : mask.opaque.reduce((sum, v) => sum + v, 0) / mask.opaque.length;
}
/** Page-area share from which the largest raster of a unit can be a wash or a card that the unit's small pictures lie on. */
export const UNDER_PICTURES_MIN_AREA = 0.05;
/** Share of opaque pixels below which a picture is a cut-out object on a transparent ground (a figure, an item) and not a photo. */
export const CUT_OUT_MAX_OPAQUE_FRACTION = 0.6;
/** Share of a plain card that page text must cover for the card to be one the text lies on (the cards of items have a line or two of it). */
export const CARD_UNDER_PICTURES_MIN_TEXT_COVERAGE = 0.03;
/** A card of items is small (the cards of one rulebook are 7% of the page), light paper, and has items of consequence on it, not a speck or a crest. */
export const CARD_UNDER_PICTURES_MAX_AREA = 0.1;
export const CARD_UNDER_PICTURES_MIN_LUMINANCE = 200;
export const CARD_ITEM_MIN_AREA = 0.02;
/** A flush card of text (a stat block on parchment) is opaque over this share and has at least this share of its box covered by text. */
export const FLUSH_CARD_MIN_OPAQUE_FRACTION = 0.85;
export const FLUSH_CARD_MIN_TEXT_COVERAGE = 0.15;
/**
 * A plain sheet of paper that the page paints a picture on, as two images (the bare sheet, then the drawing over it):
 * offered by itself the sheet is an empty page of paper. Taken for the drawing's backdrop when a picture of the page
 * painted after it covers this share of its box, its own pixels are this plain (luminance spread), and the page's text
 * does not lie on it (that is a card of text, kept with its text). Measured on one book: the bare sheets under its
 * drawings 12.6-13.2, the drawings 41-56; the sheet under a smaller drawing covered 0.59 of its box.
 */
export const PAPER_UNDER_PICTURE_MIN_COVER = 0.3;
/**
 * The raster of a page that is a document is a sheet of paper: smooth, tinted, neither white nor dark. Measured on one
 * book: the paper of its letters and diary pages a mean luminance of 187, a spread of 10 and a saturation of 57; a page
 * of another book with its own raster under its text is a white sheet (254, 6-7, 0) with the page's design drawn on it.
 */
export const DOCUMENT_PAPER_MIN_MEAN = 120;
export const DOCUMENT_PAPER_MAX_MEAN = 245;
export const DOCUMENT_PAPER_MAX_STDDEV = 30;
export const DOCUMENT_PAPER_MIN_SATURATION = 15;

/**
 * A sheet of paper that the page writes on: light enough to be paper, a little stained or creased, with little text of
 * its own (`WRITTEN_PAPER_MAX_RASTER_LINES`: the scraps of the sheets under it that show at its edges), and the page's
 * words over a good part of it. Measured on one book that gives every page a sheet of its own: its sheets at a mean
 * luminance of 222-237, a spread of 14-35, a saturation of 8-20, up to 10 lines of letters at their edges, with the
 * page's text over them; a white page (254, 6-7, 0) is a page's design, not a sheet.
 */
export const WRITTEN_PAPER_MIN_MEAN = 120;
export const WRITTEN_PAPER_MAX_MEAN = 245;
export const WRITTEN_PAPER_MAX_STDDEV = 40;
export const WRITTEN_PAPER_MIN_SATURATION = 5;
export const WRITTEN_PAPER_MAX_RASTER_LINES = 15;
export const WRITTEN_PAPER_MIN_WORD_COVERAGE = 0.15;
/**
 * A sheet that the page's words cover for half or more is a page of text whatever its paper looks like: its paper may be
 * busier (a stack of sheets with dark edges, a scrap of a picture at its corner) up to this spread. Labels never cover
 * half of a map. Measured on one book: a sheet under a full page of text at a spread of 50, its words over 0.99 of it.
 */
export const WRITTEN_PAPER_FULL_MIN_WORD_COVERAGE = 0.5;
export const WRITTEN_PAPER_FULL_MAX_STDDEV = 60;
/**
 * A sheet that the page draws a picture on with vector paths (a map: its water, its land, its roads, with labels over
 * them) is that picture, not a written sheet: the page's vector regions cover at least this share of it. Measured on 4
 * books: the maps of one book on their paper at 0.96-2.65 (the regions overlap), the written sheets and cards at 0-0.01.
 * Regions of half the page or more are the page's own frames and backdrops and are not counted.
 */
export const WRITTEN_PAPER_MAX_VECTOR_COVER = 0.5;
export const WRITTEN_PAPER_VECTOR_MAX_PAGE_SHARE = 0.5;
/** A sheet is at least this big (each side, in points, and a share of the page): a thin strip or a rule under a line of text is not one. */
export const WRITTEN_PAPER_MIN_SIDE_PT = 36;
/**
 * The text written on a sheet stays on it; the text of the page running over a patch of the page's paper texture runs
 * past its edges. At most this share of the words on the sheet (by area) may be cut by its edges. Measured on 3 books:
 * the sheets and cards 0-0.04, the patches of a page's paper under its running text 0.48-1.
 */
export const WRITTEN_PAPER_MAX_CROSSING_SHARE = 0.2;
export const WRITTEN_PAPER_MIN_PAGE_SHARE = 0.02;
/** A sheet of paper is opaque over this share of its raster at least. Measured on one book: a figure cut out of a transparent ground, the page's text beside it, 0.32. */
export const WRITTEN_PAPER_MIN_OPAQUE_FRACTION = 0.6;

/** Whether a raster looks like a sheet of paper to be written on (see `WRITTEN_PAPER_MIN_MEAN`). */
export function isWrittenPaper(look: { meanLuminance: number; luminanceStdDev: number; meanSaturation: number }, wordCoverage = 0): boolean {
  const maxStdDev = wordCoverage >= WRITTEN_PAPER_FULL_MIN_WORD_COVERAGE ? WRITTEN_PAPER_FULL_MAX_STDDEV : WRITTEN_PAPER_MAX_STDDEV;
  return look.meanLuminance >= WRITTEN_PAPER_MIN_MEAN && look.meanLuminance <= WRITTEN_PAPER_MAX_MEAN && look.luminanceStdDev <= maxStdDev && look.meanSaturation >= WRITTEN_PAPER_MIN_SATURATION;
}

/** Whether a page's raster looks like a sheet of document paper (see `DOCUMENT_PAPER_MIN_MEAN`). */
export function isDocumentPaper(look: { meanLuminance: number; luminanceStdDev: number; meanSaturation: number }): boolean {
  return look.meanLuminance >= DOCUMENT_PAPER_MIN_MEAN && look.meanLuminance <= DOCUMENT_PAPER_MAX_MEAN && look.luminanceStdDev <= DOCUMENT_PAPER_MAX_STDDEV && look.meanSaturation >= DOCUMENT_PAPER_MIN_SATURATION;
}
/** Share of the part of a card that a picture covers which the page's words may cover for the picture to be taken off the card's render (see `coverWithRaster`). */
export const PICTURE_OVER_CARD_MAX_WORD_COVERAGE = 0.05;
/** Share of a rendered picture that the page's words must cover for it to be turned the way its text reads (a map's labels cover far less). */
export const TURN_MIN_WORD_COVERAGE = 0.15;
export const PAPER_UNDER_PICTURE_MAX_STDDEV = 20;
/**
 * Share of a sheet's width and height left out at each edge when the whole of it is not plain: a page's paper laid on a
 * dark ground that shows round its edges. Measured on one book: such a sheet spread 58 whole (see `probeRawLook`).
 */
export const PAPER_UNDER_PICTURE_EDGE_INSET = 0.15;
/** Share of a document's box that a picture painted over it must cover for the document to be one under a picture (see `looksLikeCoveredDocument`). Measured on one book: a memo under a photograph, covered 0.67. */
export const DOCUMENT_UNDER_PICTURE_MIN_COVER = 0.4;
/** Share of the box of a rendered image that page text must cover for the image to be a panel of text (measured on one rulebook: its panels of text are 18%-90%, its pictures and drawings with captions 0%-6%). */
export const TEXT_PANEL_HIDE_MIN_COVERAGE = 0.15;
/** The raster of a panel of text is a smooth, almost colorless gradient (measured on one rulebook: a luminance spread of 8-27 and a saturation of 5-31 on all its 192 panels). */
export const TEXT_PANEL_MAX_RAW_STDDEV = 30;
export const TEXT_PANEL_MAX_RAW_SATURATION = 32;
/** A tinted panel (parchment, dark green) is smooth too: it is told from a picture by the book repeating its look (see `repeatedPanelLooks`), not by its color alone (measured: the cards of one rulebook 11-34 and the pictures with captions from 45). */
/** The text coverage from which a render can be a tinted panel (the cards of a layout carry a few lines of text: 10%-60% of their box measured on one rulebook, its pictures with captions below 8%). */
export const TEXT_PANEL_STYLE_MIN_COVERAGE = 0.08;
export const TEXT_PANEL_TINTED_MAX_RAW_STDDEV = 36;
export const TEXT_PANEL_TINTED_MAX_RAW_SATURATION = 140;
export const EDGE_TOUCH_MAX_OVERLAP_RATIO = 0.2;

export function isAnchorCandidate(c: ClassifiedImage): boolean {
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
export function isForcedFullBleedContent(c: ClassifiedImage): boolean {
  return c.reason === 'Z1-full-bleed-forced-content';
}

/**
 * Share of a picture's own area that text blocks must cover for the text to count as part of the picture.
 * Measured on a real rulebook across the masked pictures: photos have 0-13% (a caption laid over a corner,
 * a neighbor's note), paper notes and newspaper handouts 40%-95%.
 */
export const TEXT_OVER_PICTURE_FRACTION = 0.3;
/**
 * A plain panel with a stat block on it (a character card): its raster is a smooth, opaque sheet and the text on it
 * is the point. Measured on a real rulebook: the cards cover 26%-38% of their panel with text, one card to a page, on a
 * raster with a luminance spread of 22 (a picture with something in it has 40 and more, a cut-out figure is half
 * transparent). A limit of 30% alone took some cards for bare panels and not others.
 */
export const TEXT_PANEL_MIN_TEXT_COVERAGE = 0.15;
export const TEXT_PANEL_MAX_STDDEV = 30;
export const TEXT_PANEL_MIN_OPAQUE_FRACTION = 0.9;
/** A card is a part of a page; a smooth sheet that fills most of it is the page's own background, with the text of the page on it. */
export const TEXT_PANEL_MAX_AREA = 0.8;
/** Share of opaque pixels below which a picture that fills a third of the page or more and is cut out by a mask is a sparse decoration (measured: blood splatters 8%-30%; the illustrations of the same books are opaque all over). */
export const LARGE_CUTOUT_MIN_OPAQUE_FRACTION = 0.5;
/** Page-area share from which a picture that reaches the gutter may be one half of a picture across a spread. */
export const SPREAD_HALF_MIN_AREA = 0.08;
/** Share of each of two pictures' boxes that their overlap must cover for the two to lie in the same place. */
export const SAME_FOOTPRINT_MIN_SHARE = 0.9;
/** A small picture that is less than this share on the representative, next to a representative of at least `BESIDE_MIN_REPRESENTATIVE_AREA` of the page, is decoration beside it. */
export const BESIDE_MAX_SHARE_ON_REPRESENTATIVE = 0.5;
export const BESIDE_MIN_REPRESENTATIVE_AREA = 0.2;
/** A flush strip at least this long for its width, beside a representative of at least this share of the page, is the layout's margin. */
export const EDGE_STRIP_MIN_ASPECT = 3;
export const EDGE_STRIP_MIN_REPRESENTATIVE_AREA = 0.3;
/** Share of the box of a flush picture beside a big representative that page text must cover for the picture to be the backdrop of that text. */
export const TEXT_BACKDROP_MIN_COVERAGE = 0.08;

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
/** The page's words over a backdrop must lie in the boxes painted over it for this share of their characters at least, and those boxes must cover this share of it (see `isBackdropOfCardsAbove`). */
export const BACKDROP_OF_CARDS_MIN_WORDS_IN_CARDS = 0.9;
export const BACKDROP_OF_CARDS_MIN_COVER = 0.6;
/** Points along each side of a box that its cover by other boxes is sampled at. */
export const COVER_SAMPLES = 40;

/**
 * Whether the picture in `bbox` is a backdrop of the boxes painted over it (`above`): the page's words over it all lie
 * in those boxes (a card of text with its own picture), and they cover most of it (a picture with a box of text in its
 * corner is covered far less). Rendered, such a backdrop is the cards and the pictures over it again, which are offered
 * by themselves. Measured on one book: a page's texture under a sheet of text and a photograph, its words all on the
 * sheet, 0.7 of it covered.
 */
export function isBackdropOfCardsAbove(bbox: Rect, above: readonly Rect[], wordBoxes: readonly (Rect & { chars?: number })[] | undefined): boolean {
  if (above.length === 0 || !wordBoxes) return false;
  const inside = (box: Rect, x: number, y: number): boolean => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  let chars = 0;
  let inCards = 0;
  for (const w of wordBoxes) {
    const cx = (w.minX + w.maxX) / 2;
    const cy = (w.minY + w.maxY) / 2;
    if (!inside(bbox, cx, cy)) continue;
    const n = w.chars ?? 1;
    chars += n;
    if (above.some((a) => inside(a, cx, cy))) inCards += n;
  }
  if (chars === 0 || inCards < BACKDROP_OF_CARDS_MIN_WORDS_IN_CARDS * chars) return false;
  let covered = 0;
  for (let i = 0; i < COVER_SAMPLES; i++) {
    for (let j = 0; j < COVER_SAMPLES; j++) {
      const x = bbox.minX + ((i + 0.5) / COVER_SAMPLES) * (bbox.maxX - bbox.minX);
      const y = bbox.minY + ((j + 0.5) / COVER_SAMPLES) * (bbox.maxY - bbox.minY);
      if (above.some((a) => inside(a, x, y))) covered++;
    }
  }
  return covered >= BACKDROP_OF_CARDS_MIN_COVER * COVER_SAMPLES * COVER_SAMPLES;
}

/**
 * A cover: a picture that fills the page (this share of it at least) with display text over it, the text of the page
 * this many characters long, its letters this tall on average (points, weighed by characters). Measured on four books:
 * the covers of magazines handed out as props 291-299 characters at 19-32 pt, the covers of three books 367-379 at
 * 24-26 pt; the pages of a book with a picture under their text have thousands of characters, or letters of 6-10 pt,
 * and its chapter openers, credits, poems and comic pages of as few characters have letters of 14-17 pt.
 */
export const COVER_MIN_PAGE_SHARE = 0.95;
export const COVER_MIN_CHARS = 100;
export const COVER_MAX_CHARS = 800;
export const COVER_MIN_LETTER_PT = 18;

/** Whether the page's words are the display text of a cover (see `COVER_MIN_LETTER_PT`). */
export function isCoverText(words: readonly (Rect & { chars?: number })[] | undefined): boolean {
  if (!words || words.length === 0) return false;
  let chars = 0;
  let weighted = 0;
  for (const w of words) {
    const n = w.chars ?? 1;
    chars += n;
    weighted += n * Math.min(w.maxX - w.minX, w.maxY - w.minY);
  }
  return chars >= COVER_MIN_CHARS && chars <= COVER_MAX_CHARS && weighted / chars >= COVER_MIN_LETTER_PT;
}

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
export const TIGHTEN_MIN_OPAQUE_FRACTION = 0.4;
export const TIGHTEN_MIN_TEXT_COVERAGE = 0.5;
/**
 * ...and the cut has to take page text out of the region: the text beside the visible part must be at least this share
 * of the box. Measured: 8%-16% for the notes that sit beside a text column, 0%-0.3% for notes whose box only holds a
 * torn margin (cutting those only crops the edge of the paper).
 */
export const TIGHTEN_MIN_TEXT_BESIDE_SHARE = 0.03;

/**
 * Share of the unit's area that text blocks cut by its edge must cover before the raw image resource
 * is preferred over a render of the region. Measured on a real rulebook whose pictures sit under
 * text panels: the units with a visible slice of the page's text had 1.4%-19%; 1% catches a single cut
 * line across the width of a picture while ignoring a block that merely brushes the edge.
 */
export const TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION = 0.01;

/**
 * Share of a picture's box that text blocks cutting its edge cover, from which the text is the page's own text running past the picture and
 * not the writing on it (a note's text lies inside the note): the picture is taken from its own pixels.
 */
export const TEXT_RUNS_PAST_PICTURE_MIN_SHARE = 0.15;

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

export function textCrossesRegionEdge(bbox: Rect, textBoxes: readonly Rect[] | undefined): boolean {
  return textCrossingShare(bbox, textBoxes) >= TEXT_CROSSING_EDGE_PREFER_RAW_FRACTION;
}

/**
 * How far the long-to-short edge ratio of a raw resource may differ from the one of the place it is
 * painted in and still count as "the same picture". Measured on a real rulebook: a picture of 470x473 px
 * painted into a 239x240 pt box differs by 1%; a paper-texture strip of 1601x119 px painted under a
 * 243x417 pt picture differs by a factor of 23. Rotation by 90 degrees does not matter (the ratio is
 * taken long edge over short edge).
 */
export const RAW_RESOURCE_PLACEMENT_ASPECT_TOLERANCE = 0.25;

/**
 * The share of a masked picture that its mask must let through for the raw resource to stand in for the
 * rendered region. Measured on a real rulebook: the masks of photos pinned to the page as tilted prints
 * are white over 91%-95% of their raster (the rest is the black margin that tilts the edge); a mask that
 * deliberately hides half of a picture is far below. A mask that is a tilted rectangle may pass with less,
 * see `maskLetsMostThrough`.
 */
export const MASK_MOSTLY_VISIBLE_FRACTION = 0.8;

/**
 * A mask that is a rotated rectangle only tilts or trims the picture, however much of its raster that leaves
 * black: a print tilted by 10 degrees is white over about 0.75 of its mask, one tilted by 15 degrees over
 * 0.67. Measured on a second real rulebook with strongly tilted prints: the masks of 17 such photos are white
 * over 0.72-0.80 of the raster and fill 0.95-0.99 of their smallest enclosing rectangle, while every other
 * mask that lets less than 0.8 through (a silhouette, a torn edge, a small window) fills 0.04-0.47 of it
 * (an ellipse would give 0.785). The floor on the white share keeps out a rectangular window that hides most
 * of the picture.
 */
export const MASK_TILTED_RECTANGLE_MIN_FRACTION = 0.6;
export const MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY = 0.9;
/**
 * The tilted-rectangle allowance is for photos only: a paper note cut out by the same kind of mask carries
 * the page's own text, which the raw resource does not have. Page text covers up to 14% of the photos that
 * were measured (a caption touching a corner) and 25% of the one paper note, so the allowance stops at 20%
 * (the stricter 30% of `TEXT_OVER_PICTURE_FRACTION` still decides what is rendered as text over a picture).
 */
export const MASK_TILTED_RECTANGLE_MAX_TEXT_COVERAGE = 0.2;

/**
 * A figure cut out by a silhouette mask and stood against the edge of the page overhangs it by a point or two, which
 * the bleed rules take for a paper scrap, a stain or a shadow that runs off the page, or for a background with text on
 * it (those are hidden). Such a picture
 * is looked at once more: when its mask is a silhouette (it fills less than 0.9 of its smallest enclosing rectangle,
 * as a tilted print does; measured on a real rulebook: 0.23-0.72 for the figures cut out against the page edge) and the picture has more than one color it is a figure and
 * is offered; a rectangular mask (a print pinned at the edge) or a flat color (a splatter) keeps the old verdict. Real bleed overhangs the page mostly by 8-19 pt.
 */
export const EDGE_FIGURE_MAX_OVERHANG_PT = 3;
export const EDGE_FIGURE_REASON = 'Z21-masked-silhouette-at-page-edge';
/**
 * A sheet cut out by a mask that runs off the page by more than a figure stood against its edge (a printed poem lying
 * at the foot of the page, its mask a drop shadow) is hidden by the bleed rules with the paper scraps and stains. Such
 * a picture is looked at once more and kept, among the images with text, when its pixels are a document (lines of
 * letters on light paper, see `rasterText.ts`), or as a picture when it is a print at the edge (see
 * `EDGE_PRINT_MAX_OVERHANG_PT`); a scrap, a stain or a shadow is neither.
 */
export const EDGE_DOCUMENT_REASON = 'Z21-masked-document-at-page-edge';
/**
 * Such a sheet is kept as a print too (a photograph, a postcard: not plain paper) when it only touches the edge of the
 * page, overhanging it by this many points at most; the stains and burnt corners that bleed off the page overhang it
 * more. Measured on 26 books: a postcard laid at the head of a page 3.4 pt, the stains and scorched corners 7.7 pt and
 * more (one 3.1).
 */
export const EDGE_PRINT_MAX_OVERHANG_PT = 6;
export const SILHOUETTE_MAX_RECTANGULARITY = MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY;
/**
 * What stands against the page edge as a silhouette may also be a splatter, a smear of smoke or a patch of ink (one
 * color, only the alpha varies), or a faded paper vignette. Measured on three real rulebooks, the luminance spread of
 * the visible pixels is 0.4-3.3 for the former, 16-19 for the latter and 36-62 for figures and emblems. Page-sized
 * results (a backdrop) are rendered, not taken raw, and are not offered.
 */
export const EDGE_FIGURE_MIN_STDDEV = 25;

/** Whether a mask that is white over `whiteFraction` of its raster and has the given rectangularity lets most of the picture through. */
export function maskLetsMostThrough(whiteFraction: number, rectangularity: number | null): boolean {
  if (whiteFraction >= MASK_MOSTLY_VISIBLE_FRACTION) return true;
  return rectangularity !== null && whiteFraction >= MASK_TILTED_RECTANGLE_MIN_FRACTION && rectangularity >= MASK_TILTED_RECTANGLE_MIN_RECTANGULARITY;
}

/** The shape is only measured when it can change the verdict: a mask below the floor or already mostly white is decided by its white share. */
export async function maskResourceLetsMostThrough(page: PdfPageForExtract, maskObjId: string, tiltedRectangleAllowed: boolean): Promise<boolean> {
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
export function isBleedingUndecided(c: ClassifiedImage): boolean {
  // A big translucent panel that is only let through to be checked for a drawing stands alone too: joined to the pictures on top of it, it would take them with it when it is hidden.
  // A small picture offered only because text lies over its box (a card, or an object on a card) stands alone too: it is judged by its own pixels and does not take over the unit of the pictures beside it.
  // A page that is a document stands alone too: the pictures on it are offered by themselves.
  return c.reason === 'Z12-bleeding-no-center-text-evidence' || c.reason === LARGE_TRANSLUCENT_PANEL_REASON || c.reason === LARGE_MASKED_CUTOUT_REASON || c.reason === TEXT_OVER_SMALL_REASON || c.reason === FULL_PAGE_DOCUMENT_REASON;
}
