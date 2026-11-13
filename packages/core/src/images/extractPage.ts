import type { Diagnostic } from '../text/types.js';
import { rectArea, rectIntersection, unionRect, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import { LARGE_TRANSLUCENT_PANEL_REASON, isTranslucentEverywhere, maxBleedOverhangPt, type ClassifiedImage } from './classify.js';
import { detectGrid } from './detectGrid.js';
import type { EncodedImage, ImageEncoder } from './encodeImage.js';
import { looksLikeWhiteWash } from './blankSheet.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { dropLeftColumns, stitchHorizontally } from './stitchHorizontally.js';
import { halvesContinueAcrossSeam } from './spreadSeam.js';
import { isBareDarkTexture } from './panelBackdrop.js';
import { connectedGroups, placedMasksOverlap, type OpaqueMask, type PlacedMask } from './opaqueOverlap.js';
import { isShapedClip } from '../inventory/clipPaths.js';
import { extractDirect, probeMaskRectangularity, probeInkMask, probeOpaqueMask, probeRawLook, probeOpaqueFraction, waitForObjects, type PdfPageForExtract } from './extract.js';
import { computeContentHash, isNeverWorthReviewing, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import type { BuildImageExtractionOptions, ExtractionUnit, PageState, RunTally } from './extractionTypes.js';
import { alternativeRepresentatives, checkAborted } from './extractionUnits.js';
import { CARD_ITEM_MIN_AREA, CUT_OUT_MAX_OPAQUE_FRACTION, EDGE_DOCUMENT_REASON, EDGE_FIGURE_MIN_STDDEV, EDGE_FIGURE_REASON, EDGE_PRINT_MAX_OVERHANG_PT, INDEPENDENT_IMAGE_AREA_THRESHOLD, LARGE_CUT_OUT_MAX_OPAQUE_SHARE, SILHOUETTE_MAX_RECTANGULARITY, UNDER_PICTURES_MIN_AREA, isSmallCardOfText, opaqueShare, textCoverage } from './extractionLooks.js';
import { ASLANT_HALF_EDGE_TOLERANCE_PT, ASLANT_HALF_MAX_WORD_COVERAGE, ASLANT_HALF_MIN_WIDTH_PT, ASLANT_HALF_REASON, COVERED_BY_LATER_REASON, FRAME_AROUND_PICTURE_MIN_INSIDE_SHARE, GRID_PICTURE_REASON, LINE_DRAWING_REASON, LINE_DRAWING_REMAINDER_REASON, SPREAD_COMPANION_REASON, SPREAD_HALF_MIN_VISIBLE_SHARE, SPREAD_STRIP_MAX_WIDTH_SHARE, isEmptyWithin, looksLikeDocumentImage, visibleShareOf } from './extractionJoins.js';
import { CLIPPED_PIECES_REASON, INK_BOX_MARGIN_PT, INK_BOX_MAX_WORD_COVERAGE, INK_BOX_MIN_KEPT_SHARE, INK_BOX_MIN_PAPER_LUMINANCE, INK_BOX_MIN_WORD_COVERAGE, RENDERED_PIECE_MIN_INSIDE_SHARE, SLICED_PICTURE_REASON, SLICE_MARGIN_PT, type TileSource, areMosaicTiles, areSeamedTiles, clearOfCrossingText, rowsClearOfText, shownBoxOfSlices } from './extractionPieces.js';

/**
 * What processing a page's units reads: the plan of the run (see `planExtraction.ts`), the run's shared state
 * (`tally`), and the page's own tools and state built by `buildImageExtraction.ts` when it opens the page.
 */
export interface PageScope {
  readonly spreadRightOf: Map<ExtractionUnit, ExtractionUnit>;
  readonly spreadRightHalves: Set<ExtractionUnit>;
  readonly splitBlendedByInk: (u: ExtractionUnit) => Promise<ExtractionUnit[] | null>;
  readonly idOnThisPage: (entry: ImageEntry) => string | null;
  readonly pageNumber: number;
  readonly pageState: PageState;
  readonly page: PdfPageForExtract & {    cleanup(): void;};
  readonly textBlockBoxesByPage: ReadonlyMap<number, readonly Rect[]>;
  readonly maskedObjIds: ReadonlySet<string>;
  readonly unitOfMembers: (u: ExtractionUnit, members: readonly ImageEntry[], boxes: readonly Rect[]) => ExtractionUnit;
  readonly opts: BuildImageExtractionOptions;
  readonly unitsByPage: Map<number, ExtractionUnit[]>;
  readonly halfKey: (u: ExtractionUnit) => string | null;
  readonly aslantLeftKeys: Set<string>;
  readonly renderer: RegionRenderer;
  readonly targetLongEdgePx: number;
  readonly signal: AbortSignal | undefined;
  readonly aslantRightKeys: Set<string>;
  readonly aslantRightKeyOf: Map<string, string>;
  readonly pageBoxByPage: Map<number, Rect>;
  readonly aslantRowsOf: Map<string, {    minY: number;    maxY: number;}>;
  readonly pageUnits: ExtractionUnit[];
  readonly tally: RunTally;
  readonly isRightHalf: (u: ExtractionUnit) => boolean;
  readonly isLeftHalf: (u: ExtractionUnit) => boolean;
  readonly onProgress: ((done: number, total: number) => void) | undefined;
  readonly maskHoldersByTarget: Map<string, ImageEntry[]>;
  readonly extractUnit: (plannedUnit: ExtractionUnit) => Promise<PreparedEntryForFinalize<EncodedImage>>;
  readonly piecedOrigin: Map<ExtractionUnit, ExtractionUnit>;
  readonly compositeOfPieces: (u: ExtractionUnit) => Promise<DecodedImage | null>;
  readonly uprightOfTurnedPieces: (u: ExtractionUnit) => Promise<DecodedImage | null>;
  readonly encoder: ImageEncoder;
  readonly imageByItem: WeakMap<object, DecodedImage>;
  readonly ownImageByItem: WeakMap<object, DecodedImage>;
  readonly classified: ClassifiedImage[];
  readonly tossedPropItems: WeakSet<object>;
  readonly prepared: PreparedEntryForFinalize<EncodedImage>[];
  readonly rawRasterOf: (u: ExtractionUnit) => Promise<DecodedImage | null>;
  readonly diagnostics: Diagnostic[];
}

/**
 * Stage 1 of a page — which units to extract and in what order: a unit whose pictures do not overlap in what
 * they show is split, the halves of a picture across a spread are recognised, and the units are put in the order
 * that lets one use what another has rendered.
 */
async function planUnitsOfPage(scope: PageScope) {
  const { spreadRightOf, spreadRightHalves, splitBlendedByInk, idOnThisPage, pageNumber, pageState, page, textBlockBoxesByPage, maskedObjIds, unitOfMembers, opts, unitsByPage, halfKey, aslantLeftKeys, renderer, targetLongEdgePx, signal, aslantRightKeys, aslantRightKeyOf, pageBoxByPage, aslantRowsOf, pageUnits, tally } = scope;
  const splitByVisiblePixels = async (u: ExtractionUnit): Promise<ExtractionUnit[]> => {
    // A line drawing is one picture whatever rasters it lies on (see `withLineDrawings`).
    if (u.memberEntries.length < 2 || u.representativeEntry === null || u.reason === LINE_DRAWING_REASON || spreadRightOf.has(u) || spreadRightHalves.has(u)) return [u];
    const byInk = await splitBlendedByInk(u);
    if (byInk !== null) return byInk;
    const pieces: ExtractionUnit[] = [];
    let rest = u;
    const wash = u.representativeEntry;
    const washId = idOnThisPage(wash);
    const washBox = wash.occurrences.find((o) => o.page === pageNumber)?.bbox;
    if (wash.objId !== null && washId !== null && washBox !== undefined && wash.maxRelativeArea >= UNDER_PICTURES_MIN_AREA) {
      if (pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [washId], pageState.settleBudgetMs);
      const washLook = await probeRawLook(page, washId);
      // A white mist, or a plain card of paper the page's text lies on: what the small pictures of the unit lie on, not a picture of the unit.
      const isCardOfText = isSmallCardOfText(wash.maxRelativeArea, washLook, await probeOpaqueFraction(page, washId), textCoverage(washBox, textBlockBoxesByPage.get(pageNumber)));
      const others = u.memberEntries.filter((m) => m !== wash);
      // A card of text that has only cut-out objects (on a transparent ground) lying on it: the cards of items, not a note with a photo pinned to it.
      let onlyCutOuts = isCardOfText && others.every((m) => m.maxRelativeArea >= CARD_ITEM_MIN_AREA);
      for (const m of onlyCutOuts ? others : []) {
        const memberId = idOnThisPage(m);
        if (memberId === null) { onlyCutOuts = false; break; }
        if (pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [memberId], pageState.settleBudgetMs);
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
      const large = member.maxRelativeArea >= INDEPENDENT_IMAGE_AREA_THRESHOLD;
      if (own === undefined || memberId === null || member.objId === null || maskedObjIds.has(member.objId) || isTranslucentEverywhere(member)) return [...pieces, rest];
      // A picture in a frame, turned or blended is taken for opaque all over its box: its pixels are not mapped.
      if (own.clip !== undefined || own.placement?.rotated === true || own.blended === true) {
        if (large) return [...pieces, rest];
        placed.push({ entry: member, framed: true, item: { box: own.bbox, flipX: false, flipY: false, mask: { width: 1, height: 1, opaque: new Uint8Array([1]) } } });
        continue;
      }
      if (pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [memberId], pageState.settleBudgetMs);
      const mask = await probeOpaqueMask(page, memberId);
      if (mask === null) return [...pieces, rest];
      // A large picture is a picture of its own; it is told apart from the others by its pixels only when it is cut out of a transparent ground
      // (items drawn on nothing, their boxes overlapping where their drawings do not).
      if (large && opaqueShare(mask) >= LARGE_CUT_OUT_MAX_OPAQUE_SHARE) return [...pieces, rest];
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
  const shownBoxOf = async (members: readonly ImageEntry[]): Promise<Rect | null> => {
    const masks = new Map<string, OpaqueMask>();
    for (const m of members) {
      const memberId = idOnThisPage(m);
      if (memberId === null || m.objId === null) continue;
      if (pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [memberId], pageState.settleBudgetMs);
      // A raster with a transparent edge has no paper to tell its ink from: what it shows is where it is not transparent.
      const mask = (await probeInkMask(page, memberId)) ?? (await probeOpaqueMask(page, memberId));
      if (mask !== null) masks.set(m.objId, mask);
    }
    return shownBoxOfSlices(members, pageNumber, masks);
  };
  // Pictures drawn on white paper, laid one over the other, are rendered together from the page; where the white of a raster reaches over
  // the page's text (a table above the drawings, the page number beside them), the render would carry that text. The render is cut to
  // what the drawings show (inked against the paper of their edges), when that leaves the text out.
  const clearOfTextByInk = async (u: ExtractionUnit): Promise<ExtractionUnit> => {
    const words = opts.wordBoxesByPage?.get(pageNumber);
    if (u.memberEntries.length < 2 || u.representativeEntry === null) return u;
    if (!u.memberEntries.every((m) => {
      const own = m.occurrences.find((o) => o.page === pageNumber);
      return own !== undefined && own.clip === undefined && own.placement?.rotated !== true && own.blended !== true;
    })) return u;
    // A card of text (the page's words over much of it) is not drawings beside the text: it is left whole.
    if (textCoverage(u.bbox, words) > INK_BOX_MAX_WORD_COVERAGE || textCoverage(u.bbox, words) < INK_BOX_MIN_WORD_COVERAGE) return u;
    // Drawings on light paper, or cut out of a transparent ground; on a dark ground (a cover), the ink is not told from the paper of the edge.
    const repId = idOnThisPage(u.representativeEntry);
    const ink = repId === null ? null : await probeInkMask(page, repId);
    if (ink !== null && (ink.paperLuminance ?? 0) < INK_BOX_MIN_PAPER_LUMINANCE) return u;
    const shown = await shownBoxOf(u.memberEntries);
    if (shown === null) return u;
    const padded = { minX: shown.minX - INK_BOX_MARGIN_PT, minY: shown.minY - INK_BOX_MARGIN_PT, maxX: shown.maxX + INK_BOX_MARGIN_PT, maxY: shown.maxY + INK_BOX_MARGIN_PT };
    const cut = rectIntersection(padded, u.bbox);
    if (cut === null || textCoverage(cut, words) >= textCoverage(u.bbox, words) || rectArea(cut) < INK_BOX_MIN_KEPT_SHARE * rectArea(u.bbox)) return u;
    // A word still across its side (the page number beside the drawings) is cut off as well; not one across its foot or head (a caption), which
    // would take the edge of the drawing with it.
    return { ...u, bbox: clearOfCrossingText(cut, words ?? [], 'sides') };
  };
  const slicedBoxes: Rect[] = [];
  for (const planned of unitsByPage.get(pageNumber) ?? []) {
    const key = halfKey(planned);
    // A card of text laid aslant across the spread (its text in its own pixels) is no half of a picture: the pair is let go.
    if (key !== null && aslantLeftKeys.has(key) && planned.representativeEntry !== null) {
      const repId = idOnThisPage(planned.representativeEntry);
      const raw = repId === null ? null : await extractDirect(page, repId, planned.bbox, renderer, { targetLongEdgePx, signal }, pageNumber);
      if (raw === null || raw.source === 'region-render' || looksLikeDocumentImage(raw.image)) {
        aslantRightKeys.delete(aslantRightKeyOf.get(key)!);
        aslantLeftKeys.delete(key);
      }
    }
    if (key !== null && (aslantLeftKeys.has(key) || aslantRightKeys.has(key)) && planned.memberEntries.length === 1) {
      const pageBox = pageBoxByPage.get(pageNumber);
      const shown = await shownBoxOf(planned.memberEntries);
      const isLeftKey = aslantLeftKeys.has(key);
      // What a half shows: the left one runs from within its page to the gutter, the right one from the gutter to within its page, and the
      // page's words lie on little of it. A picture across a whole page (the page's background) or a card of text is no half.
      const showsHalf =
        pageBox !== undefined &&
        shown !== null &&
        textCoverage(shown, opts.wordBoxesByPage?.get(pageNumber)) <= ASLANT_HALF_MAX_WORD_COVERAGE &&
        (isLeftKey
          ? shown.maxX >= pageBox.maxX - ASLANT_HALF_EDGE_TOLERANCE_PT && shown.minX > pageBox.minX + ASLANT_HALF_EDGE_TOLERANCE_PT
          : shown.minX <= pageBox.minX + ASLANT_HALF_EDGE_TOLERANCE_PT && shown.maxX < pageBox.maxX - ASLANT_HALF_EDGE_TOLERANCE_PT);
      if (!showsHalf) {
        if (isLeftKey) aslantRightKeys.delete(aslantRightKeyOf.get(key)!);
        aslantLeftKeys.delete(key);
        aslantRightKeys.delete(key);
      }
    }
    if (key !== null && (aslantLeftKeys.has(key) || aslantRightKeys.has(key)) && planned.memberEntries.length === 1) {
      const pageBox = pageBoxByPage.get(pageNumber);
      const shown = await shownBoxOf(planned.memberEntries);
      if (pageBox !== undefined && shown !== null) {
        const isLeft = aslantLeftKeys.has(key);
        // The left half's rows are cut clear of the page's text set over one end of them (a column ending on the faded mist of a scene): the
        // right half takes the same rows.
        const rows = isLeft ? rowsClearOfText({ minX: Math.max(pageBox.minX, shown.minX), minY: shown.minY, maxX: pageBox.maxX, maxY: shown.maxY }, textBlockBoxesByPage.get(pageNumber) ?? []) : (aslantRowsOf.get(key) ?? { minY: shown.minY, maxY: shown.maxY });
        if (isLeft) aslantRowsOf.set(aslantRightKeyOf.get(key)!, rows);
        // The right half ends where the page's text begins in those rows (the column set beside the end of the picture).
        const firstWordX = (opts.wordBoxesByPage?.get(pageNumber) ?? []).filter((w) => w.minY < rows.maxY && w.maxY > rows.minY && w.minX < shown.maxX).reduce((min, w) => Math.min(min, w.minX), Infinity);
        const rightEnd = Math.min(pageBox.maxX, shown.maxX, firstWordX > pageBox.minX + ASLANT_HALF_MIN_WIDTH_PT ? firstWordX - 1 : Infinity);
        const bbox = isLeft ? { minX: Math.max(pageBox.minX, shown.minX), minY: rows.minY, maxX: pageBox.maxX, maxY: rows.maxY } : { minX: pageBox.minX, minY: rows.minY, maxX: rightEnd, maxY: rows.maxY };
        pageUnits.push({ ...planned, bbox, reason: ASLANT_HALF_REASON });
        continue;
      }
    }
    if (planned.reason === GRID_PICTURE_REASON) {
      pageUnits.push({ ...planned, bbox: clearOfCrossingText(planned.bbox, textBlockBoxesByPage.get(pageNumber) ?? []) });
      continue;
    }
    if (planned.reason !== SLICED_PICTURE_REASON && planned.reason !== CLIPPED_PIECES_REASON) {
      for (const u of await splitByVisiblePixels(planned)) pageUnits.push(await clearOfTextByInk(u));
      continue;
    }
    const shown = await shownBoxOf(planned.memberEntries);
    const pageBox = pageBoxByPage.get(pageNumber);
    const padded = shown === null ? null : { minX: shown.minX - SLICE_MARGIN_PT, minY: shown.minY - SLICE_MARGIN_PT, maxX: shown.maxX + SLICE_MARGIN_PT, maxY: shown.maxY + SLICE_MARGIN_PT };
    const box = padded === null ? planned.bbox : pageBox === undefined ? padded : (rectIntersection(padded, pageBox) ?? padded);
    pageUnits.push({ ...planned, bbox: box });
    if (padded !== null) slicedBoxes.push(box);
  }
  // A slice of the picture grouped apart from it (cut out along a line of the page's text, where its raster is blank) is part of it:
  // laid on the picture, it shows nothing outside the picture's box. Rendered, it would be the text and the edge of the picture.
  for (let i = pageUnits.length - 1; i >= 0 && slicedBoxes.length > 0; i--) {
    const u = pageUnits[i]!;
    if (u.reason === SLICED_PICTURE_REASON || u.reason === CLIPPED_PIECES_REASON || u.memberEntries.length === 0 || !u.memberEntries.every((m) => isShapedClip(m.occurrences.find((o) => o.page === pageNumber)?.clip))) continue;
    const onPicture = slicedBoxes.filter((box) => rectIntersection(box, u.bbox) !== null);
    if (onPicture.length === 0) continue;
    const shown = await shownBoxOf(u.memberEntries);
    if (shown === null || onPicture.some((box) => box.minX <= shown.minX && box.minY <= shown.minY && box.maxX >= shown.maxX && box.maxY >= shown.maxY)) pageUnits.splice(i, 1);
  }
  // What a unit is judged against: the sheets looked at once more at the page's edge (see `EDGE_DOCUMENT_REASON`) are hidden ones, not pictures painted over others.
  pageState.neighbourUnits = pageUnits.filter((u) => u.reason !== EDGE_DOCUMENT_REASON);
  // A unit split into its pictures is more units to extract: the total grows with them, so the progress never runs past it.
  tally.total += pageUnits.length - (unitsByPage.get(pageNumber)?.length ?? 0);
  const rightPieceOf = new Map<ExtractionUnit, ExtractionUnit>();
  for (const [leftUnit, rightUnit] of spreadRightOf) if (leftUnit.page === pageNumber && rightUnit.page === pageNumber) rightPieceOf.set(leftUnit, rightUnit);
  const rightPieces = new Set(rightPieceOf.values());
  const orderedUnits = pageUnits.flatMap((u) => (rightPieces.has(u) ? [] : rightPieceOf.has(u) ? [u, rightPieceOf.get(u)!] : [u]));
  const renderedBoxesByPage = new Map<number, { box: Rect; members: Rect[] }[]>();

  return { orderedUnits, renderedBoxesByPage };
}

/**
 * Stage 2 of a page — extracting the units in that order and recording each: the halves of a spread are joined
 * with their other half, pieces are composed, progress is reported, and a unit that fails is diagnosed without
 * stopping the page.
 */
async function extractUnitsOfPage(scope: PageScope, state: Awaited<ReturnType<typeof planUnitsOfPage>>): Promise<void> {
  const { signal, tally, isRightHalf, isLeftHalf, onProgress, maskHoldersByTarget, idOnThisPage, pageState, page, extractUnit, piecedOrigin, pageNumber, compositeOfPieces, uprightOfTurnedPieces, encoder, opts, imageByItem, ownImageByItem, classified, pageBoxByPage, tossedPropItems, prepared, rawRasterOf, diagnostics } = scope;
  const { orderedUnits, renderedBoxesByPage } = state;
  for (const plannedUnit of orderedUnits) {
    checkAborted(signal);
    // The right half of a picture across the spread whose left half waits is no stain to look at once more: it is joined to its left half.
    const edgeRightHalf = plannedUnit.reason === EDGE_FIGURE_REASON && ((tally.pendingLeftHalf !== null && isRightHalf(plannedUnit)) || isLeftHalf(plannedUnit));
    // A companion stands only for a half: without its other half waiting (or to come), it is the hidden picture it was.
    if (plannedUnit.reason === SPREAD_COMPANION_REASON && !(isLeftHalf(plannedUnit) || (tally.pendingLeftHalf !== null && isRightHalf(plannedUnit)))) {
      tally.done++;
      onProgress?.(tally.done, tally.total);
      continue;
    }
    if (plannedUnit.reason === EDGE_FIGURE_REASON && !edgeRightHalf) {
      const rep = plannedUnit.representativeEntry;
      const maskIds = rep?.objId ? (maskHoldersByTarget.get(rep.objId) ?? []).map(idOnThisPage).filter((id): id is string => id !== null) : [];
      if (maskIds.length > 0 && pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, maskIds, pageState.settleBudgetMs);
      const rectangularity = maskIds.length > 0 ? await probeMaskRectangularity(page, maskIds[0]!) : null;
      if (rectangularity === null || rectangularity >= SILHOUETTE_MAX_RECTANGULARITY) {
        tally.done++;
        onProgress?.(tally.done, tally.total);
        continue;
      }
    }
    // A tile of a picture's ground that a line drawing left (see `withLineDrawings`): a bare texture is no picture.
    if (plannedUnit.reason === LINE_DRAWING_REMAINDER_REASON && plannedUnit.representativeEntry !== null) {
      const remainderId = idOnThisPage(plannedUnit.representativeEntry);
      if (remainderId !== null && pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [remainderId], pageState.settleBudgetMs);
      const remainderLook = remainderId !== null ? await probeRawLook(page, remainderId) : null;
      if (remainderLook !== null && isBareDarkTexture(remainderLook)) {
        tally.done++;
        onProgress?.(tally.done, tally.total);
        continue;
      }
    }
    try {
      // The picture a unit stands for may turn out to be one that is hidden from the list as a background or
      // a prop (a faded vignette painted over the illustration it frames): then the next picture of
      // consequence in the unit gets its turn, instead of the whole unit vanishing.
      const candidates = [plannedUnit, ...alternativeRepresentatives(plannedUnit)];
      pageState.edgeFigureStdDev = undefined;
      let item = await extractUnit(piecedOrigin.get(plannedUnit) ?? candidates[0]!);
      const ownBoxes = plannedUnit.memberEntries.map((m) => m.occurrences.find((o) => o.page === pageNumber)?.bbox).filter((b): b is Rect => b !== undefined);
      const piecedOf = piecedOrigin.has(plannedUnit)
        ? await compositeOfPieces(plannedUnit)
        : plannedUnit.reason === CLIPPED_PIECES_REASON && ownBoxes.length > 0
          ? await compositeOfPieces({ ...plannedUnit, bbox: ownBoxes.reduce((acc, b) => unionRect(acc, b)) })
          : await uprightOfTurnedPieces(plannedUnit);
      if (piecedOf !== null) {
        item = { ...item, width: piecedOf.width, height: piecedOf.height, contentHash: await computeContentHash(piecedOf), suggestedGrid: detectGrid(piecedOf) ?? undefined, payload: await encoder.encode(piecedOf, { format: opts.outputFormat, quality: opts.outputQuality }) };
        imageByItem.set(item, piecedOf);
        ownImageByItem.set(item, piecedOf);
      }
      // A frame painted over a picture and transparent within (see `isEmptyWithin`): the picture it frames, taken for covered by it (or taken
      // into one unit with it, the frame standing for both), is offered in its stead.
      const framed = item.extractSource !== 'region-render' && (item.classification === 'content' || item.classification === 'undecided') && piecedOf === null ? imageByItem.get(item) : undefined;
      if (framed !== undefined && isEmptyWithin(framed)) {
        const within = classified.filter((c) => {
          // Taken for covered, or taken with the frame into one unit of which the frame stands for the whole.
          if (c.entry === item.entry || !(c.reason === COVERED_BY_LATER_REASON || (plannedUnit.memberEntries.includes(c.entry) && c.classification !== 'decoration' && c.classification !== 'mask'))) return false;
          const box = c.entry.occurrences.find((o) => o.page === pageNumber)?.bbox;
          const shared = box === undefined ? null : rectIntersection(box, plannedUnit.bbox);
          return box !== undefined && shared !== null && rectArea(box) > 0 && rectArea(shared) >= FRAME_AROUND_PICTURE_MIN_INSIDE_SHARE * rectArea(box);
        });
        const picture = within.sort((a, b) => b.entry.maxRelativeArea - a.entry.maxRelativeArea)[0];
        const pictureBox = picture?.entry.occurrences.find((o) => o.page === pageNumber)?.bbox;
        if (picture !== undefined && pictureBox !== undefined) {
          const inside = await extractUnit({ ...plannedUnit, representativeEntry: picture.entry, memberEntries: [picture.entry], bbox: pictureBox, clusterMemberCount: 1 });
          if (!isNeverWorthReviewing(inside)) item = inside;
        }
      }
      // A piece of a picture left out of that picture's unit (a strip of a drawing), lying within the render of a region offered before it on the
      // page and set edge to edge with one of the rasters of that render (see `areMosaicTiles`): the render shows it already, in its place in the picture.
      // A picture merely lying within a rendered region (a logo in a frame) is a picture of its own.
      const isOffered = (c: string): boolean => c === 'content' || c === 'undecided';
      if (item.extractSource !== 'region-render' && isOffered(item.classification) && item.holdsText !== true && plannedUnit.memberEntries.length === 1) {
        const box = plannedUnit.bbox;
        const shown = (renderedBoxesByPage.get(pageNumber) ?? []).some((r) => {
          const shared = rectIntersection(box, r.box);
          return shared !== null && rectArea(box) > 0 && rectArea(shared) >= RENDERED_PIECE_MIN_INSIDE_SHARE * rectArea(box) && r.members.some((m) => areMosaicTiles(box, m));
        });
        if (shown) item = { ...item, classification: 'decoration' };
      }
      if (item.extractSource === 'region-render' && isOffered(item.classification) && item.holdsText !== true) renderedBoxesByPage.set(pageNumber, [...(renderedBoxesByPage.get(pageNumber) ?? []), { box: plannedUnit.bbox, members: plannedUnit.memberEntries.map((m) => m.occurrences.find((o) => o.page === pageNumber)?.bbox).filter((b): b is Rect => b !== undefined) }]);
      if (plannedUnit.reason === EDGE_FIGURE_REASON && !edgeRightHalf && (item.extractSource === 'region-render' || (pageState.edgeFigureStdDev ?? 0) < EDGE_FIGURE_MIN_STDDEV)) {
        tally.done++;
        onProgress?.(tally.done, tally.total);
        continue;
      }
      // Judged by its own pixels: a render of its region would show the page's text around it. Kept when it is a document, or a print (a
      // photograph, a postcard) that is not plain paper and that nothing found to hide.
      const edgePrint =
        item.classification !== 'decoration' &&
        (pageState.edgeFigureStdDev ?? 0) >= EDGE_FIGURE_MIN_STDDEV &&
        plannedUnit.representativeEntry !== null &&
        maxBleedOverhangPt(plannedUnit.representativeEntry, pageBoxByPage) <= EDGE_PRINT_MAX_OVERHANG_PT;
      if (plannedUnit.reason === EDGE_DOCUMENT_REASON && (item.extractSource === 'region-render' || !(item.holdsText || edgePrint))) {
        tally.done++;
        onProgress?.(tally.done, tally.total);
        continue;
      }
      for (let i = 1; i < candidates.length && isNeverWorthReviewing(item) && !tossedPropItems.has(item); i++) {
        const alternative = await extractUnit(candidates[i]!);
        if (!isNeverWorthReviewing(alternative)) item = alternative;
      }
      const isPanelHalf = plannedUnit.reason === LARGE_TRANSLUCENT_PANEL_REASON;
      // A panel half is joined when a drawing was found on it. Any other half is joined when it is the left one and is offered; the right
      // half may be a picture that is not offered by itself (a trailing wisp of the drawing, mostly transparent): it still belongs to the left one.
      const halfImage = isPanelHalf ? pageState.lastPanelImage : (imageByItem.get(item) ?? null);
      // A left half that is the figure at the page's edge waits for its offered right half all the same (see `EDGE_FIGURE_REASON`).
      // A left half waits for its right half whether or not it is offered by itself (a strip at the gutter hidden as an ornament): joined, the
      // picture is offered as its right half is; not joined, it is listed as it was.
      const offered = isPanelHalf || !isNeverWorthReviewing(item) || isLeftHalf(plannedUnit);
      // The left half of a picture across a spread waits through the rest of its page for the right half on the next one.
      if (tally.pendingLeftHalf !== null && plannedUnit.page > tally.pendingLeftHalf.page + 1) {
        if (!tally.pendingLeftHalf.companion) prepared.push(tally.pendingLeftHalf.item);
        tally.pendingLeftHalf = null;
      }
      if (halfImage !== null && offered && isLeftHalf(plannedUnit)) {
        if (tally.pendingLeftHalf !== null && !tally.pendingLeftHalf.companion) prepared.push(tally.pendingLeftHalf.item);
        tally.pendingLeftHalf = { item, image: halfImage, page: plannedUnit.page, isPanel: isPanelHalf, box: plannedUnit.bbox, companion: plannedUnit.reason === SPREAD_COMPANION_REASON, raw: isPanelHalf ? null : await rawRasterOf(plannedUnit) };
      } else if (tally.pendingLeftHalf !== null && isRightHalf(plannedUnit)) {
        // Two halves cut with a margin overlap on the page: the right one shows again the columns the left one ends with.
        const overlapPt = tally.pendingLeftHalf.page === plannedUnit.page ? tally.pendingLeftHalf.box.maxX - plannedUnit.bbox.minX : 0;
        // A right half that the page writes over (the labels and a paragraph laid on a map) is joined by its own pixels, when they go on from
        // a left half that is a picture; a left half that is a box of text (a page of documents beside a picture) is a page of its own.
        const ownRight = plannedUnit.reason === SPREAD_COMPANION_REASON && plannedUnit.memberEntries.length > 1 ? await compositeOfPieces(plannedUnit) : item.holdsText === true && !isPanelHalf ? (ownImageByItem.get(item) ?? null) : halfImage;
        const rightHalf = ownRight !== null && overlapPt > 0 && plannedUnit.bbox.maxX > plannedUnit.bbox.minX ? dropLeftColumns(ownRight, (overlapPt * ownRight.width) / (plannedUnit.bbox.maxX - plannedUnit.bbox.minX)) : ownRight;
        const eitherHoldsText = tally.pendingLeftHalf.item.holdsText === true;
        // Two rasters of one height in pixels, placed at one height on the facing pages, were cut from one raster: where the drawing is thin
        // line art with next to nothing at the gutter, a blank seam joins them as it does two pieces on one page.
        const leftEntry = tally.pendingLeftHalf.item.entry;
        const rightEntry = plannedUnit.representativeEntry;
        // Only when one of them is a strip at the gutter: two pictures of their own on facing pages, each with a white margin at the gutter, may be
        // of one size too.
        const stripAtGutter = (box: Rect, page: number): boolean => {
          const pageBox = pageBoxByPage.get(page);
          return pageBox !== undefined && box.maxX - box.minX <= SPREAD_STRIP_MAX_WIDTH_SHARE * (pageBox.maxX - pageBox.minX);
        };
        const cutFromOne =
          (stripAtGutter(tally.pendingLeftHalf.box, tally.pendingLeftHalf.page) || stripAtGutter(plannedUnit.bbox, plannedUnit.page)) &&
          rightEntry !== null &&
          leftEntry.intrinsicHeight !== null &&
          leftEntry.intrinsicHeight === rightEntry.intrinsicHeight &&
          Math.abs(tally.pendingLeftHalf.box.minY - plannedUnit.bbox.minY) <= 1 &&
          Math.abs(tally.pendingLeftHalf.box.maxY - plannedUnit.bbox.maxY) <= 1;
        // Cut from one raster, the two are joined from their whole rasters: what was offered of each may be cropped to its visible part.
        const rightRaw = cutFromOne && tally.pendingLeftHalf.raw ? await rawRasterOf(plannedUnit) : null;
        const [joinLeft, joinRight] = rightRaw && tally.pendingLeftHalf.raw && rightRaw.height === tally.pendingLeftHalf.raw.height ? [tally.pendingLeftHalf.raw, rightRaw] : [tally.pendingLeftHalf.image, rightHalf];
        // A transparent half (the empty margin of a masked picture beside a picture of the facing one) adds nothing to the picture: it is not joined.
        const drawn = (image: DecodedImage): boolean => visibleShareOf(image) >= SPREAD_HALF_MIN_VISIBLE_SHARE;
        if (joinRight !== null && !eitherHoldsText && tally.pendingLeftHalf.isPanel === isPanelHalf && (isPanelHalf || (drawn(joinLeft) && drawn(joinRight) && halvesContinueAcrossSeam(joinLeft, joinRight, { blankSeamJoins: tally.pendingLeftHalf.page === plannedUnit.page || cutFromOne })))) {
          const joined = stitchHorizontally(joinLeft, joinRight);
          const joinedPayload = await encoder.encode(joined, { format: opts.outputFormat, quality: opts.outputQuality });
          // The picture is offered as the half that was: a left half that was hidden (a strip at the gutter, a stain at the page's edge) takes
          // the judgement of its right half.
          // The look of the picture (the measures that hide a narrow strip or a blank sheet) is the larger half's, not a strip's at the gutter.
          const isOffered = (c: string): boolean => c === 'content' || c === 'undecided';
          const larger = joinLeft.width * joinLeft.height >= joinRight.width * joinRight.height ? tally.pendingLeftHalf.item : item;
          const judged = !isOffered(tally.pendingLeftHalf.item.classification) && isOffered(item.classification) && !isNeverWorthReviewing(item) ? { classification: item.classification, confidence: item.confidence } : { classification: tally.pendingLeftHalf.item.classification, confidence: tally.pendingLeftHalf.item.confidence };
          prepared.push({ ...larger, entry: tally.pendingLeftHalf.item.entry, extractSource: tally.pendingLeftHalf.item.extractSource, ...judged, width: joined.width, height: joined.height, contentHash: await computeContentHash(joined), suggestedGrid: detectGrid(joined) ?? undefined, payload: joinedPayload });
          // The right half as the page shows it, with its text, stays among the images with text.
          if (item.holdsText === true) prepared.push(item);
        } else {
          // A companion that did not go on into its other half stays the hidden picture it was: not listed.
          if (!tally.pendingLeftHalf.companion) prepared.push(tally.pendingLeftHalf.item);
          if (plannedUnit.reason !== SPREAD_COMPANION_REASON) prepared.push(item);
        }
        tally.pendingLeftHalf = null;
      } else if (plannedUnit.reason !== SPREAD_COMPANION_REASON) {
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
    tally.done++;
    onProgress?.(tally.done, tally.total);
  }
}

/**
 * Processes the units of one page that is already open (its operator list fetched, its resources waited for): the
 * two stages above. This was the second half of the per-page loop of `buildImageExtraction.ts`; the statements are
 * unchanged.
 */
export async function processPageUnits(scope: PageScope): Promise<void> {
  const s0 = await planUnitsOfPage(scope);
  return extractUnitsOfPage(scope, s0);
}
