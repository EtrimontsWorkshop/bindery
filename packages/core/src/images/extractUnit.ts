import { clipPathBBox, isQuadrilateralClip, type ClipInfo } from '../inventory/clipPaths.js';
import { rectArea, rectIntersection, unionRect, type Matrix, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { confidenceForReason, FASTENER_REASON, EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, FLUSH_UNDECIDED_REASON, FULL_PAGE_DOCUMENT_REASON, LARGE_MASKED_CUTOUT_REASON, TEXT_OVER_SMALL_REASON, LARGE_TRANSLUCENT_PANEL_REASON, isBackdropShape, isTranslucentEverywhere } from './classify.js';
import { AUTOCROP_BRIGHTEN, brightenCroppedImage } from './brightenImage.js';
import { cardOfPiece, cardWithoutPictures } from './cardBesidePictures.js';
import { looksLikeTrackOfBoxes } from './boxGrid.js';
import { looksLikeInkSplatter } from './inkSplatter.js';
import { isPartOfSheet, looksLikeCoveredDocument, measureRasterText } from './rasterText.js';
import { shrinkToCenter, type ClassifiedImage } from './classify.js';
import { applyClipToImage, clipShowsWholePicture, renderThroughRectangularClip } from './clipMask.js';
import { cropDecodedImage, detectContentBounds, trimDarkSurround, trimTransparentMargins } from './cropUniformMargins.js';
import { coverWithRaster } from './coverWithRaster.js';
import { straightenTiltedPicture } from './tiltedRectangle.js';
import { askewRectangleOfPainting, envelopeOf, nearlyRectangleOf } from './askewCard.js';
import { renderRotatedRegion, type RotatedPdfRegion } from './renderRotatedRegion.js';
import { findPhotoInDocument } from './photoInDocument.js';
import { areNamedItems, findItemsOnBlank, withoutBoxes } from './itemsOnBlank.js';
import { ruleTrace } from './ruleTrace.js';
import { isSolidCutOut } from './solidCutOut.js';
import { findDrawingsOnGround, findPicturesOnGround, PAGE_RASTER_MIN_PAGE_SHARE, type PixelRect } from './picturesOnGround.js';
import { findSingleCardOnGround } from './singleCardOnGround.js';
import { envelopeOfCard, findCardsOnGround, takeCard, type CardQuad } from './cardsOnGround.js';
import { dominantTextAngle, standUpSidewaysDocument, turnUpright } from './readingTurn.js';
import { sidewaysLettering, standUpLettering } from './sidewaysText.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder } from './encodeImage.js';
import { isBlankSheet } from './blankSheet.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { mirrorImage, rotateQuarterTurns } from './rotateQuarterTurns.js';
import { eraseNumberMarkers } from './numberMarkers.js';
import { eraseTextAroundFigure } from './eraseFigureText.js';
import { drawnShare, isBareDarkTexture, isColorfulPicture, isDrawingOnPanel, isPanelBackdrop, PANEL_MIN_TEXT_COVERAGE, PANEL_PREVIEW_LONG_EDGE_PX, PANEL_FRAMES_PICTURE_MIN_SHARE, PANEL_OVERLAY_MIN_OPAQUE_FRACTION } from './panelBackdrop.js';
import { FULL_EXTENT_BOUNDS, innerVisibleBounds, tightenToVisible } from './opaqueBounds.js';
import { measureInkStyle, type InkStyle } from './bookOrnaments.js';
import { extractDirect, probeIntrinsicLongEdgePx, probeIntrinsicSizePx, probeOpaqueBounds, probeOpaquePixelStats, probeRawLook, probeOpaqueFraction, probeRawImage, waitForObjects, type PdfPageForExtract } from './extract.js';
import { computeContentHash, computeDarkOpaqueShare, computeCentreDetail, NIGHT_SCENE_MIN_AREA, computeWhiteOpaqueShare, computeLuminanceStdDev, computeVisibleLuminanceStdDev, computeVisibleMeanLuminance, computeOpaqueFraction, computeUniformColorFraction, computeSmoothnessMetrics, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import { computeTargetLongEdgePx } from './renderResolution.js';
import { CO_MEMBER_SIGNIFICANT_AREA, decideExtractionStrategy } from './strategy.js';
import type { BuildImageExtractionOptions, ExtractionUnit, InventoryForImages } from './extractionTypes.js';
import { CARD_REASON, COVERED_MEMBER_MIN_COVER, COVER_MIN_OPAQUE_FRACTION, CUTOUT_TEXT_MIN_COVERAGE, FIGURE_MAX_WHITE_SHARE, PANEL_BEHIND_PICTURE_MIN_AREA_SHARE, PAPER_OVERLAY_MIN_COVER_OF_PICTURE, TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION, VECTOR_FIGURE_REASON, alternativeRepresentatives, compositionMembers, isPaperOverlay, syntheticVectorOnlyEntry, topOccurrenceOnPage, withSolidRepresentativeOfBackdrop } from './extractionUnits.js';
import { BANNER_MAX_RAW_STDDEV, CLIP_CUT_MIN_REMAINING_SHARE, COVER_MIN_PAGE_SHARE, CUT_OUT_MAX_OPAQUE_FRACTION, CUT_OUT_OUTLINE_MIN_POINTS, DARK_CUTOUT_MAX_MEAN_LUMINANCE, DARK_CUTOUT_MAX_STDDEV, DOCUMENT_UNDER_PICTURE_MIN_COVER, EDGE_DOCUMENT_REASON, EDGE_FIGURE_MIN_PIXELS, EDGE_FIGURE_REASON, EDGE_STRIP_MIN_REPRESENTATIVE_AREA, FLUSH_CARD_MIN_TEXT_COVERAGE, HIGH_TEXT_COVERAGE_REASON, LARGE_CUTOUT_MIN_OPAQUE_FRACTION, MAP_UNDER_LABELS_MIN_MEAN_LUMINANCE, MASK_TILTED_RECTANGLE_MAX_TEXT_COVERAGE, NEIGHBOUR_CARD_MAX_AREA, NEIGHBOUR_CARD_MIN_OVERLAP, NOTE_MAX_AREA, NOTE_PIECE_MIN_TEXT_CROSSING, PAPER_CARD_MIN_MEAN_LUMINANCE, PAPER_NOTE_MIN_CENTER_COVERAGE, PAPER_UNDER_PICTURE_EDGE_INSET, PAPER_UNDER_PICTURE_MAX_STDDEV, PAPER_UNDER_PICTURE_MIN_COVER, PICTURE_OVER_CARD_MAX_WORD_COVERAGE, PICTURE_OVER_CARD_MIN_AREA, SAME_FOOTPRINT_MIN_SHARE, TEXT_COVERED_BACKDROP_REASON, TEXT_FILLS_BOX_MIN_COVERAGE, TEXT_PANEL_CENTER_MIN_COVERAGE, TEXT_PANEL_MAX_AREA, TEXT_PANEL_MAX_RAW_SATURATION, TEXT_PANEL_MAX_RAW_STDDEV, TEXT_PANEL_MIN_TEXT_COVERAGE, TEXT_PANEL_STYLE_MIN_COVERAGE, TEXT_PANEL_TINTED_MAX_RAW_SATURATION, TEXT_PANEL_TINTED_MAX_RAW_STDDEV, TEXT_RUNS_PAST_PICTURE_MIN_SHARE, TIGHTEN_MIN_OPAQUE_FRACTION, TIGHTEN_MIN_TEXT_BESIDE_SHARE, TIGHTEN_MIN_TEXT_COVERAGE, TURN_MIN_WORD_COVERAGE, WRITTEN_PAPER_MAX_CROSSING_SHARE, WRITTEN_PAPER_MAX_RASTER_LINES, WRITTEN_PAPER_MAX_VECTOR_COVER, WRITTEN_PAPER_MIN_OPAQUE_FRACTION, WRITTEN_PAPER_MIN_PAGE_SHARE, WRITTEN_PAPER_MIN_SIDE_PT, WRITTEN_PAPER_MIN_WORD_COVERAGE, WRITTEN_PAPER_VECTOR_MAX_PAGE_SHARE, isBackdropOfCardsAbove, isBackdropOfTextBesideRepresentative, isCoverText, isDocumentPaper, isFadedPaperOverlay, isFadedPaperVignette, isFlushCardOfText, isHeadingBannerText, isLabelledPicture, isLongStrip, labelsOfPicture, labelsOnBlankCount, LABELLED_PICTURE_MIN_LABELS_ON_PICTURE, LABELS_ON_PICTURE_MIN_SHARE, isPhotoUnderNotes, isSmallPieceBesideRepresentative, isTextOverPicture, isTextPanel, isWrittenPaper, looksLikePlainTextCard, maskResourceLetsMostThrough, rawResourceFitsPlacement, textCoverage, textCrossesRegionEdge, textCrossingShare } from './extractionLooks.js';
import { ASLANT_HALF_REASON, BOOK_PROP_MAX_DRAWN_SHARE, BOOK_PROP_MAX_TEXT_COVERAGE, BOOK_PROP_MIN_BLANK_GROUND_SHARE, BOOK_PROP_MIN_PAPER_STAIN_SHARE, DRAWING_UNDER_PAGE_TEXT_MAX_CHROMA, DRAWING_UNDER_PAGE_TEXT_MIN_STDDEV, DRAWING_UNDER_PAGE_TEXT_MIN_WHITE, FRAME_MIN_TEXT_COVERAGE, GRID_PICTURE_REASON, LINE_DRAWING_REASON, PROP_MAX_ASPECT, PROP_MAX_PAGE_SHARE, PROP_MIN_BLANK_GROUND_SHARE, PROP_MIN_OFF_PAGE_SHARE, blankGroundShare, isFlatFill, isFrameOfTextBox, looksLikeDocumentImage, looksLikeWrittenImage, meanUnderBoxes, offPageShare, paperGroundShare, readsAsDocument } from './extractionJoins.js';


/** A sheet of items rendered from the page carries the page's words over this share of it at most (measured: 0.02 and 0.03 on two sheets; pages of text with a picture 0.07 and more). */
/** A page-sized raster whose opaque part takes less than this share of it is a picture on a canvas, not the page's background (measured: three illustrations on the upper half of their page, 0.5). */
const PICTURE_ON_CANVAS_MAX_VISIBLE_SHARE = 0.7;
const ITEM_SHEET_MAX_WORD_COVERAGE = 0.05;
/**
 * Whether the page shows a picture through a window of its design that is no quadrilateral (a slanted side and a rounded top around a
 * figure): its outline is the window's, not a print lying askew, and the picture stays upright as the window cuts it.
 */
function inShapedWindow(clip: ClipInfo | undefined): boolean {
  return clip !== undefined && !clipShowsWholePicture(clip) && !isQuadrilateralClip(clip.paths);
}

/** A note's region cut to the box within its tilted sides keeps at least this share of its upright box (a sheet slightly askew, not a cut-out shape). */
const ASKEW_NOTE_MIN_KEPT_SHARE = 0.85;
/** A unit is the card laid askew when the box around the card's turned rectangle covers this share of the unit's region at least. */
const ASKEW_CARD_MIN_REGION_SHARE = 0.75;
/** ...and the card lies on the page, within this margin (a layer of the page's design runs off it, a card is laid on it). */
const ASKEW_CARD_PAGE_MARGIN_PT = 2;
/**
 * ...and each opaque raster of the unit painted under the card lies on it, this share of it at least (not a stack of cards, the top one
 * askew, cut to it). Masks and translucent layers (a shadow) are not looked at.
 */
const ASKEW_CARD_MIN_MEMBER_ON = 0.85;
/** Only rasters of this share of the unit's region at least are looked at (a label laid on a map, a sliver at the page's edge are not cards). */
const ASKEW_CARD_MEMBER_MIN_AREA_SHARE = 0.1;
/** A raster laid over the card with less than this share of it on the card is another card beside it. */
const ASKEW_CARD_MAX_OTHER_CARD_ON = 0.5;
/** Rasters laid over the card from this share of the card's box are looked at, wherever they belong (a strip of tape with a caption is a picture of its own). */
const ASKEW_CARD_OVERLAY_MIN_AREA_SHARE = 0.03;
function isCardOfRegion(rect: RotatedPdfRegion, cardIndex: number, unit: ExtractionUnit, pageNumber: number, pageBox: Rect | undefined, pageImages: readonly ImageEntry[] = []): boolean {
  const envelope = envelopeOf(rect);
  if (pageBox !== undefined && (envelope.minX < pageBox.minX - ASKEW_CARD_PAGE_MARGIN_PT || envelope.minY < pageBox.minY - ASKEW_CARD_PAGE_MARGIN_PT || envelope.maxX > pageBox.maxX + ASKEW_CARD_PAGE_MARGIN_PT || envelope.maxY > pageBox.maxY + ASKEW_CARD_PAGE_MARGIN_PT)) return false;
  // The unit's region as the page shows it: a unit that is the card alone (one raster painted once), shown through a clip that is all but a
  // rectangle (a print with a corner cut off, see `nearlyRectangleOf`), shows only what lies within the clip (its raster runs past it).
  let region: Rect = unit.bbox;
  const paintings = unit.memberEntries.flatMap((m) => m.occurrences.filter((o) => o.page === pageNumber));
  const only = paintings.length === 1 && paintings[0]!.index === cardIndex ? paintings[0] : undefined;
  const cutCorner = only?.clip?.paths.length === 1 && only.clip.paths[0]!.length === 1 && nearlyRectangleOf(only.clip.paths[0]![0]!) !== null;
  for (const path of cutCorner ? only!.clip!.paths : []) {
    const bounds = clipPathBBox(path);
    const within = bounds === null ? null : rectIntersection(region, bounds);
    if (within !== null) region = within;
  }
  const shared = rectIntersection(envelope, region);
  if (shared === null || rectArea(shared) < ASKEW_CARD_MIN_REGION_SHARE * rectArea(region)) return false;
  const envelopeArea = rectArea(envelope);
  const overlaysFit = pageImages.every((m) =>
    m.occurrences.every((o) => {
      if (o.page !== pageNumber || o.index <= cardIndex || m.isMaskLayer || m.masksImageObjId !== undefined || o.opacity !== undefined) return true;
      const box = pageBox === undefined ? o.bbox : rectIntersection(o.bbox, pageBox);
      if (box === null || rectArea(box) < ASKEW_CARD_OVERLAY_MIN_AREA_SHARE * envelopeArea) return true;
      const on = rectIntersection(box, envelope);
      const onShare = on === null ? 0 : rectArea(on) / rectArea(box);
      if (onShare < ASKEW_CARD_MAX_OTHER_CARD_ON) return true;
      // A layer blended into the card over its edge (a strip of tape across its corner) is no other card: what of it lies off the card is cut.
      if (o.blended === true && onShare < ASKEW_CARD_MIN_MEMBER_ON) return true;
      // One laid upright on the askew card (a strip of tape with the photo's caption) would be turned askew by straightening the card.
      return onShare >= ASKEW_CARD_MIN_MEMBER_ON && o.placement?.rotated === true;
    }),
  );
  if (!overlaysFit) return false;
  return unit.memberEntries.every((m) => {
    const o = m.occurrences.find((occ) => occ.page === pageNumber);
    // The card's own raster is what the card shows.
    if (o === undefined || o.index === cardIndex || m.isMaskLayer || m.masksImageObjId !== undefined || o.opacity !== undefined) return true;
    const box = pageBox === undefined ? o.bbox : rectIntersection(o.bbox, pageBox);
    if (box === null || rectArea(box) < ASKEW_CARD_MEMBER_MIN_AREA_SHARE * rectArea(unit.bbox)) return true;
    const on = rectIntersection(box, envelope);
    const onShare = on === null ? 0 : rectArea(on) / rectArea(box);
    // A raster laid over the card mostly off it is another card touching its corner (a note beside a plan); one partly on it and sticking out
    // past its edge (a strip of tape with the photo's caption) is part of what the card shows, and would be cut.
    if (o.index > cardIndex) return onShare < ASKEW_CARD_MAX_OTHER_CARD_ON || onShare >= ASKEW_CARD_MIN_MEMBER_ON;
    return onShare >= ASKEW_CARD_MIN_MEMBER_ON;
  });
}
/** Words of the page that run past the card's edge (a column the picture lies beside) for this share of those on it at most: the text on the card is the card's. */
const ASKEW_CARD_MAX_WORDS_ACROSS = 0.1;
/**
 * A card laid askew that the page writes or draws on (the names of a map's places, the plan of a scrapyard drawn on squared paper, the text of a
 * note) shows what the page sets on it only in a render: it is rendered (straightened, see `askewCard.ts`), not taken from its raster. So it is
 * when this many of the page's words, or of its paths, or of its pictures painted after it lie on it.
 */
/** A raster laid over a picture after it, of this share of the page at least, is a card of its own (a note pinned over a photo's corner)... */
const CARD_OVER_PICTURE_MIN_AREA = 0.02;
/** ...and a block of the page's text with this share of it on such a card is the card's writing. */
const TEXT_ON_CARD_MIN_SHARE = 0.9;
/** A layer this many times as long as it is wide at least is a strip (a caption on a strip of paper). */
const CAPTION_STRIP_MIN_ASPECT = 4;
/** A picture found upright on the page's ground lies within a card found askew for this share of its box at least: it is that card. */
const SOLID_WITHIN_CARD_MIN_SHARE = 0.9;
/**
 * The page's words on a picture are numbered markers when this many at least are this many characters at most (the numbers of a map's places; a map whose places are named carries its names, and is rendered with them).
 */
const MARKERS_MIN_COUNT = 4;
const MARKER_MAX_CHARS = 2;
/** ...with this many other words on it at most (the map's title); a map with the names of its places has more. */
const MARKERS_MAX_OTHER_WORDS = 2;
const ASKEW_CARD_MIN_WORDS_ON = 3;
/** A word of the page on the card turned by more than this many degrees from upright, upside down or on its side is written aslant on it. */
const ASKEW_CARD_ASLANT_WORD_MIN_DEG = 5;
/** ...of this many characters at least (not a stray mark), on a card of this share of the page at most (not a page painted askew whole). */
const ASKEW_CARD_ASLANT_WORD_MIN_CHARS = 4;
const ASKEW_CARD_ASLANT_MAX_PAGE_SHARE = 0.5;
const ASKEW_CARD_MIN_PATHS_ON = 20;
/**
 * A raster over the whole page that the page draws on in this many paths at least (a blueprint of a tower with the maps pinned to it,
 * drawn in vectors over a sheet of paper painted in the raster: 4,300 paths), with this much text on the page at most (its labels; a page
 * of text with its tables and rules over its paper has thousands of characters), is rendered as the page shows it: the raster alone is
 * the blank sheet.
 */
const PAGE_DRAWING_MIN_PATHS = 1000;

/** A point of the raster where it falls in a render of the box `picture` (the raster's pixels) at the render's size. */
function intoRender(picture: PixelRect, rendered: DecodedImage): (p: { x: number; y: number }) => { x: number; y: number } {
  return (p) => ({ x: ((p.x - picture.x) / Math.max(1, picture.width)) * rendered.width, y: ((p.y - picture.y) / Math.max(1, picture.height)) * rendered.height });
}

/** What the page's own raster holds on its ground (see `picturesOnGround.ts`, `cardsOnGround.ts`): their boxes, and the cards' corners. */
interface GroundPictures {
  rects: PixelRect[];
  drawings: boolean;
  cards?: CardQuad[];
}
const PAGE_DRAWING_MAX_CHARS = 700;
const ASKEW_CARD_MIN_PICTURES_ON = 1;
/** A raster laid on the card smaller than this share of it is a pin or a tack holding it to the page, not a picture on it. */
const ASKEW_CARD_PIN_MAX_SHARE = 0.02;
/** ...when there are this many such rasters on it at most (more are markers set on it, the places of a map). */
const ASKEW_CARD_MAX_PINS = 2;
/** A raster laid over the card's edge, partly off it, of this share of the card at most is a fastener (a paper clip, a strip of tape), not a picture on it. */
const ASKEW_CARD_FASTENER_MAX_SHARE = 0.05;
/**
 * A light sheet the page draws a picture on in paths (a map of a school's grounds over squared paper, its buildings filled shapes and its
 * labels the page's text) carries at least this many of the page's shapes and lines, their boxes adding up to this share of the sheet at
 * least (its buildings, the patches of its grounds and their outlines overlap): it is a picture, not a card of text. Measured on three books:
 * such maps 56 paths and more, covering 1.46 and 4.17 of the sheet; a panel of text with a code printed in squares, a note with a bar code,
 * a character sheet 41 to 126, covering 0.06 to 0.51.
 */
const DRAWING_ON_SHEET_MIN_PATHS = 40;
const DRAWING_ON_SHEET_MIN_PATH_COVER = 1;
/** The rasters of a picture looked at for its labels lying on what it draws, at most (see `LABELLED_PICTURE_MIN_LABELS_ON_PICTURE`). */
const LABELLED_PICTURE_MAX_LAYERS_LOOKED_AT = 6;
/** Page share from which a picture is the page's own (a cover with its blurb), not one the page labels (see `isLabelledPicture`). */
const LABELLED_PICTURE_MAX_PAGE_SHARE = 0.9;
/**
 * A labelled picture whose raster is plain paper (this luminance spread at most) that the page's text covers this much of is a filled form, not a
 * map: measured on one book, a filled journey sheet 12 and 0.23, the plans on squared paper 12-14 and 0.05-0.07, the maps 20-65.
 */
const LABELLED_SHEET_MAX_RAW_STDDEV = 16;
const LABELLED_SHEET_MIN_TEXT_COVERAGE = 0.15;
import { CLIPPED_PIECES_REASON, ORNAMENT_MAX_AREA, PAPER_PIECES_MIN_PAGE_SHARE, PAPER_PIECE_EDGE_PT, PAPER_PIECE_MAX_PAGE_SHARE, PAPER_PIECE_MAX_WORD_COVERAGE, PAPER_PIECE_MIN_MEAN_LUMINANCE, SLICED_PICTURE_REASON, extendToEdgeOrnaments, unitPageShareOf } from './extractionPieces.js';

/**
 * What extracting a unit reads of the run and of the page it is on. `buildImageExtraction.ts` builds one per page.
 * The four fields that are not `readonly` are live: they read and write the orchestration's own variables (a budget
 * of waiting time, the last panel taken, a running count), which the units of a page share.
 */
export interface UnitScope {
  readonly textBlockBoxesByPage: ReadonlyMap<number, readonly Rect[]>;
  readonly pageNumber: number;
  readonly hideBackgroundImages: boolean;
  readonly maskedObjIds: ReadonlySet<string>;
  readonly idOnThisPage: (entry: ImageEntry) => string | null;
  settleBudgetMs: number;
  readonly page: PdfPageForExtract & {    cleanup(): void;};
  readonly classifiedByEntry: Map<ImageEntry, ClassifiedImage>;
  readonly maskHoldersByTarget: Map<string, ImageEntry[]>;
  readonly targetLongEdgePx: number;
  readonly maxLongEdgePx: number;
  readonly classified: ClassifiedImage[];
  readonly pageBoxByPage: Map<number, Rect>;
  readonly pageUnits: ExtractionUnit[];
  readonly neighbourUnits: ExtractionUnit[];
  readonly renderer: RegionRenderer;
  readonly signal: AbortSignal | undefined;
  readonly diagnostics: Diagnostic[];
  readonly opts: BuildImageExtractionOptions;
  readonly pageRotationByPage: Map<number, number>;
  readonly autoCropUniformMargins: boolean;
  readonly brightenAutoCroppedImages: boolean;
  edgeFigureStdDev: number | undefined;
  readonly encoder: ImageEncoder;
  lastPanelImage: DecodedImage | null;
  readonly figureEntries: Set<ImageEntry>;
  readonly isLeftHalf: (u: ExtractionUnit) => boolean;
  readonly isRightHalf: (u: ExtractionUnit) => boolean;
  readonly headingBlockBoxesByPage: ReadonlyMap<number, readonly Rect[]>;
  readonly inventory: InventoryForImages;
  readonly imageByItem: WeakMap<object, DecodedImage>;
  readonly ownImageByItem: WeakMap<object, DecodedImage>;
  readonly tossedPropItems: WeakSet<object>;
  tossedPropCount: number;
  readonly smallCutOutItems: object[];
  readonly inkStyleByItem: WeakMap<object, {    style: InkStyle | null;    width: number;    height: number;}>;
  readonly formPages: Set<number>;
  readonly possibleSheetParts: {    item: PreparedEntryForFinalize<EncodedImage>;    page: number;}[];
  readonly photoCuts: PreparedEntryForFinalize<EncodedImage>[];
}

/**
 * Phase 1 — what the unit is made of on this page: its representative, the members that are only a backdrop, a copy
 * or a strip beside it, and whether a mask or several pictures take part.
 */
async function composeUnit(scope: UnitScope, plannedUnit: ExtractionUnit) {
  const { textBlockBoxesByPage, pageNumber, hideBackgroundImages, maskedObjIds, idOnThisPage, page, classifiedByEntry, maskHoldersByTarget } = scope;
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
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [memberId], scope.settleBudgetMs);
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
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [overlayId], scope.settleBudgetMs);
        const stats = await probeOpaquePixelStats(page, overlayId);
        // A translucent dark texture laid behind a picture (a panel of the page's design) is no more its picture than a paper vignette is.
        // A panel that frames the picture (a card with a portrait on it) is a unit of its own and stays one.
        const panelBox = unit.representativeEntry.occurrences.find((o) => o.page === pageNumber)?.bbox;
        const altBox = alternative.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.bbox;
        const sharedWithAlt = panelBox !== undefined && altBox !== undefined ? rectIntersection(panelBox, altBox) : null;
        const framesAlt = sharedWithAlt !== null && altBox !== undefined && rectArea(sharedWithAlt) >= PANEL_FRAMES_PICTURE_MIN_SHARE * rectArea(altBox);
        // A panel many times the picture's size (a dark map with a small sign on it) is the picture itself, not a panel behind it.
        const altIsOfConsequence = (alternative.representativeEntry?.maxRelativeArea ?? 0) >= PANEL_BEHIND_PICTURE_MIN_AREA_SHARE * unit.representativeEntry.maxRelativeArea;
        const panelLook = stats !== null && !framesAlt && altIsOfConsequence && isTranslucentEverywhere(unit.representativeEntry) ? await probeRawLook(page, overlayId) : null;
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
          if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [memberId], scope.settleBudgetMs);
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

  return { unit, crossesText, overlayMember, isMasked, compositionCount, rep, repId, holderIds };
}

/**
 * Phase 2 — how to take it: probes of the stored picture (does it fit its place, is it covered, is text written
 * over it), the strategy that follows (the picture's own pixels or a render of the page), the resolution, and the
 * box to take.
 */
async function judgeUnit(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof composeUnit>>, labelledAsShown = true) {
  const { textBlockBoxesByPage, pageNumber, page, idOnThisPage, targetLongEdgePx, maxLongEdgePx, classified, pageBoxByPage, pageUnits, neighbourUnits } = scope;
  const { rep, repId, isMasked, compositionCount, holderIds, overlayMember } = state;
  let { crossesText, unit } = state;
    // Text inside the bbox of a cut-out figure lies on the transparent part around it. A block that lies
    // wholly inside the region does not count as "cut" above, but a render of the region copies it just the
    // same, so for such a picture it counts as text cutting the region.
    if (!crossesText && rep && repId && (isMasked || compositionCount > 1)) {
      const textTextBoxes = textBlockBoxesByPage.get(pageNumber);
      if (textCoverage(unit.bbox, textTextBoxes) >= CUTOUT_TEXT_MIN_COVERAGE) {
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [repId], scope.settleBudgetMs);
        const opaque = await probeOpaqueFraction(page, repId);
        if (opaque !== null && opaque < TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION) crossesText = true;
      }
    }
    const considersRaw = rep?.objId !== undefined && rep?.objId !== null && (isMasked || (crossesText && compositionCount > 1));
    let fitsPlacement = false;
    let maskMostlyVisible = false;
    if (rep && repId && considersRaw) {
      const needed = [repId, ...(isMasked ? holderIds : [])].filter((id): id is string => id !== null);
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, needed, scope.settleBudgetMs);
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
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [coverId], scope.settleBudgetMs);
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
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [memberId], scope.settleBudgetMs);
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
    // A mask laid over the picture (its shadow) hides more of it, never less: the picture's own transparent margin is still no part of it.
    // Not a picture the page labels (a map under the page's paper): it is rendered with all the page lays over it (see `isLabelledPicture`).
    if (textOverPicture && rep?.objId && repId && placedRep && coMemberAreaShare < CO_MEMBER_SIGNIFICANT_AREA && !isLabelledPicture(placedRep, textBlockBoxesByPage.get(pageNumber))) {
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [repId], scope.settleBudgetMs);
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
        // ...or a block of it whole (a heading over the picture, in its transparent margin).
        const t = tight;
        const blockBeside = (pageText ?? []).some((b) => {
          const cx = (b.minX + b.maxX) / 2;
          const cy = (b.minY + b.maxY) / 2;
          const inBox = (r: Rect): boolean => cx >= r.minX && cx <= r.maxX && cy >= r.minY && cy <= r.maxY;
          return inBox(placedRep) && !inBox(t) && rectIntersection(b, t) === null;
        });
        if (opaque === null || opaque < TIGHTEN_MIN_OPAQUE_FRACTION || textCoverage(tight, pageText) < TIGHTEN_MIN_TEXT_COVERAGE || (textBesideShare < TIGHTEN_MIN_TEXT_BESIDE_SHARE && !blockBeside)) tight = null;
      }
      // A note laid slightly askew, shown through a mask in its shape (its shadow around it): its upright box takes in wedges of the page
      // between its tilted sides and the box (the edge of the chapter's tab). The region is the box within its sides, when that keeps nearly all of it.
      const maskEntry = scope.maskHoldersByTarget.get(rep.objId)?.[0];
      const maskBox = maskEntry?.occurrences.find((o) => o.page === pageNumber);
      const maskId = maskEntry !== undefined ? idOnThisPage(maskEntry) : null;
      if (maskBox !== undefined && maskId !== null && opaque !== null && opaque >= TIGHTEN_MIN_OPAQUE_FRACTION && textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)) >= TIGHTEN_MIN_TEXT_COVERAGE) {
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [maskId], scope.settleBudgetMs);
        const maskImage = await probeRawImage(page, maskId);
        const inner = maskImage !== null ? innerVisibleBounds(maskImage) : null;
        const within = inner !== null ? tightenToVisible(maskBox.bbox, inner, maskBox.placement) : null;
        const cut = within !== null ? rectIntersection(tight ?? placedRep, within) : null;
        // ...of its upright box, and of the whole region of its unit (two cards side by side, one of them the representative, are not cut to one).
        if (cut !== null && rectArea(cut) < rectArea(tight ?? placedRep) && rectArea(cut) >= ASKEW_NOTE_MIN_KEPT_SHARE * Math.max(rectArea(placedRep), rectArea(unit.bbox))) tight = cut;
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
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [repId], scope.settleBudgetMs);
      const opaque = await probeOpaqueFraction(page, repId);
      if (opaque !== null && opaque < TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION) textOverPicture = false;
    }
    let textIsOnPlainCard = false;
    // A plain opaque panel with a lot of the page's text on it is the text's card: what the page shows, not the bare raster.
    if (!textOverPicture && rep?.objId && repId && placedRep && !isTranslucentEverywhere(rep) && rep.maxRelativeArea <= TEXT_PANEL_MAX_AREA && textCoverage(placedRep, textBlockBoxesByPage.get(pageNumber)) >= TEXT_PANEL_MIN_TEXT_COVERAGE) {
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [repId], scope.settleBudgetMs);
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
    // Not a half of a picture across a spread that the page labels (a map in muted colours with the names of its places on it): a card does not go on onto the facing page.
    const spreadHalf = (scope.isLeftHalf(plannedUnit) || scope.isRightHalf(plannedUnit)) && isLabelledPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber));
    // Nor a sheet that the page draws a picture on in paths (see `DRAWING_ON_SHEET_MIN_PATHS`).
    const pathsOver = [...(scope.inventory.shapes ?? []), ...(scope.inventory.lines ?? [])].filter((v) => v.page === pageNumber && (v.bbox.minX + v.bbox.maxX) / 2 >= unit.bbox.minX && (v.bbox.minX + v.bbox.maxX) / 2 <= unit.bbox.maxX && (v.bbox.minY + v.bbox.maxY) / 2 >= unit.bbox.minY && (v.bbox.minY + v.bbox.maxY) / 2 <= unit.bbox.maxY);
    const pathsArea = pathsOver.reduce((sum, v) => sum + rectArea(rectIntersection(v.bbox, unit.bbox) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0);
    const drawingOnSheet = pathsOver.length >= DRAWING_ON_SHEET_MIN_PATHS && rectArea(unit.bbox) > 0 && pathsArea >= DRAWING_ON_SHEET_MIN_PATH_COVER * rectArea(unit.bbox);
    const textOnPaperCard = textIsOnPlainCard && !spreadHalf && !drawingOnSheet && photoLook !== null && photoLook.meanLuminance >= PAPER_CARD_MIN_MEAN_LUMINANCE;
    // A line drawing's region is the drawing's, whatever is left of the rasters it lies on (see `withLineDrawings`).
    if (plannedUnit.reason === LINE_DRAWING_REASON || plannedUnit.reason === SLICED_PICTURE_REASON || plannedUnit.reason === CLIPPED_PIECES_REASON || plannedUnit.reason === GRID_PICTURE_REASON || plannedUnit.reason === ASLANT_HALF_REASON) unit = { ...unit, bbox: plannedUnit.bbox };
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
      if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [repId], scope.settleBudgetMs);
      const look = await probeRawLook(page, repId);
      blankSheet = look !== null && isBlankSheet(look, { textOverPicture: decision.reason === 'Z2-text-over-picture-is-content', pageShare: rep?.maxRelativeArea ?? 0 });
    }
    // A line drawing on the pictures is what the page draws over their rasters: only a render shows it (see `withLineDrawings`). So is a picture
    // the page labels (a map with the names of its places and the markers set on it, see `isLabelledPicture`), not a picture of the whole page
    // (a cover, its blurb set over it).
    // Nor a sheet of plain paper the page writes on for a good part of it (a filled form): a document, not a picture with labels.
    let labelledRender = false;
    // Fewer labels (an island with its farms named) make a labelled picture when they lie on what it draws, not on its blank ground beside the
    // page's text: on one of the rasters of the picture at least (the map under the page's paper laid over it).
    // Not a half of a picture across a spread: its halves are joined as the page labels them only by the full rule (see `isLabelledPicture`).
    const fewLabels = labelledAsShown && (decision.strategy === 'direct' || decision.strategy === 'region-render') && repId && !scope.isLeftHalf(plannedUnit) && !scope.isRightHalf(plannedUnit) && !isLabelledPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber)) ? labelsOfPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber), LABELLED_PICTURE_MIN_LABELS_ON_PICTURE) : null;
    let fewLabelsOnPicture = false;
    if (fewLabels !== null) {
      const layers = [...new Set([rep, ...unit.memberEntries].filter((m): m is ImageEntry => m !== null && m !== undefined && m.objId !== null))].slice(0, LABELLED_PICTURE_MAX_LAYERS_LOOKED_AT);
      for (const layer of layers) {
        const occurrence = layer.occurrences.find((o) => o.page === pageNumber);
        const layerId = idOnThisPage(layer);
        if (occurrence === undefined || occurrence.placement !== undefined || layerId === null) continue;
        if (scope.settleBudgetMs > 0) scope.settleBudgetMs -= await waitForObjects(page, [layerId], scope.settleBudgetMs);
        const raw = await probeRawImage(page, layerId);
        if (raw !== null && fewLabels.length - labelsOnBlankCount(raw, occurrence.bbox, fewLabels) >= LABELS_ON_PICTURE_MIN_SHARE * fewLabels.length) {
          fewLabelsOnPicture = true;
          break;
        }
      }
    }
    // The page's words on the picture are numbered markers, not names (the keys of a map's places, 1 to 11): the picture is taken without them.
    const wordsOnPicture = (scope.opts.wordBoxesByPage?.get(pageNumber) ?? []).filter((w) => w.minX >= unit.bbox.minX && w.maxX <= unit.bbox.maxX && w.minY >= unit.bbox.minY && w.maxY <= unit.bbox.maxY);
    const markerCount = wordsOnPicture.filter((w) => ((w as { chars?: number }).chars ?? Infinity) <= MARKER_MAX_CHARS).length;
    const markersOnly = markerCount >= MARKERS_MIN_COUNT && wordsOnPicture.length - markerCount <= MARKERS_MAX_OTHER_WORDS;
    if (labelledAsShown && !markersOnly && decision.strategy === 'direct' && repId && (isLabelledPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber)) || fewLabelsOnPicture) && (rep?.maxRelativeArea ?? 1) < LABELLED_PICTURE_MAX_PAGE_SHARE) {
      const look = textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber)) >= LABELLED_SHEET_MIN_TEXT_COVERAGE ? await probeRawLook(page, repId) : null;
      labelledRender = look === null || look.luminanceStdDev > LABELLED_SHEET_MAX_RAW_STDDEV;
    }
    // A card laid askew that the page writes or draws on (see `ASKEW_CARD_MIN_WORDS_ON`).
    let drawnOnAskewCard = false;
    const paintedCard = rep === null || rep === undefined ? undefined : topOccurrenceOnPage(rep, pageNumber);
    const cardRect = decision.strategy === 'direct' && paintedCard !== undefined && paintedCard.blended !== true && (unit.classification === 'content' || unit.classification === 'undecided') ? askewRectangleOfPainting(paintedCard) : null;
    if (cardRect !== null && paintedCard !== undefined && isCardOfRegion(cardRect, paintedCard.index, unit, pageNumber, pageBoxByPage.get(pageNumber), scope.inventory.images)) {
      const card = envelopeOf(cardRect);
      const centreOn = (b: Rect): boolean => (b.minX + b.maxX) / 2 >= card.minX && (b.minX + b.maxX) / 2 <= card.maxX && (b.minY + b.maxY) / 2 >= card.minY && (b.minY + b.maxY) / 2 <= card.maxY;
      const pageWords = scope.opts.wordBoxesByPage?.get(pageNumber) ?? [];
      // (Not the words on a strip of paper laid over it, however translucent: a caption, that strip's writing. Labels laid on a map are not strips.)
      const isStrip = (b: Rect): boolean => Math.max(b.maxX - b.minX, b.maxY - b.minY) >= CAPTION_STRIP_MIN_ASPECT * Math.min(b.maxX - b.minX, b.maxY - b.minY);
      const layersOver = scope.inventory.images.filter((e) => e !== rep && !e.isMaskLayer && e.masksImageObjId === undefined && e.maxRelativeArea >= CARD_OVER_PICTURE_MIN_AREA).flatMap((e) => e.occurrences.filter((o) => o.page === pageNumber && o.index > paintedCard.index && o.blended !== true && isStrip(o.bbox)).map((o) => o.bbox));
      const onLayerOver = (b: Rect): boolean => layersOver.some((c) => { const on = rectIntersection(b, c); return on !== null && rectArea(on) >= TEXT_ON_CARD_MIN_SHARE * rectArea(b); });
      const onCard = pageWords.filter((b) => b.minX >= card.minX && b.maxX <= card.maxX && b.minY >= card.minY && b.maxY <= card.maxY && !onLayerOver(b));
      const wordsOn = onCard.length;
      // A word the page writes aslant on the card (a signature across a photo) is written on it, however few.
      const pageBox = pageBoxByPage.get(pageNumber);
      const smallCard = pageBox === undefined || rectArea(card) <= ASKEW_CARD_ASLANT_MAX_PAGE_SHARE * rectArea(pageBox);
      const aslantOn = smallCard && onCard.some((b) => {
        const { angle, chars } = b as { angle?: number; chars?: number };
        if (angle === undefined || (chars ?? 0) < ASKEW_CARD_ASLANT_WORD_MIN_CHARS) return false;
        // Upright, upside down or on its side (a chapter's tab running up the page's edge) is not aslant.
        const off = ((angle % 90) + 90) % 90;
        return Math.min(off, 90 - off) > ASKEW_CARD_ASLANT_WORD_MIN_DEG;
      });
      const wordsAcross = pageWords.filter((b) => rectIntersection(b, card) !== null && !(b.minX >= card.minX && b.maxX <= card.maxX && b.minY >= card.minY && b.maxY <= card.maxY)).length;
      const words = wordsAcross <= ASKEW_CARD_MAX_WORDS_ACROSS * wordsOn ? wordsOn : 0;
      const paths = [...(scope.inventory.shapes ?? []), ...(scope.inventory.lines ?? [])].filter((v) => v.page === pageNumber && centreOn(v.bbox)).length;
      // A fastener over the card's edge (a paper clip holding the photo to the page, see `FASTENER_REASON`) is not drawn on the card.
      // Nor is a layer blended over its edge, partly off it (a strip of tape holding it to the page), nor a pin stuck in it (a raster this small
      // beside the card).
      const within = (b: Rect): boolean => b.minX >= card.minX && b.maxX <= card.maxX && b.minY >= card.minY && b.maxY <= card.maxY;
      // Nor the mask of another raster (a stencil the page paints with, its labels, is drawing), nor a strip that carries the page's words (a caption on paper laid over the photo: its own writing), nor a small raster
      // running past the card's edge (a paper clip, a strip of tape holding it).
      const carriesWords = (b: Rect): boolean => pageWords.some((w) => { const on = rectIntersection(w, b); return on !== null && rectArea(on) >= TEXT_ON_CARD_MIN_SHARE * rectArea(w); });
      // Small rasters on the card: one or two pins hold it; more are markers the page sets on it (the places of a map).
      const smallOnCard = scope.inventory.images.filter((e) => e !== rep && e.masksImageObjId === undefined && e.occurrences.some((o) => o.page === pageNumber && o.index > paintedCard!.index && centreOn(o.bbox) && rectArea(o.bbox) < ASKEW_CARD_PIN_MAX_SHARE * rectArea(card))).length;
      const pinShare = smallOnCard <= ASKEW_CARD_MAX_PINS ? ASKEW_CARD_PIN_MAX_SHARE : 0;
      const pictures = scope.inventory.images.filter(
        (e) =>
          e !== rep &&
          e.masksImageObjId === undefined &&
          scope.classifiedByEntry.get(e)?.reason !== FASTENER_REASON &&
          e.occurrences.some(
            (o) =>
              o.page === pageNumber &&
              o.index > paintedCard!.index &&
              centreOn(o.bbox) &&
              rectArea(o.bbox) < rectArea(card) &&
              rectArea(o.bbox) >= pinShare * rectArea(card) &&
              !(isStrip(o.bbox) && carriesWords(o.bbox)) &&
              (within(o.bbox) || (o.blended !== true && rectArea(o.bbox) > ASKEW_CARD_FASTENER_MAX_SHARE * rectArea(card))),
          ),
      ).length;
      drawnOnAskewCard = words >= ASKEW_CARD_MIN_WORDS_ON || (words > 0 && aslantOn) || paths >= ASKEW_CARD_MIN_PATHS_ON || pictures >= ASKEW_CARD_MIN_PICTURES_ON;
    }
    // A sheet the page draws on (see `PAGE_DRAWING_MIN_PATHS`).
    // It is rendered over the box of the drawing: the sheet it is drawn on, without the page round it (the book's frame, its running head).
    let drawingOverPage: Rect | null = null;
    if (decision.strategy === 'direct' && repId && placedRep !== undefined && (unit.classification === 'content' || unit.classification === 'undecided') && (rep?.maxRelativeArea ?? 0) >= PAGE_RASTER_MIN_PAGE_SHARE) {
      const within = (b: Rect): boolean => (b.minX + b.maxX) / 2 >= placedRep.minX && (b.minX + b.maxX) / 2 <= placedRep.maxX && (b.minY + b.maxY) / 2 >= placedRep.minY && (b.minY + b.maxY) / 2 <= placedRep.maxY;
      let paths = 0;
      const drawn = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const v of [...(scope.inventory.shapes ?? []), ...(scope.inventory.lines ?? [])]) {
        if (v.page !== pageNumber || !within(v.bbox)) continue;
        paths++;
        drawn.minX = Math.min(drawn.minX, v.bbox.minX);
        drawn.minY = Math.min(drawn.minY, v.bbox.minY);
        drawn.maxX = Math.max(drawn.maxX, v.bbox.maxX);
        drawn.maxY = Math.max(drawn.maxY, v.bbox.maxY);
      }
      const chars = (scope.opts.wordBoxesByPage?.get(pageNumber) ?? []).reduce((sum, w) => sum + ((w as { chars?: number }).chars ?? 1), 0);
      if (paths >= PAGE_DRAWING_MIN_PATHS && chars <= PAGE_DRAWING_MAX_CHARS) drawingOverPage = rectIntersection(drawn, placedRep);
    }
    const drawnOverPage = drawingOverPage !== null;
    const objIdForExtraction = decision.strategy === 'direct' && unit.reason !== LINE_DRAWING_REASON && unit.reason !== ASLANT_HALF_REASON && !labelledRender && !drawnOnAskewCard && !drawnOverPage ? repId : null;
    // A picture the page labels that is rendered anyway (the page's text over it for a good part): the page's paper laid over it on top, plain
    // as a panel's ground, does not make it a panel of text.
    const labelledPicture = labelledRender || (drawingOnSheet && textIsOnPlainCard && decision.strategy === 'region-render') || (decision.strategy === 'region-render' && repId !== null && (isLabelledPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber)) || fewLabelsOnPicture) && (rep?.maxRelativeArea ?? 1) < LABELLED_PICTURE_MAX_PAGE_SHARE);

    // Region-render resolution is DERIVED from the native
    // resolution of the resources in the region, not from a constant —
    // see `renderResolution.ts`. Irrelevant for the `direct` strategy
    // (direct extraction always returns the full source resolution,
    // `targetLongEdgePx` is ignored there) — we probe only when
    // we're actually rendering a region.
    let effectiveTargetLongEdgePx = targetLongEdgePx;
    if (decision.strategy === 'region-render' || drawnOnAskewCard) {
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
      const cardsOverPicture = neighbourUnits.filter((other) => other !== plannedUnit && isCardOfText(other) && paintedAt(other) > paintedAt(plannedUnit)).map((other) => other.bbox);
      unit = { ...unit, bbox: cardWithoutPictures(unit.bbox, cardsOverPicture) };
    }

  return { ...state, isBlendedOnPage, placedRep, photoLook, isPhotoUnderText, textOnPaperCard, decision, blankSheet, objIdForExtraction, effectiveTargetLongEdgePx, paintedAt, isCardOfText, crossesText, unit, labelledRender, labelledPicture, drawingOnSheet, drawnOverPage, drawingOverPage };
}

/**
 * Phase 3 — taking it: the extraction itself and what is done to the pixels afterwards (clip, turn, mirror, erased
 * text and markers, cropped margins).
 */
async function renderUnit(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof judgeUnit>>) {
  const { page, renderer, signal, pageNumber, diagnostics, hideBackgroundImages, textBlockBoxesByPage, opts, maskedObjIds, pageBoxByPage, targetLongEdgePx, maxLongEdgePx, pageRotationByPage, neighbourUnits, pageUnits, autoCropUniformMargins, brightenAutoCroppedImages } = scope;
  const { objIdForExtraction, unit, effectiveTargetLongEdgePx, decision, repId, rep, placedRep, isCardOfText, paintedAt, compositionCount } = state;
    let extractResult = await extractDirect(
      page,
      objIdForExtraction,
      unit.bbox,
      renderer,
      { targetLongEdgePx: effectiveTargetLongEdgePx, signal },
      pageNumber,
    );
    diagnostics.push(...extractResult.diagnostics);
    // A drawing that the page sets its text over (a sketch with a column of a chapter laid on its pale part) is rendered with that text, and the
    // render reads as a document. When the raster itself reads as no document and is a drawing (not blank paper), the text is the page's, not
    // the picture's: the picture is taken from its own pixels, the page's text left to the page. So too when the page's columns run past the
    // drawing's edge (a sketch set in the middle of the page, the two columns wrapped round its blank corners): the render may read as a picture.
    if (hideBackgroundImages && extractResult.source === 'region-render' && decision.reason === 'Z2-text-over-picture-is-content' && repId !== null && rep !== null && rep !== undefined && placedRep !== undefined && rep.occurrences.find((o) => o.page === pageNumber)?.placement === undefined && (looksLikeDocumentImage(extractResult.image) || textCrossingShare(unit.bbox, textBlockBoxesByPage.get(pageNumber)) >= TEXT_RUNS_PAST_PICTURE_MIN_SHARE)) {
      const look = await probeRawLook(page, repId);
      if (look !== null && look.luminanceStdDev >= DRAWING_UNDER_PAGE_TEXT_MIN_STDDEV) {
        const raw = await extractDirect(page, repId, unit.bbox, renderer, { targetLongEdgePx: effectiveTargetLongEdgePx, signal }, pageNumber);
        // The text lies on the blank of the drawing (white), not on a sheet of its own (a newspaper, a dark panel with a sidebar on it).
        const underWords = raw.source === 'region-render' ? null : meanUnderBoxes(raw.image, placedRep, opts.wordBoxesByPage?.get(pageNumber) ?? []);
        if (underWords !== null && underWords.luminance >= DRAWING_UNDER_PAGE_TEXT_MIN_WHITE && underWords.chroma <= DRAWING_UNDER_PAGE_TEXT_MAX_CHROMA && !looksLikeDocumentImage(raw.image)) extractResult = raw;
      }
    }
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

    // A card the page lays a few degrees askew, rendered with what the page draws on it, is its own turned rectangle straightened (see
    // `askewCard.ts`): not the upright box around it, with wedges of the page at its corners. Only when the region is the card's (not a
    // picture of several cards, or a card with a column of text beside it).
    // The card is the layer of the unit painted last (a note over the paper under it): what a clip of four corners shows of it, or its raster's turned rectangle.
    const askewLayers = extractResult.source !== 'region-render' || (unit.classification !== 'content' && unit.classification !== 'undecided') ? [] : [...new Set([rep, ...unit.memberEntries])].flatMap((m) => (m === null || m === undefined ? [] : m.occurrences.filter((o) => o.page === pageNumber && o.blended !== true)));
    const askew = askewLayers
      .sort((x, y) => y.index - x.index)
      .map((o) => ({ rect: askewRectangleOfPainting(o), index: o.index }))
      .find(({ rect, index }) => rect !== null && isCardOfRegion(rect, index, unit, pageNumber, pageBoxByPage.get(pageNumber), scope.inventory.images))?.rect;
    // The turn the straightened render took off (degrees counterclockwise): the page's text on the card is turned with it.
    let askewTiltDeg = 0;
    if (askew !== undefined && askew !== null) {
      extractResult = { ...extractResult, image: await renderRotatedRegion(page, askew, renderer, { targetLongEdgePx: effectiveTargetLongEdgePx, signal }) };
      askewTiltDeg = (askew.rotationRad * 180) / Math.PI;
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
    const hasNeighbourCards = cardRegionClip !== undefined && unitArea > 0 && neighbourUnits.some((other) => {
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

  return { ...state, extractResult, isLargePanel, placementOfRep, drawnOnPanel, image, wholeResource, askewTiltDeg };
}

/**
 * Phase 4 — measuring what was taken: its hash and the figures (contrast, opacity, paper, panel, card, document)
 * that later decide whether it is offered.
 */
async function measureUnit(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof renderUnit>>) {
  const { hideBackgroundImages, textBlockBoxesByPage, pageNumber, neighbourUnits, page, maskedObjIds, opts } = scope;
  const { image, unit, wholeResource, repId, extractResult, paintedAt, compositionCount, rep, placedRep, isPhotoUnderText, isLargePanel, drawnOnPanel } = state;
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
    if (plannedUnit.reason === EDGE_FIGURE_REASON || plannedUnit.reason === EDGE_DOCUMENT_REASON) scope.edgeFigureStdDev = computeVisibleLuminanceStdDev(image);
    // A faded paper vignette laid over the whole page (the page's paper again, cut out by a mask around what it frames) and a few dozen pixels
    // of a raster stretched over its place (a blur of shadow) stand at the page's edge with a spread of a figure: neither is one.
    if (plannedUnit.reason === EDGE_FIGURE_REASON && (isFadedPaperVignette(image, unit.representativeEntry?.maxRelativeArea ?? 0) || Math.max(image.width, image.height) < EDGE_FIGURE_MIN_PIXELS)) scope.edgeFigureStdDev = 0;
    const darkOpaqueShare = hideBackgroundImages ? computeDarkOpaqueShare(wholeResource) : undefined;
    // Only for a picture over the whole page: whether its middle shows a subject (a night scene) or is even (a dark page background).
    const centreDetail = hideBackgroundImages && (unit.representativeEntry?.maxRelativeArea ?? 0) >= NIGHT_SCENE_MIN_AREA ? computeCentreDetail(wholeResource) : undefined;
    // Of what is saved (after the clip): a strip cut from a larger sheet by the page's clip may show only white.
    const whiteOpaqueShare = hideBackgroundImages ? computeWhiteOpaqueShare(image) : undefined;
    // [User request] For BOTH candidates shown in the review list — see `UNIFORM_COLOR_MIN_FRACTION` in `finalize.ts`.
    const uniformColorFraction = hideBackgroundImages ? computeUniformColorFraction(wholeResource) : undefined;
    const smoothness = hideBackgroundImages ? computeSmoothnessMetrics(wholeResource) : undefined;
    const opaqueFraction = hideBackgroundImages ? computeOpaqueFraction(wholeResource) : undefined;
    // A bare sheet of paper with a picture of the page painted over it: the picture's backdrop (see `PAPER_UNDER_PICTURE_MIN_COVER`).
    let paperUnderPicture = false;
    if (hideBackgroundImages && unit.reason !== FULL_PAGE_DOCUMENT_REASON && repId !== null && extractResult.source !== 'region-render' && textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber)) < FLUSH_CARD_MIN_TEXT_COVERAGE) {
      const ownArea = rectArea(unit.bbox);
      // The pictures painted over it together (a drawing in several pieces covers the sheet as one picture does).
      const coveredByPictures = neighbourUnits
        .filter((other) => other !== plannedUnit && other.representativeEntry !== null && (other.classification === 'content' || other.classification === 'undecided') && paintedAt(other) > paintedAt(plannedUnit))
        .reduce((sum, other) => sum + rectArea(rectIntersection(unit.bbox, other.bbox) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0);
      const picturePaintedOver = ownArea > 0 && coveredByPictures / ownArea >= PAPER_UNDER_PICTURE_MIN_COVER;
      if (picturePaintedOver) {
        const sheetLook = await probeRawLook(page, repId);
        // A sheet laid on a darker ground (the page's edges showing round the paper) is plain in its middle.
        const middleLook = sheetLook !== null && sheetLook.luminanceStdDev > PAPER_UNDER_PICTURE_MAX_STDDEV ? await probeRawLook(page, repId, PAPER_UNDER_PICTURE_EDGE_INSET) : sheetLook;
        paperUnderPicture = middleLook !== null && middleLook.luminanceStdDev <= PAPER_UNDER_PICTURE_MAX_STDDEV;
      }
    }
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
    // Not a figure that stands in a tall box (a creature, a person): one solid piece that fills much of what shows (see `isSolidCutOut`).
    const sparseLargeCutout = unit.reason === LARGE_MASKED_CUTOUT_REASON && opaqueFraction !== undefined && opaqueFraction < LARGE_CUTOUT_MIN_OPAQUE_FRACTION && !isSolidCutOut(image);
    // A big picture cut out by a mask whose raster is a plain dark texture (a vignette, a shadow laid over the page that reaches off its edge) shows nothing of its own.
    const cutoutLook = unit.reason === LARGE_MASKED_CUTOUT_REASON && repId !== null ? await probeRawLook(page, repId) : null;
    const darkLargeCutout = cutoutLook !== null && cutoutLook.meanLuminance <= DARK_CUTOUT_MAX_MEAN_LUMINANCE && cutoutLook.luminanceStdDev <= DARK_CUTOUT_MAX_STDDEV;
    // A small picture offered only because text lies over its box is kept when it is a cut-out object (mostly transparent: an item on a card); a card or a photo, opaque all over, under text is not.
    const rawOpaque = unit.reason === TEXT_OVER_SMALL_REASON && repId !== null ? await probeOpaqueFraction(page, repId) : null;
    // A raster blended into the page (a strip of tape, a stain) with text under it is not a box of text: it is hidden, not offered as one.
    const isOverlayOfPage = unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.blended === true;
    const textCard = unit.reason === TEXT_OVER_SMALL_REASON && !isPhotoUnderText && (rawOpaque === null || rawOpaque >= CUT_OUT_MAX_OPAQUE_FRACTION);
    // A page that is a document (a letter, a page of a diary: see `FULL_PAGE_DOCUMENT_REASON`) is a box of text, kept with its text, when its raster
    // is a sheet of tinted paper; one that is not (a white page, a page of art) is the page's background, hidden as before.
    const documentLook = unit.reason === FULL_PAGE_DOCUMENT_REASON && repId !== null ? await probeRawLook(page, repId) : null;
    // A page that is a picture with a few lines of display text over it (the cover of a magazine handed out to the players) is the page as it shows, text and all.
    const fullPagePicture = unit.representativeEntry !== null && unit.representativeEntry.maxRelativeArea >= COVER_MIN_PAGE_SHARE && unit.classification === 'undecided';
    // Not the book's own cover (its first page): its picture is wanted without the title and the blurb set over it.
    const coverPage = hideBackgroundImages && pageNumber !== 1 && fullPagePicture && isCoverText(opts.wordBoxesByPage?.get(pageNumber));
    const documentPage = (documentLook !== null && isDocumentPaper(documentLook)) || coverPage;
    // A page-sized raster that is mostly transparent (an illustration on the upper half of a page-sized canvas) is that picture, not the page's background.
    const visible = unit.reason === FULL_PAGE_DOCUMENT_REASON ? trimTransparentMargins(image) : null;
    const pictureOnCanvas = visible !== null && visible.width * visible.height < PICTURE_ON_CANVAS_MAX_VISIBLE_SHARE * image.width * image.height;
    const pageBackground = unit.reason === FULL_PAGE_DOCUMENT_REASON && !documentPage && !pictureOnCanvas;
    // A flush card of text (a stat block on parchment) is the backdrop of its text, not a picture, whether it was extracted raw or as a render with its text on it.
    // Not a half of a picture across a spread that the page labels (see `isLabelledPicture`): a card does not go on onto the facing page.
    const labelledHalf = (scope.isLeftHalf(plannedUnit) || scope.isRightHalf(plannedUnit)) && isLabelledPicture(unit.bbox, textBlockBoxesByPage.get(pageNumber));
    const flushCardLook = unit.reason === FLUSH_UNDECIDED_REASON && repId !== null && !labelledHalf ? await probeRawLook(page, repId) : null;
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
    // Nor is such a half a panel of text, nor a picture the page labels (see `labelledPicture`).
    if (unit.representativeEntry !== null && repId !== null && extractResult.source === 'region-render' && panelCoverage >= TEXT_PANEL_STYLE_MIN_COVERAGE && !labelledHalf && !state.labelledPicture) {
      const panelLook = await probeRawLook(page, repId);
      textPanelCandidate = isTextPanel(extractResult.source, panelCoverage) && panelLook !== null && panelLook.luminanceStdDev <= TEXT_PANEL_MAX_RAW_STDDEV && panelLook.meanSaturation <= TEXT_PANEL_MAX_RAW_SATURATION;
      if (panelLook !== null && panelLook.luminanceStdDev <= TEXT_PANEL_TINTED_MAX_RAW_STDDEV && panelLook.meanSaturation <= TEXT_PANEL_TINTED_MAX_RAW_SATURATION) {
        textPanelKey = `${unit.representativeEntry.intrinsicWidth}x${unit.representativeEntry.intrinsicHeight}:${panelLook.luminanceStdDev.toFixed(1)}:${panelLook.meanSaturation.toFixed(1)}`;
        textPanelLook = { stdDev: panelLook.luminanceStdDev, saturation: panelLook.meanSaturation, mean: panelLook.meanLuminance, coverage: panelCoverage, textOnCenter: unit.reason === HIGH_TEXT_COVERAGE_REASON || (!isCutOutByOutline && centerCoverage >= TEXT_PANEL_CENTER_MIN_COVERAGE) };
      }
    }
    // A big translucent panel was only let through to be checked for a drawing; without one it is the page's own backdrop.
    if (isLargePanel && !drawnOnPanel) panelBackdrop = true;

  return { ...state, pictureOnCanvas, contentHash, luminanceStdDev, visibleLuminanceStdDev, meanLuminance, darkOpaqueShare, centreDetail, whiteOpaqueShare, uniformColorFraction, smoothness, opaqueFraction, paperUnderPicture, panelBackdrop, sparseLargeCutout, darkLargeCutout, isOverlayOfPage, textCard, documentPage, pageBackground, flushCard, textPanelCandidate, textPanelKey, textPanelLook, centerCoverage, textFillsBox };
}

/**
 * Phase 5 — the entry for finalization: encoding, the grid suggestion, the verdicts read from the pixels (prop,
 * frame, form, ornament, banner) and the record that joins the others of the document.
 */
async function buildUnitEntry(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof measureUnit>>): Promise<PreparedEntryForFinalize<EncodedImage>> {
  const { encoder, opts, pageBoxByPage, pageNumber, figureEntries, hideBackgroundImages, neighbourUnits, isLeftHalf, isRightHalf, textBlockBoxesByPage, page, renderer, signal, idOnThisPage, targetLongEdgePx, headingBlockBoxesByPage, inventory, imageByItem, ownImageByItem, tossedPropItems, smallCutOutItems, inkStyleByItem, formPages, possibleSheetParts, photoCuts } = scope;
  const { drawnOverPage, drawingOverPage, pictureOnCanvas, askewTiltDeg, drawingOnSheet, labelledRender, image, isLargePanel, drawnOnPanel, unit, extractResult, paintedAt, placedRep, rep, compositionCount, repId, effectiveTargetLongEdgePx, blankSheet, panelBackdrop, paperUnderPicture, pageBackground, sparseLargeCutout, darkLargeCutout, textCard, flushCard, documentPage, whiteOpaqueShare, isBlendedOnPage, isOverlayOfPage, placementOfRep, isCardOfText, contentHash, luminanceStdDev, meanLuminance, visibleLuminanceStdDev, darkOpaqueShare, centreDetail, uniformColorFraction, smoothness, opaqueFraction, textPanelCandidate, textPanelKey, textFillsBox, textOnPaperCard, photoLook, centerCoverage, textPanelLook } = state;
    // Grid suggestion — NOT limited to 'content' (unlike
    // `luminanceStdDev` above): 'undecided' can also end up on stage by
    // the user's manual decision in the review screen), and the cost of
    // computing it is negligible relative to the decode already
    // performed anyway.
    const suggestedGrid = detectGrid(image) ?? undefined;
    const encoded = await encoder.encode(image, { format: opts.outputFormat, quality: opts.outputQuality });
    scope.lastPanelImage = isLargePanel && drawnOnPanel ? image : null;

    const pageBoxOfUnit = pageBoxByPage.get(pageNumber);
    const entryForFinalize = unit.representativeEntry ?? syntheticVectorOnlyEntry(pageNumber, unit.bbox, unit.reason === VECTOR_FIGURE_REASON && pageBoxOfUnit !== undefined && rectArea(pageBoxOfUnit) > 0 ? rectArea(unit.bbox) / rectArea(pageBoxOfUnit) : 1);
    // A purely vector region forced to 'content' (line
    // above) is a deliberate, confident decision (a successful render
    // of a vector-drawn map) — it gets high confidence, NOT the lower
    // `undecided` confidence inherited from `unit.confidence` (which
    // described something else: "no image to extract directly").
    if (unit.representativeEntry === null && unit.reason === VECTOR_FIGURE_REASON) figureEntries.add(entryForFinalize);
    const confidence = unit.representativeEntry || unit.reason === VECTOR_FIGURE_REASON ? unit.confidence : confidenceForReason('Z1-large-relative-area');
    // A backdrop under a card of text and pictures (the page's texture behind a column, a sheet and a photograph): rendered, it is the card's
    // text and the pictures again, which are offered by themselves (see `isBackdropOfCardsAbove`).
    // The page's faded paper laid over a picture painted before it (a vignette around a map on its card): no picture of its own.
    const paperOverPicture =
      extractResult.source !== 'region-render' &&
      isFadedPaperOverlay(image) &&
      neighbourUnits.some((other) => {
        if (other === plannedUnit || other.representativeEntry === null || paintedAt(other) >= paintedAt(plannedUnit)) return false;
        const shared = rectIntersection(other.bbox, unit.bbox);
        return shared !== null && rectArea(shared) >= SAME_FOOTPRINT_MIN_SHARE * rectArea(other.bbox);
      });
    // Not a picture the page labels, taken as the page shows it: the patches laid under its labels are the map's own (see `isLabelledPicture`).
    const backdropOfCards =
      hideBackgroundImages &&
      extractResult.source === 'region-render' &&
      !labelledRender &&
      unit.reason !== LINE_DRAWING_REASON &&
      unit.classification !== 'decoration' &&
      unit.classification !== 'mask' &&
      isBackdropOfCardsAbove(
        unit.bbox,
        // The page's paper laid over the whole of the picture (a translucent panel, a vignette cut out around it and looked at once more at the
        // page's edge) is the page's texture, no card on it.
        neighbourUnits
          .filter((other) => other !== plannedUnit && other.representativeEntry !== null && (other.classification === 'content' || other.classification === 'undecided') && paintedAt(other) > paintedAt(plannedUnit))
          .filter((other) => {
            if (other.reason !== LARGE_TRANSLUCENT_PANEL_REASON && other.reason !== EDGE_FIGURE_REASON) return true;
            const shared = rectIntersection(other.bbox, unit.bbox);
            return shared === null || rectArea(shared) < SAME_FOOTPRINT_MIN_SHARE * rectArea(unit.bbox);
          })
          .map((other) => other.bbox),
        opts.wordBoxesByPage?.get(pageNumber),
      );
    // A form or a table that is a picture with its text drawn into it (a filled character sheet): the page has no text of it to find, so the pixels are read.
    // The frame of a box of text (a header bar and thin sides, transparent within), or its ground of one flat colour, that the page's text lies over: no picture.
    // Not a half of a picture across a spread nor a figure at the page's edge: their blank part is the rest of the picture on the facing page.
    const textBoxFrame = extractResult.source !== 'region-render' && plannedUnit.reason !== EDGE_FIGURE_REASON && !isLeftHalf(plannedUnit) && !isRightHalf(plannedUnit) && (unit.reason === TEXT_OVER_SMALL_REASON || unit.reason === HIGH_TEXT_COVERAGE_REASON || textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber)) >= FRAME_MIN_TEXT_COVERAGE) && (isFrameOfTextBox(image) || (hideBackgroundImages && isFlatFill(image)));
    // A prop tossed over the page's edge (a die, a chip, a card, a bullet hole, photographed on a blank ground and laid half off the
    // page): a cut-out object that the page cuts through, no picture of the book.
    const pageBoxHere = pageBoxByPage.get(pageNumber);
    // A prop rendered with the page (paired by mistake with another across the gutter) is judged by its own raster (turned or not: only
    // its ground is measured).
    const overPageEdge = hideBackgroundImages && placedRep !== undefined && pageBoxHere !== undefined && offPageShare(placedRep, pageBoxHere) >= PROP_MIN_OFF_PAGE_SHARE;
    const propCandidate = overPageEdge && (rep?.maxRelativeArea ?? 1) <= PROP_MAX_PAGE_SHARE;
    const propRaw = overPageEdge && extractResult.source === 'region-render' && compositionCount === 1 && repId !== null ? await extractDirect(page, repId, unit.bbox, renderer, { targetLongEdgePx: effectiveTargetLongEdgePx, signal }, pageNumber) : null;
    const propImage = extractResult.source !== 'region-render' ? image : propRaw !== null && propRaw.source !== 'region-render' ? propRaw.image : null;
    const tossedProp =
      propCandidate &&
      propImage !== null &&
      blankGroundShare(propImage) >= PROP_MIN_BLANK_GROUND_SHARE &&
      // A handout laid over the page's edge (a typed memo) is a document, not a prop.
      !looksLikeDocumentImage(propImage);
    // Pieces of the page's paper laid on the page (its corner with its shading, the whole page cut into tiles under its text): light rasters that run
    // off two edges of the page at least, each a small part of it, with no page text over them unless they make up the whole page.
    let paperPieces = false;
    if (hideBackgroundImages && pageBoxOfUnit !== undefined && unit.representativeEntry !== null && unit.classification !== 'decoration' && unit.classification !== 'mask') {
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= PAPER_PIECE_EDGE_PT;
      const edges = [near(unit.bbox.minX, pageBoxOfUnit.minX) || unit.bbox.minX < pageBoxOfUnit.minX, near(unit.bbox.maxX, pageBoxOfUnit.maxX) || unit.bbox.maxX > pageBoxOfUnit.maxX, near(unit.bbox.minY, pageBoxOfUnit.minY) || unit.bbox.minY < pageBoxOfUnit.minY, near(unit.bbox.maxY, pageBoxOfUnit.maxY) || unit.bbox.maxY > pageBoxOfUnit.maxY].filter(Boolean).length;
      const wholePage = unitPageShareOf(unit.bbox, pageBoxOfUnit) >= PAPER_PIECES_MIN_PAGE_SHARE;
      if (edges >= 2 && unit.memberEntries.every((m) => m.maxRelativeArea < PAPER_PIECE_MAX_PAGE_SHARE) && (wholePage || textCoverage(unit.bbox, opts.wordBoxesByPage?.get(pageNumber)) <= PAPER_PIECE_MAX_WORD_COVERAGE)) {
        let weighted = 0;
        let weight = 0;
        for (const member of unit.memberEntries) {
          const memberId = idOnThisPage(member);
          const look = memberId === null ? null : await probeRawLook(page, memberId);
          if (look === null) {
            weight = 0;
            break;
          }
          weighted += look.meanLuminance * member.maxRelativeArea;
          weight += member.maxRelativeArea;
        }
        paperPieces = weight > 0 && weighted / weight >= PAPER_PIECE_MIN_MEAN_LUMINANCE;
      }
    }
    const hiddenByPixels = paperPieces || paperOverPicture || tossedProp || textBoxFrame || blankSheet || panelBackdrop || paperUnderPicture || pageBackground || sparseLargeCutout || darkLargeCutout || textCard || flushCard || documentPage || backdropOfCards || (unit.reason === VECTOR_FIGURE_REASON && unit.representativeEntry === null && whiteOpaqueShare !== undefined && whiteOpaqueShare >= FIGURE_MAX_WHITE_SHARE);
    // Not read for a drawing in lines (a floor plan on squared paper reads as the rules of a table): the page's words were judged over it already (see `LINE_DRAWING_MAX_WORD_COVERAGE`).
    // Nor for a render of a sheet the page draws a picture on in paths (see `DRAWING_ON_SHEET_MIN_PATHS`), for the same reason.
    const rasterMeasure = hideBackgroundImages && !hiddenByPixels && unit.classification !== 'decoration' && unit.classification !== 'mask' && unit.reason !== LINE_DRAWING_REASON && !(drawingOnSheet && extractResult.source === 'region-render') ? measureRasterText(image) : null;
    const rasterForm = rasterMeasure !== null && readsAsDocument(rasterMeasure, image);
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
    // A document whose text is drawn into its raster, with a picture of the page painted over a good part of it (a photograph laid on a memo):
    // the part that shows has too few lines to be a page of documents by itself, but it is one, and offered as a picture it is the picture under a picture.
    let documentUnderPicture = false;
    if (hideBackgroundImages && rasterMeasure !== null && !rasterForm && extractResult.source !== 'region-render' && looksLikeCoveredDocument(rasterMeasure)) {
      const ownArea = rectArea(unit.bbox);
      documentUnderPicture =
        ownArea > 0 &&
        neighbourUnits.some((other) => {
          if (other === plannedUnit || other.representativeEntry === null || (other.classification !== 'content' && other.classification !== 'undecided')) return false;
          if (paintedAt(other) <= paintedAt(plannedUnit)) return false;
          const shared = rectIntersection(unit.bbox, other.bbox);
          return shared !== null && rectArea(shared) / ownArea >= DOCUMENT_UNDER_PICTURE_MIN_COVER;
        });
    }
    // A sheet of paper, blank in its own pixels, that the page writes its text on (a page of text on its own paper, a sheet laid on the page with text over it):
    // offered by itself it is an empty sheet, so it is a box of text, kept with the text (see `isWrittenPaper`).
    let writtenPaper = false;
    const unitPageShare = pageBoxOfUnit !== undefined && rectArea(pageBoxOfUnit) > 0 ? rectArea(unit.bbox) / rectArea(pageBoxOfUnit) : 0;
    const vectorsOverUnit = inventory.vectors.filter((v) => v.page === pageNumber && v.relativeArea < WRITTEN_PAPER_VECTOR_MAX_PAGE_SHARE).reduce((sum, v) => sum + rectArea(rectIntersection(unit.bbox, v.bbox) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }), 0);
    const wordsOverUnit = textCoverage(unit.bbox, opts.wordBoxesByPage?.get(pageNumber));
    if (
      hideBackgroundImages &&
      !hiddenByPixels &&
      !rasterForm &&
      !inkSplatter &&
      !boxTrack &&
      !headingBanner &&
      extractResult.source !== 'region-render' &&
      repId !== null &&
      unit.classification !== 'decoration' &&
      unit.classification !== 'mask' &&
      Math.min(unit.bbox.maxX - unit.bbox.minX, unit.bbox.maxY - unit.bbox.minY) >= WRITTEN_PAPER_MIN_SIDE_PT &&
      unitPageShare >= WRITTEN_PAPER_MIN_PAGE_SHARE &&
      vectorsOverUnit < WRITTEN_PAPER_MAX_VECTOR_COVER * rectArea(unit.bbox) &&
      (rasterMeasure?.lines ?? 0) <= WRITTEN_PAPER_MAX_RASTER_LINES &&
      wordsOverUnit >= WRITTEN_PAPER_MIN_WORD_COVERAGE &&
      textCrossingShare(unit.bbox, opts.wordBoxesByPage?.get(pageNumber)) <= WRITTEN_PAPER_MAX_CROSSING_SHARE * textCoverage(unit.bbox, opts.wordBoxesByPage?.get(pageNumber))
    ) {
      const paperLook = await probeRawLook(page, repId);
      // A figure cut out of a transparent ground, the page's text set in that ground beside it, is no sheet the text is written on.
      const paperOpaque = await probeOpaqueFraction(page, repId);
      writtenPaper = paperLook !== null && isWrittenPaper(paperLook, wordsOverUnit) && (paperOpaque === null || paperOpaque >= WRITTEN_PAPER_MIN_OPAQUE_FRACTION);
    }
    const holdsText = unit.reason === CARD_REASON || (!headingBanner && ((rasterForm && unit.representativeEntry !== null) || ((textCard || flushCard || documentPage || writtenPaper || documentUnderPicture) && !blankSheet && !panelBackdrop && !paperUnderPicture && !sparseLargeCutout && !darkLargeCutout && !isOverlayOfPage)));
    // A card or a note of text whose text the PAGE writes on it (not drawn into its raster, as on a form): its raw resource is the blank paper, so
    // what is kept for it is the render of its place on the page, the text with it. Its hash is the render's too — notes written on one and the same
    // paper raster would otherwise be one picture to the deduplication.
    let cardSource = extractResult.source;
    let cardImage: DecodedImage | null = null;
    // A document under a picture has its text in its own pixels: its raster is the whole document, the render would be the picture over it.
    if (holdsText && !rasterForm && !documentUnderPicture && extractResult.source !== 'region-render') {
      const pageBox = pageBoxByPage.get(pageNumber);
      const box = pageBox === undefined ? unit.bbox : { minX: Math.max(unit.bbox.minX, pageBox.minX), minY: Math.max(unit.bbox.minY, pageBox.minY), maxX: Math.min(unit.bbox.maxX, pageBox.maxX), maxY: Math.min(unit.bbox.maxY, pageBox.maxY) };
      if (rectArea(box) > 0) {
        cardImage = await renderer.renderRegion(page, box, { targetLongEdgePx: effectiveTargetLongEdgePx, signal });
        cardSource = 'region-render';
        // A picture that the page paints over the card and that is offered by itself (an illustration beside a stat block) is not part of the
        // card: where it lies, the card's own paper is put back, unless the page's words lie there (then the render keeps what the page shows).
        if (placedRep && placementOfRep === undefined) {
          const words = opts.wordBoxesByPage?.get(pageNumber);
          for (const other of neighbourUnits) {
            if (other === plannedUnit || other.representativeEntry === null || (other.classification !== 'content' && other.classification !== 'undecided') || isCardOfText(other)) continue;
            if (paintedAt(other) <= paintedAt(plannedUnit)) continue;
            const over = rectIntersection(box, other.bbox);
            if (over === null || rectArea(over) <= 0 || textCoverage(over, words) > PICTURE_OVER_CARD_MAX_WORD_COVERAGE) continue;
            coverWithRaster(cardImage, box, extractResult.image, placedRep, over);
          }
        }
      }
    }
    // A card whose text the page sets sideways or askew is turned so that it reads left to right (see `readingTurn.ts`): a box of text, or a
    // render that the page's words cover a good part of (a letter, a telegram); a map with a few labels set sideways is not turned.
    const wordsOfPage = opts.wordBoxesByPage?.get(pageNumber);
    let turnedByItsText = false;
    if (holdsText || (extractResult.source === 'region-render' && textCoverage(unit.bbox, wordsOfPage) >= TURN_MIN_WORD_COVERAGE)) {
      const angle = dominantTextAngle(unit.bbox, wordsOfPage);
      // On a card rendered straightened (see `askewCard.ts`) the text runs at its angle less the card's turn.
      const turned = angle === null ? null : turnUpright(cardImage ?? image, cardImage === null ? angle - askewTiltDeg : angle);
      if (turned !== null) {
        cardImage = turned;
        turnedByItsText = true;
      }
    } else if (hideBackgroundImages && !hiddenByPixels && !rasterForm && unit.classification !== 'decoration' && unit.classification !== 'mask' && !inShapedWindow(unit.representativeEntry?.occurrences.find((o) => o.page === pageNumber)?.clip)) {
      // A print that the page lays askew is offered straightened and cut to its rectangle (see `tiltedRectangle.ts`).
      const straightened = straightenTiltedPicture(cardImage ?? image);
      if (straightened !== null) cardImage = straightened;
    }
    // A document lying on its side whose text is in its pixels (a cutting, an open notebook): stood up (see `standUpSidewaysDocument`).
    // Which of the rules that turn or trim a picture changed this one (for the measuring tool, see `ruleTrace.ts`).
    const traced: string[] = drawnOverPage ? ['drawn-over-page'] : [];
    const placedTurns = rep === null ? undefined : topOccurrenceOnPage(rep, pageNumber)?.placement?.quarterTurns;
    if (!turnedByItsText && (placedTurns === 1 || placedTurns === 3)) {
      const stoodUp = standUpSidewaysDocument(cardImage ?? image, placedTurns, looksLikeDocumentImage, (shown) => sidewaysLettering(shown).turns !== 0);
      if (stoodUp !== null) {
        cardImage = stoodUp;
        traced.push('placed-document-turn');
      }
    }
    // Pictures painted into the page's own raster (a map or photographs on the paper of the book, with its frame): each is cut out and
    // offered by itself, and the raster, which is the page's ground, is not offered (see `picturesOnGround.ts`). Only for a raster that
    // covers the page and is taken as the PDF stores it, upright and whole; not for a page offered whole because the caller asked for that
    // (`treatFullBleedAsContent`, with its own optional crop). Found once, here, so that the raster is not turned before it is cut.
    const coversPage = placedRep !== undefined && pageBoxOfUnit !== undefined && rectArea(placedRep) >= PAGE_RASTER_MIN_PAGE_SHARE * rectArea(pageBoxOfUnit);
    let groundPictures: GroundPictures | null | undefined;
    const picturesOnGround = (): GroundPictures | null => {
      if (groundPictures === undefined) {
        const candidate = hideBackgroundImages && unit.reason !== 'Z1-full-bleed-forced-content' && coversPage && placedRep !== undefined && !cardImage && extractResult.source !== 'region-render' && placementOfRep === undefined && image === extractResult.image;
        // Solid pictures first; failing those, cards laid over one another on the paper (see `cardsOnGround.ts`); failing those, a single
        // sheet; failing that, drawings in line within the book's frame (a map on the paper, a floor plan).
        const solidFound = candidate ? findPicturesOnGround(image) : null;
        // Pictures found upright that are cards laid askew (postcards on a page, one over the corner of the other): each lies within a card
        // the outlines tell, and is cut along that card's sides, straight, not as its upright box (wedges of the page, a corner cut off).
        const askewCards = solidFound !== null ? findCardsOnGround(image) : null;
        const cardsHold = (rects: readonly PixelRect[], quads: readonly CardQuad[]): boolean =>
          rects.length === quads.length &&
          rects.every((r) => quads.some((q) => {
            const e = envelopeOfCard(q);
            const w = Math.min(r.x + r.width, e.x + e.width) - Math.max(r.x, e.x);
            const h = Math.min(r.y + r.height, e.y + e.height) - Math.max(r.y, e.y);
            return w > 0 && h > 0 && w * h >= SOLID_WITHIN_CARD_MIN_SHARE * r.width * r.height;
          }));
        const solid = askewCards !== null && cardsHold(solidFound!, askewCards) ? null : solidFound;
        const cards = candidate && solid === null ? (askewCards ?? findCardsOnGround(image)) : null;
        // Failing those, a single sheet laid upright on the paper (a handout in the book's frame, see `singleCardOnGround.ts`): its writing is
        // the sheet's, not the page's text drawn as a picture.
        const sheet = candidate && solid === null && cards === null ? findSingleCardOnGround(image) : null;
        const drawn = candidate && solid === null && cards === null && sheet === null ? findDrawingsOnGround(image) : null;
        groundPictures =
          solid !== null ? { rects: solid, drawings: false } : cards !== null ? { rects: cards.map(envelopeOfCard), drawings: false, cards } : drawn !== null ? { rects: drawn, drawings: true } : sheet !== null ? { rects: [sheet], drawings: false } : null;
      }
      return groundPictures;
    };
    // A picture lying on its side whose lettering is in its pixels (a map turned to fit the page): stood up (see `sidewaysText.ts`). A raster
    // whose pictures are cut out is not: each cut is stood up by itself.
    // Which way the lettering reads is told on the whole render: the sheet cut out of it below has less of it (see `drawingOverPage`).
    const lettered = cardImage ?? image;
    // A book's cover (a picture over the whole of its first page) stands as it is: its picture may run up and down (the bars of a number,
    // a meshed plate) as lettering on its side does.
    const cover = pageNumber === 1 && coversPage;
    const letteringTurns = !cover && !turnedByItsText && placedTurns !== 1 && placedTurns !== 3 && !holdsText && (unit.classification === 'content' || unit.classification === 'undecided') && lettered.width < lettered.height && picturesOnGround() === null ? sidewaysLettering(lettered).turns : 0;
    // A sheet the page draws on is cut to the box of its drawing, without the page round it (see `PAGE_DRAWING_MIN_PATHS`).
    // The whole render, as it is offered (stood up), is what the halves of a spread are matched by (see `imageByItem`).
    let seamImage: DecodedImage | null = null;
    if (drawingOverPage !== null && extractResult.source === 'region-render' && cardImage === null) {
      const sx = image.width / Math.max(1e-6, unit.bbox.maxX - unit.bbox.minX);
      const sy = image.height / Math.max(1e-6, unit.bbox.maxY - unit.bbox.minY);
      const x = Math.max(0, Math.floor((drawingOverPage.minX - unit.bbox.minX) * sx));
      const y = Math.max(0, Math.floor((drawingOverPage.minY - unit.bbox.minY) * sy));
      const width = Math.min(image.width, Math.ceil((drawingOverPage.maxX - unit.bbox.minX) * sx)) - x;
      const height = Math.min(image.height, Math.ceil((drawingOverPage.maxY - unit.bbox.minY) * sy)) - y;
      if (width > 0 && height > 0) {
        cardImage = cropDecodedImage(image, { x, y, width, height });
        seamImage = image;
        traced.push('drawing-sheet-cut');
      }
    }
    if (letteringTurns !== 0) {
      cardImage = rotateQuarterTurns(cardImage ?? image, letteringTurns);
      if (seamImage !== null) seamImage = rotateQuarterTurns(seamImage, letteringTurns);
      traced.push('lettering-turn');
    }
    // A cut-out stored on a larger canvas is offered without the transparent margin round it (it shows as an empty frame), unless that
    // would make a strip of it (one that long and narrow is taken for an ornament and hidden; a banner measured at 617x134, 567x89 cut).
    const untrimmed = cardImage ?? image;
    const trimmed = trimTransparentMargins(untrimmed);
    const aspectOf = (d: { width: number; height: number }): number => Math.max(d.width, d.height) / Math.max(1, Math.min(d.width, d.height));
    if (trimmed !== null && !(aspectOf(trimmed) >= EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD && aspectOf(untrimmed) < EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD)) {
      cardImage = trimmed;
      traced.push('transparent-trim');
    }
    // A page painted as a sheet lying on a dark ground (a leather folder) is offered as the sheet, without the ground round it.
    // The halves of a spread are matched at the gutter as they were (see `imageByItem`): two pages, each a sheet in the folder, cut to their
    // sheets, go on into each other at the gutter as any two light papers do. So does a sheet cut to its drawing beside a blank page.
    const surrounded = cardImage ?? image;
    const unwrapped = trimDarkSurround(surrounded);
    if (unwrapped !== null && !(aspectOf(unwrapped) >= EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD && aspectOf(surrounded) < EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD)) {
      cardImage = unwrapped;
      traced.push('dark-surround-trim');
    }
    if (pictureOnCanvas) traced.push('picture-on-canvas');
    const result: PreparedEntryForFinalize<EncodedImage> = {
      entry: entryForFinalize,
      // A grid of small rasters that renders with the page's text is the boxes of a form (a character sheet), not a picture stored in tiles.
      classification: hiddenByPixels || rasterForm || inkSplatter || boxTrack || headingBanner || writtenPaper || documentUnderPicture || (holdsText && unit.reason === GRID_PICTURE_REASON) ? 'decoration' : unit.representativeEntry || unit.reason === VECTOR_FIGURE_REASON ? unit.classification : 'content',
      confidence,
      extractSource: cardSource,
      contentHash: cardImage ? await computeContentHash(cardImage) : contentHash,
      width: (cardImage ?? image).width,
      height: (cardImage ?? image).height,
      luminanceStdDev,
      meanLuminance,
      visibleLuminanceStdDev,
      darkOpaqueShare,
      centreDetail,
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
      holdsText: holdsText ? true : undefined,
      payload: cardImage ? await encoder.encode(cardImage, { format: opts.outputFormat, quality: opts.outputQuality }) : encoded,
    };
    imageByItem.set(result, seamImage !== null ? seamImage : unwrapped !== null && cardImage === unwrapped ? surrounded : (cardImage ?? image));
    for (const rule of traced) ruleTrace.hook?.(rule, pageNumber, result.contentHash);
    ownImageByItem.set(result, image);
    if (tossedProp) {
      tossedPropItems.add(result);
      // Counted when nothing else hides it: a stain or a backdrop hidden anyway says nothing of the book's props.
      const hiddenOtherwise = textBoxFrame || blankSheet || panelBackdrop || paperUnderPicture || pageBackground || sparseLargeCutout || darkLargeCutout || textCard || flushCard || documentPage || backdropOfCards;
      // Nor a hidden picture looked at once more at the page's edge (see `EDGE_DOCUMENT_REASON`, `EDGE_FIGURE_REASON`): dropped anyway unless it is a document or a figure.
      // Nor a strip along the page's edge (hidden later as one): a prop is an object, about as wide as it is tall.
      // Nor a figure cut out over a third of the page or more (see `isSolidCutOut`): a prop is a small object.
      if (!hiddenOtherwise && (unit.classification === 'content' || unit.classification === 'undecided') && plannedUnit.reason !== EDGE_DOCUMENT_REASON && plannedUnit.reason !== EDGE_FIGURE_REASON && unit.reason !== LARGE_MASKED_CUTOUT_REASON && Math.max(image.width, image.height) <= PROP_MAX_ASPECT * Math.min(image.width, image.height)) scope.tossedPropCount++;
    } else if ((result.classification === 'undecided' || result.classification === 'content') && !result.holdsText && repId !== null) {
      // A cut-out object on a blank ground, judged by its own raster (one laid over the page's edge and rendered with the page: its raster).
      // A render of a picture on the page is its card of text or the page under it: only its own raster, taken anyway, is judged.
      // A render with no text of the page over it shows the object on the page's paper: judged as it is.
      const own = compositionCount !== 1 && extractResult.source === 'region-render' ? null : propImage ?? (extractResult.source === 'region-render' && textCoverage(unit.bbox, textBlockBoxesByPage.get(pageNumber)) <= BOOK_PROP_MAX_TEXT_COVERAGE ? image : null);
      const ownBlank = own !== null ? paperGroundShare(own) : 0;
      // A stain of the page's paper (a faint coffee ring in a corner) rendered with what lies over it (cards of text drawn with rasters of
      // their own): its own raster is paper and nothing else. Not the page's paper itself (a page of logos rendered on it).
      const rawOfStain = own === null && extractResult.source === 'region-render' && (rep?.maxRelativeArea ?? 1) <= BOOK_PROP_MAX_DRAWN_SHARE ? await extractDirect(page, repId, unit.bbox, renderer, { targetLongEdgePx: effectiveTargetLongEdgePx, signal }, pageNumber) : null;
      if (rawOfStain !== null && rawOfStain.source !== 'region-render' && paperGroundShare(rawOfStain.image) >= BOOK_PROP_MIN_PAPER_STAIN_SHARE) smallCutOutItems.push(result);
      else if (own !== null && ownBlank >= BOOK_PROP_MIN_BLANK_GROUND_SHARE && (rep?.maxRelativeArea ?? 1) * (1 - ownBlank) <= BOOK_PROP_MAX_DRAWN_SHARE && !looksLikeDocumentImage(own)) smallCutOutItems.push(result);
    }
    if ((result.classification === 'undecided' && !result.holdsText) || tossedProp) {
      const shown = cardImage ?? image;
      inkStyleByItem.set(result, { style: measureInkStyle(shown), width: shown.width, height: shown.height });
    }
    if (rasterForm) formPages.add(unit.page);
    else if (rasterMeasure !== null && !inkSplatter && !boxTrack && isPartOfSheet(rasterMeasure)) possibleSheetParts.push({ item: result, page: unit.page });
    // A photograph laid on a page of documents in one raster: the raster goes with the boxes of text, the photograph, cut out of it, is offered
    // by itself. Only for a raster taken as the PDF stores it, upright and whole (a render's text is the page's own, and a turned or cropped raster
    // no longer maps onto its place on the page).
    if (rasterMeasure !== null && !cardImage && extractResult.source !== 'region-render' && placedRep && placementOfRep === undefined && image === extractResult.image) {
      const photo = findPhotoInDocument(image);
      if (photo !== null) {
        result.classification = 'decoration';
        result.holdsText = true;
        const cut = cropDecodedImage(image, photo);
        const pw = placedRep.maxX - placedRep.minX;
        const ph = placedRep.maxY - placedRep.minY;
        const cutBox: Rect = {
          minX: placedRep.minX + (photo.x / image.width) * pw,
          maxX: placedRep.minX + ((photo.x + photo.width) / image.width) * pw,
          maxY: placedRep.maxY - (photo.y / image.height) * ph,
          minY: placedRep.maxY - ((photo.y + photo.height) / image.height) * ph,
        };
        const pageArea = pageBoxOfUnit !== undefined ? rectArea(pageBoxOfUnit) : 0;
        photoCuts.push({
          entry: syntheticVectorOnlyEntry(pageNumber, cutBox, pageArea > 0 ? rectArea(cutBox) / pageArea : 0),
          classification: 'undecided',
          confidence: confidenceForReason('Z1-no-strong-signal'),
          extractSource: extractResult.source,
          contentHash: await computeContentHash(cut),
          width: cut.width,
          height: cut.height,
          payload: await encoder.encode(cut, { format: opts.outputFormat, quality: opts.outputQuality }),
        });
      }
    }
    // The pictures on the page's ground found above, cut out (unless the raster was taken otherwise since). A raster the page's
    // text lies on (a plan whose labels, or a page whose number, the page sets as text) stays where it was, among the images
    // with text, and its pictures are rendered from the page, so that what the page writes on them is in them.
    const offeredRaster = (result.classification === 'content' || result.classification === 'undecided') && result.holdsText !== true;
    const rasterUnderText = result.holdsText === true;
    // Cards on the page's raster are cut from the raster even when what is kept of it is a render (a page of handouts taken for a card of text).
    const cardsUnderRender = (): GroundPictures | null => {
      const candidate = hideBackgroundImages && unit.reason !== 'Z1-full-bleed-forced-content' && coversPage && placementOfRep === undefined && extractResult.source !== 'region-render' && image === extractResult.image;
      const cards = candidate ? findCardsOnGround(image) : null;
      return cards === null ? null : { rects: cards.map(envelopeOfCard), drawings: false, cards };
    };
    // A page raster rendered with the page's text over it (a handout whose writing the page sets as text): the single sheet on its paper is read
    // from the raster's own pixels, and rendered over its box, with the writing.
    let sheetUnderRender: GroundPictures | null = null;
    if (rasterUnderText && cardImage && hideBackgroundImages && coversPage && placementOfRep === undefined && repId !== null && placedRep) {
      const raw = await probeRawImage(page, repId);
      const sheet = raw === null ? null : findSingleCardOnGround(raw);
      if (raw !== null && sheet !== null) {
        const sx = image.width / raw.width;
        const sy = image.height / raw.height;
        sheetUnderRender = { rects: [{ x: Math.round(sheet.x * sx), y: Math.round(sheet.y * sy), width: Math.round(sheet.width * sx), height: Math.round(sheet.height * sy) }], drawings: false };
      }
    }
    const found = placedRep && (offeredRaster || rasterUnderText) ? (!cardImage ? picturesOnGround() : rasterUnderText ? (cardsUnderRender() ?? sheetUnderRender) : null) : null;
    if (placedRep && found !== null) {
      const pw = placedRep.maxX - placedRep.minX;
      const ph = placedRep.maxY - placedRep.minY;
      const pageArea = pageBoxOfUnit !== undefined ? rectArea(pageBoxOfUnit) : 0;
      const cuts: { box: Rect; image: DecodedImage; turned: boolean }[] = [];
      for (const [n, picture] of found.rects.entries()) {
        const box: Rect = {
          minX: placedRep.minX + (picture.x / image.width) * pw,
          maxX: placedRep.minX + ((picture.x + picture.width) / image.width) * pw,
          maxY: placedRep.maxY - (picture.y / image.height) * ph,
          minY: placedRep.maxY - ((picture.y + picture.height) / image.height) * ph,
        };
        const rendered = rasterUnderText ? await renderer.renderRegion(page, box, { targetLongEdgePx: effectiveTargetLongEdgePx, signal }) : null;
        // A card is cut along its own four sides and made upright (in the render, its corners where they fall in the render's box).
        const card = found.cards?.[n];
        const taken =
          card !== undefined
            ? rendered !== null
              ? takeCard(rendered, {
                  corners: card.corners.map(intoRender(picture, rendered)) as CardQuad['corners'],
                  ...(card.coveredBy ? { coveredBy: card.coveredBy.map((cover) => cover.map(intoRender(picture, rendered)) as CardQuad['corners']) } : {}),
                })
              : takeCard(image, card)
            : (rendered ?? cropDecodedImage(image, picture));
        const stoodUp = standUpLettering(taken);
        cuts.push({ box, image: stoodUp ?? taken, turned: stoodUp !== null });
      }
      // What is drawn on a page and reads as written text (a letter drawn into the page's image) is the page's text, not a drawing.
      if (!(found.drawings && cuts.some((cut) => looksLikeWrittenImage(cut.image)))) {
        if (offeredRaster) result.classification = 'decoration';
        for (const { box, image: cut, turned } of cuts) {
          const cutHash = await computeContentHash(cut);
          ruleTrace.hook?.(found.cards !== undefined ? 'card-on-ground' : found.drawings ? 'drawing-in-frame' : 'picture-on-ground', pageNumber, cutHash);
          if (turned) ruleTrace.hook?.('lettering-turn', pageNumber, cutHash);
          photoCuts.push({
            entry: syntheticVectorOnlyEntry(pageNumber, box, pageArea > 0 ? rectArea(box) / pageArea : 0),
            classification: 'undecided',
            confidence: confidenceForReason('Z1-no-strong-signal'),
            extractSource: rasterUnderText ? 'region-render' : extractResult.source,
            contentHash: cutHash,
            width: cut.width,
            height: cut.height,
            suggestedGrid: detectGrid(cut) ?? undefined,
            payload: await encoder.encode(cut, { format: opts.outputFormat, quality: opts.outputQuality }),
          });
        }
      }
    }
    // A sheet of items set apart on blank paper (the weapons of an equipment list, each with its name): each item offered by
    // itself, and the sheet not (see `itemsOnBlank.ts`). Only for a picture rendered from the page, gathered from several
    // pieces and the page's words: a single image whose parts lie apart (dice, a logo, a sign in brush strokes) is one
    // picture, and so is a document (a newspaper, a card).
    const shown = cardImage ?? image;
    const renderedSheet = (cardImage ? cardSource : extractResult.source) === 'region-render';
    // The page's words on it are the items' names, little of it (a page of text with a picture is more).
    if (renderedSheet && (result.classification === 'content' || result.classification === 'undecided') && !holdsText && result.holdsText !== true && textCoverage(unit.bbox, wordsOfPage) <= ITEM_SHEET_MAX_WORD_COVERAGE && !looksLikeDocumentImage(shown)) {
      // The items are offered without the names the page writes beside them: the page's words are painted over first.
      const box = unit.bbox;
      const bw = box.maxX - box.minX;
      const bh = box.maxY - box.minY;
      const words = (wordsOfPage ?? []).flatMap((w): PixelRect[] => {
        const over = rectIntersection(w, box);
        if (over === null || bw <= 0 || bh <= 0) return [];
        // A little round each word, for the strokes of its letters that reach past its box.
        const margin = 0.15 * (over.maxY - over.minY);
        return [
          {
            x: ((over.minX - margin - box.minX) / bw) * shown.width,
            y: ((box.maxY - over.maxY - margin) / bh) * shown.height,
            width: ((over.maxX - over.minX + 2 * margin) / bw) * shown.width,
            height: ((over.maxY - over.minY + 2 * margin) / bh) * shown.height,
          },
        ];
      });
      const sheet = words.length > 0 ? withoutBoxes(shown, words) : shown;
      const pieces = findItemsOnBlank(sheet);
      const items = pieces !== null && areNamedItems(pieces, words, Math.max(shown.width, shown.height)) ? pieces : null;
      if (items !== null) {
        result.classification = 'decoration';
        const pageArea = pageBoxOfUnit !== undefined ? rectArea(pageBoxOfUnit) : 0;
        for (const item of items) {
          const cut = cropDecodedImage(item.foreign.length > 0 ? withoutBoxes(sheet, item.foreign) : sheet, item);
          const itemHash = await computeContentHash(cut);
          ruleTrace.hook?.('item-of-sheet', pageNumber, itemHash);
          const itemBox: Rect = {
            minX: box.minX + (item.x / shown.width) * bw,
            maxX: box.minX + ((item.x + item.width) / shown.width) * bw,
            maxY: box.maxY - (item.y / shown.height) * bh,
            minY: box.maxY - ((item.y + item.height) / shown.height) * bh,
          };
          photoCuts.push({
            entry: syntheticVectorOnlyEntry(pageNumber, itemBox, pageArea > 0 ? rectArea(itemBox) / pageArea : 0),
            classification: 'undecided',
            confidence: confidenceForReason('Z1-no-strong-signal'),
            extractSource: cardImage ? cardSource : extractResult.source,
            contentHash: itemHash,
            width: cut.width,
            height: cut.height,
            suggestedGrid: detectGrid(cut) ?? undefined,
            payload: await encoder.encode(cut, { format: opts.outputFormat, quality: opts.outputQuality }),
          });
        }
      }
    }
    return result;
}

/**
 * Extracts one unit of one page: the five phases above in order, each handing its findings to the next. This was the
 * body of a single closure inside `buildImageExtraction.ts`; the statements are unchanged, only cut into phases.
 */
export async function extractUnitOfPage(scope: UnitScope, plannedUnit: ExtractionUnit): Promise<PreparedEntryForFinalize<EncodedImage>> {
  const s0 = await composeUnit(scope, plannedUnit);
  const s1 = await judgeUnit(scope, plannedUnit, s0);
  const s2 = await renderUnit(scope, plannedUnit, s1);
  const s3 = await measureUnit(scope, plannedUnit, s2);
  const entry = await buildUnitEntry(scope, plannedUnit, s3);
  // A picture the page labels, taken as the page shows it, that the render shows as text (a map beside a column of the page's text): the picture
  // is taken from its own pixels, as it is without labels.
  if (!s1.labelledRender || entry.holdsText !== true) return entry;
  const r0 = await composeUnit(scope, plannedUnit);
  const r1 = await judgeUnit(scope, plannedUnit, r0, false);
  const r2 = await renderUnit(scope, plannedUnit, r1);
  const r3 = await measureUnit(scope, plannedUnit, r2);
  return buildUnitEntry(scope, plannedUnit, r3);
}
