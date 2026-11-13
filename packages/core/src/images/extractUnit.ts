import { rectArea, rectIntersection, unionRect, type Matrix, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { confidenceForReason, FLUSH_UNDECIDED_REASON, FULL_PAGE_DOCUMENT_REASON, LARGE_MASKED_CUTOUT_REASON, TEXT_OVER_SMALL_REASON, LARGE_TRANSLUCENT_PANEL_REASON, isBackdropShape, isTranslucentEverywhere } from './classify.js';
import { AUTOCROP_BRIGHTEN, brightenCroppedImage } from './brightenImage.js';
import { cardOfPiece, cardWithoutPictures } from './cardBesidePictures.js';
import { looksLikeTrackOfBoxes } from './boxGrid.js';
import { looksLikeInkSplatter } from './inkSplatter.js';
import { isPartOfSheet, looksLikeCoveredDocument, measureRasterText } from './rasterText.js';
import { shrinkToCenter, type ClassifiedImage } from './classify.js';
import { applyClipToImage, clipShowsWholePicture, renderThroughRectangularClip } from './clipMask.js';
import { cropDecodedImage, detectContentBounds } from './cropUniformMargins.js';
import { coverWithRaster } from './coverWithRaster.js';
import { straightenTiltedPicture } from './tiltedRectangle.js';
import { findPhotoInDocument } from './photoInDocument.js';
import { dominantTextAngle, turnUpright } from './readingTurn.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder } from './encodeImage.js';
import { isBlankSheet } from './blankSheet.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { mirrorImage, rotateQuarterTurns } from './rotateQuarterTurns.js';
import { eraseNumberMarkers } from './numberMarkers.js';
import { eraseTextAroundFigure } from './eraseFigureText.js';
import { drawnShare, isBareDarkTexture, isColorfulPicture, isDrawingOnPanel, isPanelBackdrop, PANEL_MIN_TEXT_COVERAGE, PANEL_PREVIEW_LONG_EDGE_PX, PANEL_FRAMES_PICTURE_MIN_SHARE, PANEL_OVERLAY_MIN_OPAQUE_FRACTION } from './panelBackdrop.js';
import { FULL_EXTENT_BOUNDS, tightenToVisible } from './opaqueBounds.js';
import { measureInkStyle, type InkStyle } from './bookOrnaments.js';
import { extractDirect, probeIntrinsicLongEdgePx, probeIntrinsicSizePx, probeOpaqueBounds, probeOpaquePixelStats, probeRawLook, probeOpaqueFraction, waitForObjects, type PdfPageForExtract } from './extract.js';
import { computeContentHash, computeDarkOpaqueShare, computeWhiteOpaqueShare, computeLuminanceStdDev, computeVisibleLuminanceStdDev, computeVisibleMeanLuminance, computeOpaqueFraction, computeUniformColorFraction, computeSmoothnessMetrics, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import { computeTargetLongEdgePx } from './renderResolution.js';
import { CO_MEMBER_SIGNIFICANT_AREA, decideExtractionStrategy } from './strategy.js';
import type { BuildImageExtractionOptions, ExtractionUnit, InventoryForImages } from './extractionTypes.js';
import { CARD_REASON, COVERED_MEMBER_MIN_COVER, COVER_MIN_OPAQUE_FRACTION, CUTOUT_TEXT_MIN_COVERAGE, FIGURE_MAX_WHITE_SHARE, PANEL_BEHIND_PICTURE_MIN_AREA_SHARE, PAPER_OVERLAY_MIN_COVER_OF_PICTURE, TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION, VECTOR_FIGURE_REASON, alternativeRepresentatives, compositionMembers, isPaperOverlay, syntheticVectorOnlyEntry, topOccurrenceOnPage, withSolidRepresentativeOfBackdrop } from './extractionUnits.js';
import { BANNER_MAX_RAW_STDDEV, CLIP_CUT_MIN_REMAINING_SHARE, COVER_MIN_PAGE_SHARE, CUT_OUT_MAX_OPAQUE_FRACTION, CUT_OUT_OUTLINE_MIN_POINTS, DARK_CUTOUT_MAX_MEAN_LUMINANCE, DARK_CUTOUT_MAX_STDDEV, DOCUMENT_UNDER_PICTURE_MIN_COVER, EDGE_DOCUMENT_REASON, EDGE_FIGURE_REASON, EDGE_STRIP_MIN_REPRESENTATIVE_AREA, FLUSH_CARD_MIN_TEXT_COVERAGE, HIGH_TEXT_COVERAGE_REASON, LARGE_CUTOUT_MIN_OPAQUE_FRACTION, MAP_UNDER_LABELS_MIN_MEAN_LUMINANCE, MASK_TILTED_RECTANGLE_MAX_TEXT_COVERAGE, NEIGHBOUR_CARD_MAX_AREA, NEIGHBOUR_CARD_MIN_OVERLAP, NOTE_MAX_AREA, NOTE_PIECE_MIN_TEXT_CROSSING, PAPER_CARD_MIN_MEAN_LUMINANCE, PAPER_NOTE_MIN_CENTER_COVERAGE, PAPER_UNDER_PICTURE_EDGE_INSET, PAPER_UNDER_PICTURE_MAX_STDDEV, PAPER_UNDER_PICTURE_MIN_COVER, PICTURE_OVER_CARD_MAX_WORD_COVERAGE, PICTURE_OVER_CARD_MIN_AREA, SAME_FOOTPRINT_MIN_SHARE, TEXT_COVERED_BACKDROP_REASON, TEXT_FILLS_BOX_MIN_COVERAGE, TEXT_PANEL_CENTER_MIN_COVERAGE, TEXT_PANEL_MAX_AREA, TEXT_PANEL_MAX_RAW_SATURATION, TEXT_PANEL_MAX_RAW_STDDEV, TEXT_PANEL_MIN_TEXT_COVERAGE, TEXT_PANEL_STYLE_MIN_COVERAGE, TEXT_PANEL_TINTED_MAX_RAW_SATURATION, TEXT_PANEL_TINTED_MAX_RAW_STDDEV, TEXT_RUNS_PAST_PICTURE_MIN_SHARE, TIGHTEN_MIN_OPAQUE_FRACTION, TIGHTEN_MIN_TEXT_BESIDE_SHARE, TIGHTEN_MIN_TEXT_COVERAGE, TURN_MIN_WORD_COVERAGE, WRITTEN_PAPER_MAX_CROSSING_SHARE, WRITTEN_PAPER_MAX_RASTER_LINES, WRITTEN_PAPER_MAX_VECTOR_COVER, WRITTEN_PAPER_MIN_OPAQUE_FRACTION, WRITTEN_PAPER_MIN_PAGE_SHARE, WRITTEN_PAPER_MIN_SIDE_PT, WRITTEN_PAPER_MIN_WORD_COVERAGE, WRITTEN_PAPER_VECTOR_MAX_PAGE_SHARE, isBackdropOfCardsAbove, isBackdropOfTextBesideRepresentative, isCoverText, isDocumentPaper, isFlushCardOfText, isHeadingBannerText, isLongStrip, isPhotoUnderNotes, isSmallPieceBesideRepresentative, isTextOverPicture, isTextPanel, isWrittenPaper, looksLikePlainTextCard, maskResourceLetsMostThrough, rawResourceFitsPlacement, textCoverage, textCrossesRegionEdge, textCrossingShare } from './extractionLooks.js';
import { ASLANT_HALF_REASON, BOOK_PROP_MAX_DRAWN_SHARE, BOOK_PROP_MAX_TEXT_COVERAGE, BOOK_PROP_MIN_BLANK_GROUND_SHARE, BOOK_PROP_MIN_PAPER_STAIN_SHARE, DRAWING_UNDER_PAGE_TEXT_MAX_CHROMA, DRAWING_UNDER_PAGE_TEXT_MIN_STDDEV, DRAWING_UNDER_PAGE_TEXT_MIN_WHITE, FRAME_MIN_TEXT_COVERAGE, GRID_PICTURE_REASON, LINE_DRAWING_REASON, PROP_MAX_ASPECT, PROP_MAX_PAGE_SHARE, PROP_MIN_BLANK_GROUND_SHARE, PROP_MIN_OFF_PAGE_SHARE, blankGroundShare, isFlatFill, isFrameOfTextBox, looksLikeDocumentImage, meanUnderBoxes, offPageShare, paperGroundShare, readsAsDocument } from './extractionJoins.js';
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
async function judgeUnit(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof composeUnit>>) {
  const { textBlockBoxesByPage, pageNumber, page, idOnThisPage, maskedObjIds, targetLongEdgePx, maxLongEdgePx, classified, pageBoxByPage, pageUnits, neighbourUnits } = scope;
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
    if (textOverPicture && rep?.objId && repId && placedRep && !maskedObjIds.has(rep.objId) && coMemberAreaShare < CO_MEMBER_SIGNIFICANT_AREA) {
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
    const textOnPaperCard = textIsOnPlainCard && photoLook !== null && photoLook.meanLuminance >= PAPER_CARD_MIN_MEAN_LUMINANCE;
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
    // A line drawing on the pictures is what the page draws over their rasters: only a render shows it (see `withLineDrawings`).
    const objIdForExtraction = decision.strategy === 'direct' && unit.reason !== LINE_DRAWING_REASON && unit.reason !== ASLANT_HALF_REASON ? repId : null;

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
      const cardsOverPicture = neighbourUnits.filter((other) => other !== plannedUnit && isCardOfText(other) && paintedAt(other) > paintedAt(plannedUnit)).map((other) => other.bbox);
      unit = { ...unit, bbox: cardWithoutPictures(unit.bbox, cardsOverPicture) };
    }

  return { ...state, isBlendedOnPage, placedRep, photoLook, isPhotoUnderText, textOnPaperCard, decision, blankSheet, objIdForExtraction, effectiveTargetLongEdgePx, paintedAt, isCardOfText, crossesText, unit };
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

  return { ...state, extractResult, isLargePanel, placementOfRep, drawnOnPanel, image, wholeResource };
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
    const darkOpaqueShare = hideBackgroundImages ? computeDarkOpaqueShare(wholeResource) : undefined;
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
    const sparseLargeCutout = unit.reason === LARGE_MASKED_CUTOUT_REASON && opaqueFraction !== undefined && opaqueFraction < LARGE_CUTOUT_MIN_OPAQUE_FRACTION;
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
    const coverPage = hideBackgroundImages && fullPagePicture && isCoverText(opts.wordBoxesByPage?.get(pageNumber));
    const documentPage = (documentLook !== null && isDocumentPaper(documentLook)) || coverPage;
    const pageBackground = unit.reason === FULL_PAGE_DOCUMENT_REASON && !documentPage;
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

  return { ...state, contentHash, luminanceStdDev, visibleLuminanceStdDev, meanLuminance, darkOpaqueShare, whiteOpaqueShare, uniformColorFraction, smoothness, opaqueFraction, paperUnderPicture, panelBackdrop, sparseLargeCutout, darkLargeCutout, isOverlayOfPage, textCard, documentPage, pageBackground, flushCard, textPanelCandidate, textPanelKey, textPanelLook, centerCoverage, textFillsBox };
}

/**
 * Phase 5 — the entry for finalization: encoding, the grid suggestion, the verdicts read from the pixels (prop,
 * frame, form, ornament, banner) and the record that joins the others of the document.
 */
async function buildUnitEntry(scope: UnitScope, plannedUnit: ExtractionUnit, state: Awaited<ReturnType<typeof measureUnit>>): Promise<PreparedEntryForFinalize<EncodedImage>> {
  const { encoder, opts, pageBoxByPage, pageNumber, figureEntries, hideBackgroundImages, neighbourUnits, isLeftHalf, isRightHalf, textBlockBoxesByPage, page, renderer, signal, idOnThisPage, targetLongEdgePx, headingBlockBoxesByPage, inventory, imageByItem, ownImageByItem, tossedPropItems, smallCutOutItems, inkStyleByItem, formPages, possibleSheetParts, photoCuts } = scope;
  const { image, isLargePanel, drawnOnPanel, unit, extractResult, paintedAt, placedRep, rep, compositionCount, repId, effectiveTargetLongEdgePx, blankSheet, panelBackdrop, paperUnderPicture, pageBackground, sparseLargeCutout, darkLargeCutout, textCard, flushCard, documentPage, whiteOpaqueShare, isBlendedOnPage, isOverlayOfPage, placementOfRep, isCardOfText, contentHash, luminanceStdDev, meanLuminance, visibleLuminanceStdDev, darkOpaqueShare, uniformColorFraction, smoothness, opaqueFraction, textPanelCandidate, textPanelKey, textFillsBox, textOnPaperCard, photoLook, centerCoverage, textPanelLook } = state;
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
    const backdropOfCards =
      hideBackgroundImages &&
      extractResult.source === 'region-render' &&
      unit.reason !== LINE_DRAWING_REASON &&
      unit.classification !== 'decoration' &&
      unit.classification !== 'mask' &&
      isBackdropOfCardsAbove(
        unit.bbox,
        neighbourUnits.filter((other) => other !== plannedUnit && other.representativeEntry !== null && (other.classification === 'content' || other.classification === 'undecided') && paintedAt(other) > paintedAt(plannedUnit)).map((other) => other.bbox),
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
    const hiddenByPixels = paperPieces || tossedProp || textBoxFrame || blankSheet || panelBackdrop || paperUnderPicture || pageBackground || sparseLargeCutout || darkLargeCutout || textCard || flushCard || documentPage || backdropOfCards || (unit.reason === VECTOR_FIGURE_REASON && unit.representativeEntry === null && whiteOpaqueShare !== undefined && whiteOpaqueShare >= FIGURE_MAX_WHITE_SHARE);
    const rasterMeasure = hideBackgroundImages && !hiddenByPixels && unit.classification !== 'decoration' && unit.classification !== 'mask' ? measureRasterText(image) : null;
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
    if (holdsText || (extractResult.source === 'region-render' && textCoverage(unit.bbox, wordsOfPage) >= TURN_MIN_WORD_COVERAGE)) {
      const angle = dominantTextAngle(unit.bbox, wordsOfPage);
      const turned = angle === null ? null : turnUpright(cardImage ?? image, angle);
      if (turned !== null) cardImage = turned;
    } else if (hideBackgroundImages && !hiddenByPixels && !rasterForm && unit.classification !== 'decoration' && unit.classification !== 'mask') {
      // A print that the page lays askew is offered straightened and cut to its rectangle (see `tiltedRectangle.ts`).
      const straightened = straightenTiltedPicture(cardImage ?? image);
      if (straightened !== null) cardImage = straightened;
    }
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
    imageByItem.set(result, cardImage ?? image);
    ownImageByItem.set(result, image);
    if (tossedProp) {
      tossedPropItems.add(result);
      // Counted when nothing else hides it: a stain or a backdrop hidden anyway says nothing of the book's props.
      const hiddenOtherwise = textBoxFrame || blankSheet || panelBackdrop || paperUnderPicture || pageBackground || sparseLargeCutout || darkLargeCutout || textCard || flushCard || documentPage || backdropOfCards;
      // Nor a hidden picture looked at once more at the page's edge (see `EDGE_DOCUMENT_REASON`, `EDGE_FIGURE_REASON`): dropped anyway unless it is a document or a figure.
      // Nor a strip along the page's edge (hidden later as one): a prop is an object, about as wide as it is tall.
      if (!hiddenOtherwise && (unit.classification === 'content' || unit.classification === 'undecided') && plannedUnit.reason !== EDGE_DOCUMENT_REASON && plannedUnit.reason !== EDGE_FIGURE_REASON && Math.max(image.width, image.height) <= PROP_MAX_ASPECT * Math.min(image.width, image.height)) scope.tossedPropCount++;
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
  return buildUnitEntry(scope, plannedUnit, s3);
}
