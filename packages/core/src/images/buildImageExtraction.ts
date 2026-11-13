import { rectArea, rectIntersection, unionRect, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { ImageClassification } from './classify.js';
import type { EncodedImage, ImageEncoder } from './encodeImage.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { findBookOrnaments, type InkStyle } from './bookOrnaments.js';
import { connectedGroups, placedInksOverlap, type PlacedMask } from './opaqueOverlap.js';
import { flattenOnWhite } from './whiteBackground.js';
import { extractUnitOfPage, type UnitScope } from './extractUnit.js';
import { planExtraction } from './planExtraction.js';
import { processPageUnits, type PageScope } from './extractPage.js';
import { clearProbeCache, currentObjIdAt, extractDirect, probeInkMask, waitForDependencies, waitForObjects } from './extract.js';
import { finalizeImages, type PreparedEntryForFinalize } from './finalize.js';
import type { RegionRenderer } from './regionRenderer.js';
import type { BuildImageExtractionOptions, BuildImageExtractionResult, ExtractionUnit, InventoryForImages, PdfDocumentLikeForImages, PageState, RunTally } from './extractionTypes.js';
import { FIGURE_MAX_IMAGE_COVER, checkAborted } from './extractionUnits.js';
import { DEPENDENCY_TIMEOUT_MS } from './extractionLooks.js';
import { BOOK_OF_PROPS_MIN_COUNT, composeOverBox, turnedPiecesFrame } from './extractionJoins.js';
import { type TileSource, areSeamedTiles } from './extractionPieces.js';

/**
 * Image-extraction orchestration: classification -> strategy -> extraction (region render when
 * needed) -> finalization, with memory and determinism discipline. Mirrors the pattern of
 * `buildPageLayout.ts`: a single entry point tying all the stages together into one pass per
 * document.
 */
// The rules this orchestration applies live in `extraction*.ts` beside this file (types, looks, pieces, joins, units).
// The stages live beside it too: `planExtraction.ts` (before the first page), `extractPage.ts` (the units of one page)
// and `extractUnit.ts` (one unit, in five phases).
// What tests and other modules imported from here is still exported from here.
export type { InventoryForImages, PdfDocumentLikeForImages, BuildImageExtractionOptions, BuildImageExtractionResult, ExtractionUnit } from './extractionTypes.js';
export { isPhotoUnderNotes, isHeadingBannerText, isWrittenPaper, isDocumentPaper, isFlushCardOfText, isTextPanel, isSmallCardOfText, isSmallPieceBesideRepresentative, isLongStrip, isBackdropOfTextBesideRepresentative, looksLikePlainTextCard, isBackdropOfCardsAbove, isCoverText, textCoverage, isTextOverPicture, textCrossingShare, maskLetsMostThrough, rawResourceFitsPlacement } from './extractionLooks.js';
export { extendToEdgeOrnaments, shownBoxOfSlices, areSeamedTiles, areMosaicTiles, seamDifference, clearOfCrossingText, isPanelBehindFigure } from './extractionPieces.js';
export type { TileSource } from './extractionPieces.js';
export { joinMosaicTiles, turnedPiecesFrame, composeOverBox, isFlatFill, isEmptyWithin, isFrameOfTextBox, paperGroundShare, offPageShare, blankGroundShare, withLineDrawings, splitUnitsOfDistinctPictures } from './extractionJoins.js';
export { isPaperOverlay, alternativeRepresentatives, compositionMembers, withSolidRepresentativeOfBackdrop, topOccurrenceOnPage, pickUnitRepresentative, firstPlaceOfPicture, VECTOR_FIGURE_REASON, findVectorFigureUnits } from './extractionUnits.js';


export async function buildImageExtraction(
  doc: PdfDocumentLikeForImages,
  inventory: InventoryForImages,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: BuildImageExtractionOptions = {},
): Promise<BuildImageExtractionResult> {
  // The white background goes on at the one place every image passes on its way out: the encoder.
  const outputEncoder: ImageEncoder = opts.whiteBackground === true ? { encode: (image, encodeOpts) => encoder.encode(flattenOnWhite(image), encodeOpts) } : encoder;
  try {
    return await extractImages(doc, inventory, renderer, outputEncoder, opts);
  } finally {
    // The probes keep the pixels of the last few resources they looked at; nothing of that outlives the extraction.
    clearProbeCache();
  }
}

async function extractImages(
  doc: PdfDocumentLikeForImages,
  inventory: InventoryForImages,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: BuildImageExtractionOptions,
): Promise<BuildImageExtractionResult> {
  const { signal, onProgress } = opts;
  checkAborted(signal); // must be checked NOW, not only inside the per-page loop — a document with no units to process (the loop never runs) would otherwise silently ignore an already-aborted signal.
  // Everything decided before the first page is opened: what is worth taking, in which units, and which units are
  // halves of one picture across a spread (see `planExtraction.ts`).
  const {
    autoCropUniformMargins,
    hideBackgroundImages,
    brightenAutoCroppedImages,
    targetLongEdgePx,
    maxLongEdgePx,
    nearStatblockOrHeadingObjIds,
    diagnostics,
    pageBoxByPage,
    pageRotationByPage,
    headingBlockBoxesByPage,
    textBlockBoxesByPage,
    classified,
    maskedObjIds,
    maskHoldersByTarget,
    objectSettleTimeoutMs,
    classifiedByEntry,
    piecedOrigin,
    allUnits,
    unitsByPage,
    prepared,
    photoCuts,
    formPages,
    possibleSheetParts,
    figureEntries,
    spreadRightOf,
    spreadRightHalves,
    halfKey,
    aslantRightKeyOf,
    aslantLeftKeys,
    aslantRightKeys,
    aslantRowsOf,
    isLeftHalf,
    isRightHalf,
  } = planExtraction(inventory, opts);
  // What changes as the pages go by, in one object so that the stages working on a page (in other files) share it.
  const tally: RunTally = { pendingLeftHalf: null, tossedPropCount: 0, done: 0, total: allUnits.length };
  // The look of the ink of every item of the book that nobody could judge, measured while its image is at hand: for the book's ornaments (see `bookOrnaments.ts`).
  const inkStyleByItem = new WeakMap<object, { style: InkStyle | null; width: number; height: number }>();
  // The items hidden as props tossed over the page's edge (see `tossedProp`): the unit is the prop, no other picture of it takes its turn, and
  // the props count among the ornaments of the book (a red die beside a red circle drawn round a word).
  const tossedPropItems = new WeakSet<object>();
  // Small cut-out objects on a blank ground that lie on the page (a die in a corner, a coin, a bullet hole at the edge): in a book strewn with
  // props tossed over the page's edge (see `BOOK_OF_PROPS_MIN_COUNT`, counted in `tally.tossedPropCount`) they are props as well.
  const smallCutOutItems: object[] = [];

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
      // Every resource the page needs, before anything reads one: what is registered must not depend on timing (see `waitForDependencies`).
      const dependenciesArrived = await waitForDependencies(page, operatorList, DEPENDENCY_TIMEOUT_MS);
      checkAborted(signal);
      // Time left on this page for waiting on resources that are not registered yet (see `objectSettleTimeoutMs`). Once every dependency has
      // arrived, a resource still missing is not one this page paints (an id taken from the inventory), and waiting for it would only lose time.
      const pageState: PageState = { settleBudgetMs: dependenciesArrived ? 0 : objectSettleTimeoutMs, edgeFigureStdDev: undefined, lastPanelImage: null, neighbourUnits: [] };
      // The units of this page once those that hold several pictures are split (filled by the planning stage).
      const pageUnits: ExtractionUnit[] = [];
      // The id this document gave the resource that `entry` paints on this page (see `currentObjIdAt`).
      const idOnThisPage = (entry: ImageEntry): string | null => currentObjIdAt(operatorList, entry.occurrences.find((o) => o.page === pageNumber)?.index, entry.objId);
      // The whole raster of a unit's picture, as the PDF stores it (upright, not mirrored): for joining the halves of a picture cut from one raster.
      const rawRasterOf = async (u: ExtractionUnit): Promise<DecodedImage | null> => {
        const rep = u.representativeEntry;
        const id = rep === null ? null : idOnThisPage(rep);
        if (rep === null || id === null || rep.occurrences.find((o) => o.page === pageNumber)?.placement !== undefined) return null;
        const raw = await extractDirect(page, id, u.bbox, renderer, { targetLongEdgePx, signal }, pageNumber);
        return raw.source === 'region-render' ? null : raw.image;
      };
      // A companion stored as pieces (see `SPREAD_COMPANION_REASON`): their own rasters laid over one another in the joined box, in the order the
      // page paints them, without the page's text that a render of the box would show.
      // A picture laid aslant as pieces turned alike (see `turnedPiecesFrame`): its pieces' own pixels laid side by side, upright.
      const uprightOfTurnedPieces = async (u: ExtractionUnit): Promise<DecodedImage | null> => {
        if (!hideBackgroundImages || u.memberEntries.length < 2) return null;
        const placed = u.memberEntries.map((m) => ({ entry: m, occ: m.occurrences.find((o) => o.page === pageNumber) }));
        if (!placed.every((p) => p.occ !== undefined && p.occ.placement?.rotated === true && p.occ.clip === undefined && p.occ.ctm !== undefined && p.entry.intrinsicWidth !== null && p.entry.intrinsicHeight !== null)) return null;
        const ordered = [...placed].sort((x, y) => y.entry.maxRelativeArea - x.entry.maxRelativeArea);
        const frame = turnedPiecesFrame(ordered.map((p) => ({ ctm: p.occ!.ctm!, width: p.entry.intrinsicWidth!, height: p.entry.intrinsicHeight! })));
        if (frame === null) return null;
        const pieces: { image: DecodedImage; box: Rect; index: number }[] = [];
        for (let i = 0; i < ordered.length; i++) {
          const id = idOnThisPage(ordered[i]!.entry);
          if (id === null) return null;
          const raw = await extractDirect(page, id, ordered[i]!.occ!.bbox, renderer, { targetLongEdgePx, signal }, pageNumber);
          if (raw.source === 'region-render') return null;
          pieces.push({ image: raw.image, box: frame[i]!, index: ordered[i]!.occ!.index });
        }
        return composeOverBox(pieces, frame.slice(1).reduce((r, b) => unionRect(r, b), frame[0]!));
      };
      const compositeOfPieces = async (u: ExtractionUnit): Promise<DecodedImage | null> => {
        const pieces: { image: DecodedImage; box: Rect; index: number }[] = [];
        for (const entry of u.memberEntries) {
          const occ = entry.occurrences.find((o) => o.page === pageNumber);
          const id = idOnThisPage(entry);
          if (occ === undefined || id === null || occ.placement !== undefined) return null;
          const raw = await extractDirect(page, id, occ.bbox, renderer, { targetLongEdgePx, signal }, pageNumber);
          if (raw.source === 'region-render') return null;
          pieces.push({ image: raw.image, box: occ.bbox, index: occ.index });
        }
        return composeOverBox(pieces, u.bbox);
      };
      // The decoded image each extracted unit was encoded from: the halves of a picture across a spread are joined from it.
      const imageByItem = new WeakMap<object, DecodedImage>();
      // The image of an item before it became the render of a card of text (the picture's own pixels): a half of a picture across a spread that the
      // page writes over is joined by its own pixels.
      const ownImageByItem = new WeakMap<object, DecodedImage>();
      // One unit, from the planning of how to take it to the encoded result.
      // The extraction of one unit lives in `extractUnit.ts`, in five phases. It reads this page's state through
      // `unitScope`; the accessor pairs keep the variables it updates (shared by the units of the page) in one place, here.
      const unitScope: UnitScope = {
        textBlockBoxesByPage,
        pageNumber,
        hideBackgroundImages,
        maskedObjIds,
        idOnThisPage,
        get settleBudgetMs() {
          return pageState.settleBudgetMs;
        },
        set settleBudgetMs(value) {
          pageState.settleBudgetMs = value;
        },
        page,
        classifiedByEntry,
        maskHoldersByTarget,
        targetLongEdgePx,
        maxLongEdgePx,
        classified,
        pageBoxByPage,
        pageUnits,
        // Known once the page's units are planned: read when a unit asks, not now.
        get neighbourUnits() {
          return pageState.neighbourUnits;
        },
        renderer,
        signal,
        diagnostics,
        opts,
        pageRotationByPage,
        autoCropUniformMargins,
        brightenAutoCroppedImages,
        get edgeFigureStdDev() {
          return pageState.edgeFigureStdDev;
        },
        set edgeFigureStdDev(value) {
          pageState.edgeFigureStdDev = value;
        },
        encoder,
        get lastPanelImage() {
          return pageState.lastPanelImage;
        },
        set lastPanelImage(value) {
          pageState.lastPanelImage = value;
        },
        figureEntries,
        isLeftHalf,
        isRightHalf,
        headingBlockBoxesByPage,
        inventory,
        imageByItem,
        ownImageByItem,
        tossedPropItems,
        get tossedPropCount() {
          return tally.tossedPropCount;
        },
        set tossedPropCount(value) {
          tally.tossedPropCount = value;
        },
        smallCutOutItems,
        inkStyleByItem,
        formPages,
        possibleSheetParts,
        photoCuts,
      };
      const extractUnit = (plannedUnit: ExtractionUnit): Promise<PreparedEntryForFinalize<EncodedImage>> => extractUnitOfPage(unitScope, plannedUnit);

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
          if (pageState.settleBudgetMs > 0) pageState.settleBudgetMs -= await waitForObjects(page, [memberId], pageState.settleBudgetMs);
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
      // The units of the page are planned and extracted in `extractPage.ts`, which reads everything through `pageScope`.
      const pageScope: PageScope = {
        spreadRightOf,
        spreadRightHalves,
        splitBlendedByInk,
        idOnThisPage,
        pageNumber,
        pageState,
        page,
        textBlockBoxesByPage,
        maskedObjIds,
        unitOfMembers,
        opts,
        unitsByPage,
        halfKey,
        aslantLeftKeys,
        renderer,
        targetLongEdgePx,
        signal,
        aslantRightKeys,
        aslantRightKeyOf,
        pageBoxByPage,
        aslantRowsOf,
        pageUnits,
        tally,
        isRightHalf,
        isLeftHalf,
        onProgress,
        maskHoldersByTarget,
        extractUnit,
        piecedOrigin,
        compositeOfPieces,
        uprightOfTurnedPieces,
        encoder,
        imageByItem,
        ownImageByItem,
        classified,
        tossedPropItems,
        prepared,
        rawRasterOf,
        diagnostics,
      };
      await processPageUnits(pageScope);
    } finally {
      page.cleanup();
    }
  }

  if (tally.pendingLeftHalf !== null && !tally.pendingLeftHalf.companion) prepared.push(tally.pendingLeftHalf.item);
  // The ornaments of the book's design (drop caps, flourishes and seals in its one colour of ink, the strips of its frames): small pictures nobody
  // could judge, dozens of them in one style; hidden with the book's other decoration (see `bookOrnaments.ts`).
  if (hideBackgroundImages) {
    const bookOfProps = tally.tossedPropCount >= BOOK_OF_PROPS_MIN_COUNT;
    if (bookOfProps) {
      for (const item of smallCutOutItems) {
        (item as { classification: string }).classification = 'decoration';
        tossedPropItems.add(item);
      }
    }
    // In a book strewn with props, they count among its ornaments of one colour; elsewhere a few props would make a group of drawings in one ink.
    const judged = prepared.filter((item) => ((item.classification === 'undecided' && item.holdsText !== true) || (bookOfProps && tossedPropItems.has(item))) && inkStyleByItem.has(item));
    const styles = judged.map((item) => inkStyleByItem.get(item)!);
    for (const i of findBookOrnaments(styles)) judged[i]!.classification = 'decoration';
  }
  // The other part of a sheet whose first part was recognised (its second page, drawn in a handwriting): text in a picture as well.
  for (const part of possibleSheetParts) {
    if (!formPages.has(part.page)) continue;
    part.item.classification = 'decoration';
    part.item.holdsText = true;
  }
  prepared.push(...photoCuts);
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
