import { rectIntersection, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { classifyImages, confidenceForReason, LARGE_TRANSLUCENT_PANEL_REASON, EXTREME_ASPECT_RATIO_DECORATION_THRESHOLD, isTranslucentEverywhere, maxBleedOverhangPt } from './classify.js';
import type { EncodedImage } from './encodeImage.js';
import { findSpreadPairs } from './spreadPairs.js';
import { clipPathBBox } from '../inventory/clipPaths.js';
import type { PreparedEntryForFinalize } from './finalize.js';
import { computeMaskedObjIds } from './strategy.js';
import type { BuildImageExtractionOptions, ExtractionUnit, InventoryForImages } from './extractionTypes.js';
import { findCardUnits, findVectorFigureUnits, findVectorOnlyUnits, groupIntoUnits } from './extractionUnits.js';
import { DEFAULT_MAX_LONG_EDGE_PX, DEFAULT_OBJECT_SETTLE_TIMEOUT_MS, DEFAULT_TARGET_LONG_EDGE_PX, EDGE_DOCUMENT_REASON, EDGE_FIGURE_MAX_OVERHANG_PT, EDGE_FIGURE_REASON, SPREAD_HALF_MIN_AREA } from './extractionLooks.js';
import { ASLANT_HALF_MIN_PAST_EDGE_PT, ASLANT_HALF_MIN_SHARED_HEIGHT, FORM_PAGE_ELEMENT_REASON, PIECED_PICTURE_REASON, PIECE_MIN_HEIGHT_OVERLAP, PIECE_MIN_WIDTH_GAIN, SPREAD_COMPANION_MIN_AREA, SPREAD_COMPANION_REASON, TINY_UNDECIDED_REASON, joinMosaicTiles, splitUnitsOfDistinctPictures, withLineDrawings } from './extractionJoins.js';

/**
 * The plan of an image extraction: everything decided from the inventory alone, before the first page is opened.
 * Images are classified and grouped into units (one picture to take from one page), units made of vector drawings and
 * figures at the page's edge are added, and the units that are the two halves of one picture across a spread are
 * paired. Moved out of `buildImageExtraction.ts` unchanged; the collections it returns empty (`prepared`, `photoCuts`,
 * `formPages`, ...) are filled as the pages are processed.
 */
export function planExtraction(inventory: InventoryForImages, opts: BuildImageExtractionOptions) {
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
    ...(opts.wordBoxesByPage !== undefined ? { wordBoxesByPage: opts.wordBoxesByPage } : {}),
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
  const imageUnits = withLineDrawings(joinMosaicTiles(splitUnitsOfDistinctPictures(groupIntoUnits(candidates, pageBoxByPage, maskedObjIds, diagnostics), classifiedByEntry, maskedObjIds, textBlockBoxesByPage), classified.filter((c) => c.classification === 'content' || c.classification === 'undecided' || c.reason === FORM_PAGE_ELEMENT_REASON || c.reason === TINY_UNDECIDED_REASON), pageBoxByPage, textBlockBoxesByPage), inventory.lines ?? [], pageBoxByPage, opts.wordBoxesByPage);

  const pagesWithAnyImage = new Set<number>();
  for (const entry of inventory.images) for (const occ of entry.occurrences) pagesWithAnyImage.add(occ.page);
  const vectorOnlyUnits = [...findVectorOnlyUnits(inventory.vectors, pagesWithAnyImage), ...findCardUnits(inventory.lines ?? [], inventory.images, pageBoxByPage, opts.wordBoxesByPage), ...(opts.includeVectorFigures === true ? findVectorFigureUnits(inventory.shapes ?? [], candidates.map((c) => c.entry).filter((e) => !isTranslucentEverywhere(e)), pageBoxByPage, textBlockBoxesByPage, opts.wordBoxesByPage) : [])];

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
  // A picture stored in pieces side by side (see `PIECED_PICTURE_REASON`): an offered masked raster with the hidden masked cut-outs that overlap it
  // at its side, over most of its height.
  const piecedOrigin = new Map<ExtractionUnit, ExtractionUnit>();
  {
    const inImageUnits = new Set(imageUnits.flatMap((u) => [u.representativeEntry, ...u.memberEntries]));
    const occOnPage = (e: ImageEntry, page: number) => e.occurrences.find((o) => o.page === page);
    for (let i = 0; i < imageUnits.length; i++) {
      const u = imageUnits[i]!;
      const rep = u.representativeEntry;
      if ((u.classification !== 'content' && u.classification !== 'undecided') || u.memberEntries.length !== 1 || rep === null || rep.objId === null || !maskedObjIds.has(rep.objId)) continue;
      const repOcc = occOnPage(rep, u.page);
      if (repOcc === undefined || repOcc.placement !== undefined) continue;
      const box = repOcc.bbox;
      const pieces = classified
        .filter((c) => c.reason === 'Z12-bleeding-masked-cutout' && c.entry !== rep && !inImageUnits.has(c.entry) && c.entry.objId !== null && maskedObjIds.has(c.entry.objId) && c.entry.occurrences.length === 1 && c.entry.occurrences[0]!.page === u.page && c.entry.occurrences[0]!.placement === undefined && c.entry.maxRelativeArea >= SPREAD_COMPANION_MIN_AREA)
        .map((c) => c.entry)
        .filter((e) => {
          const b = e.occurrences[0]!.bbox;
          const across = Math.min(b.maxX, box.maxX) - Math.max(b.minX, box.minX);
          const down = Math.min(b.maxY, box.maxY) - Math.max(b.minY, box.minY);
          const gain = Math.max(0, box.minX - b.minX) + Math.max(0, b.maxX - box.maxX);
          return across > 0 && down >= PIECE_MIN_HEIGHT_OVERLAP * Math.min(b.maxY - b.minY, box.maxY - box.minY) && gain >= PIECE_MIN_WIDTH_GAIN * (box.maxX - box.minX);
        });
      if (pieces.length === 0) continue;
      const bbox = [box, ...pieces.map((e) => e.occurrences[0]!.bbox)].reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
      const pieced: ExtractionUnit = { ...u, memberEntries: [rep, ...pieces], bbox, clusterMemberCount: 1 + pieces.length, reason: PIECED_PICTURE_REASON };
      piecedOrigin.set(pieced, { ...u, bbox: box });
      imageUnits[i] = pieced;
      for (const e of pieces) {
        inImageUnits.add(e);
        const k = edgeFigureUnits.findIndex((f) => f.representativeEntry === e);
        if (k >= 0) edgeFigureUnits.splice(k, 1);
      }
    }
  }
  // A sheet of the page's design cut out by a mask and running off the page (a printed poem lying at the foot of the page) is hidden with the
  // scraps and stains; it is looked at once more, and kept when its pixels are a document (see `EDGE_DOCUMENT_REASON`).
  const inImageUnits = new Set(imageUnits.flatMap((u) => [u.representativeEntry, ...u.memberEntries]));
  const edgeDocumentUnits: ExtractionUnit[] = classified
    .filter(
      (c) =>
        c.reason === 'Z12-bleeding-masked-cutout' &&
        !inImageUnits.has(c.entry) &&
        c.entry.objId !== null &&
        maskedObjIds.has(c.entry.objId) &&
        c.entry.occurrences.length > 0 &&
        maxBleedOverhangPt(c.entry, pageBoxByPage) > EDGE_FIGURE_MAX_OVERHANG_PT,
    )
    .map((c) => ({
      representativeEntry: c.entry,
      memberEntries: [c.entry],
      page: c.entry.occurrences[0]!.page,
      bbox: c.entry.occurrences[0]!.bbox,
      clusterMemberCount: 1,
      classification: 'undecided' as const,
      confidence: confidenceForReason(EDGE_DOCUMENT_REASON),
      reason: EDGE_DOCUMENT_REASON,
    }));
  const allUnits = [...imageUnits, ...edgeFigureUnits, ...edgeDocumentUnits, ...vectorOnlyUnits].sort((a, b) => {
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
  /** Photographs cut out of rasters of documents (see `photoInDocument.ts`): offered by themselves beside the documents. */
  const photoCuts: PreparedEntryForFinalize<EncodedImage>[] = [];
  // Pages with a form read from pixels, and the rasters that are ruled like one but have too little print to be taken for it alone.
  const formPages = new Set<number>();
  const possibleSheetParts: { item: PreparedEntryForFinalize<EncodedImage>; page: number }[] = [];
  // The placeholder entries of the vector drawings found: they are dropped again when what the page shows there is a picture that is offered anyway.
  const figureEntries = new Set<ImageEntry>();
  // The halves of a picture that runs across a spread: a map (each half a big translucent panel with a drawing on it) or an illustration
  // (each half a picture of its own that reaches the gutter). The latter are joined only when their pixels go on across the seam.
  // The pictures looked at once more at the page's edge (see `EDGE_FIGURE_REASON`) are second units for hidden pictures, not halves: a half paired with one would lose its pair when it is dropped.
  const halfCandidates = allUnits.filter(
    (u) =>
      u.reason !== EDGE_FIGURE_REASON &&
      u.reason !== EDGE_DOCUMENT_REASON &&
      (u.reason === LARGE_TRANSLUCENT_PANEL_REASON || ((u.classification === 'content' || u.classification === 'undecided') && u.representativeEntry !== null && u.representativeEntry.maxRelativeArea >= SPREAD_HALF_MIN_AREA)),
  );
  const spreadRightOf = findSpreadPairs(halfCandidates, pageBoxByPage, (u) => (u.memberEntries.length === 1 && u.representativeEntry?.intrinsicWidth != null && u.representativeEntry.intrinsicHeight != null ? { width: u.representativeEntry.intrinsicWidth, height: u.representativeEntry.intrinsicHeight } : undefined));
  const spreadRightHalves = new Set(spreadRightOf.values());
  // A half that the grouping joined to a picture beside it (a strip of a map with a portrait next to it, split apart again by their pixels
  // later) is paired by the box of its own raster, and found again after the split by that raster.
  const halfKey = (u: ExtractionUnit): string | null => (u.representativeEntry?.objId == null ? null : `${u.page}:${u.representativeEntry.objId}`);
  const pairedUnits = new Set<ExtractionUnit>([...spreadRightOf.keys(), ...spreadRightHalves]);
  const ownBoxHalves = halfCandidates
    .filter((u) => !pairedUnits.has(u) && u.memberEntries.length >= 2 && halfKey(u) !== null)
    .map((u) => ({ page: u.page, bbox: u.representativeEntry!.occurrences.find((o) => o.page === u.page)?.bbox ?? u.bbox, unit: u }));
  const singleHalves = halfCandidates.filter((u) => !pairedUnits.has(u) && u.memberEntries.length === 1 && halfKey(u) !== null).map((u) => ({ page: u.page, bbox: u.bbox, unit: u }));
  const leftHalfKeys = new Set<string>();
  const rightHalfKeys = new Set<string>();
  if (ownBoxHalves.length > 0) {
    for (const [left, right] of findSpreadPairs([...ownBoxHalves, ...singleHalves], pageBoxByPage)) {
      if (left.unit.memberEntries.length === 1 && right.unit.memberEntries.length === 1) continue;
      leftHalfKeys.add(halfKey(left.unit)!);
      rightHalfKeys.add(halfKey(right.unit)!);
    }
  }
  // A half of a picture across a spread that is a figure cut out by its mask and hidden as a stain at the page's edge (looked at once more as an
  // `EDGE_FIGURE_REASON` unit): a half all the same when an offered half on the facing page lines up with it.
  {
    const offeredLefts = halfCandidates
      .filter((u) => !pairedUnits.has(u) && !leftHalfKeys.has(halfKey(u) ?? '') && !rightHalfKeys.has(halfKey(u) ?? '') && (u.memberEntries.length === 1 || u.reason === PIECED_PICTURE_REASON) && halfKey(u) !== null)
      .map((u) => ({ page: u.page, bbox: u.bbox, unit: u, edge: false }));
    const edgeRights = allUnits
      .filter((u) => u.reason === EDGE_FIGURE_REASON && halfKey(u) !== null && (u.representativeEntry?.maxRelativeArea ?? 0) >= SPREAD_COMPANION_MIN_AREA)
      .map((u) => ({ page: u.page, bbox: u.bbox, unit: u, edge: true }));
    // Any other picture that was hidden (a strip of the drawing at the gutter taken for an ornament, a stain, a backdrop) and that runs to the
    // gutter, lined up with an offered half on the facing page: a companion unit that only stands for the other half (see `SPREAD_COMPANION_REASON`).
    const inUnits = new Set(allUnits.flatMap((u) => [u.representativeEntry, ...u.memberEntries]));
    const companions = classified
      .filter((c) => c.classification === 'decoration' && !inUnits.has(c.entry) && !c.entry.isMaskLayer && c.entry.objId !== null && c.entry.occurrences.length === 1 && c.entry.maxRelativeArea >= SPREAD_COMPANION_MIN_AREA && c.entry.occurrences[0]!.placement?.rotated !== true)
      .map((c): ExtractionUnit => ({ representativeEntry: c.entry, memberEntries: [c.entry], page: c.entry.occurrences[0]!.page, bbox: c.entry.occurrences[0]!.bbox, clusterMemberCount: 1, classification: 'decoration', confidence: c.confidence, reason: SPREAD_COMPANION_REASON }))
      .map((u) => ({ page: u.page, bbox: u.bbox, unit: u, edge: true }));
    // A half stored as pieces (masked rasters at the page's edge, overlapping and blending into each other, each over part of the height,
    // hidden or looked at once more as figures at the edge): the pieces on one page that overlap one another make one companion, over their
    // joined box (see `compositeOfPieces`). A piece by itself stays what it was.
    const pieces = [
      ...companions.map((c) => c.unit),
      ...allUnits.filter((u) => u.reason === EDGE_FIGURE_REASON && u.memberEntries.length === 1 && u.representativeEntry !== null && u.representativeEntry.objId !== null && u.representativeEntry.maxRelativeArea >= SPREAD_COMPANION_MIN_AREA),
    ];
    const grouped = new Set<ExtractionUnit>();
    for (const first of pieces) {
      if (grouped.has(first)) continue;
      const group = [first];
      for (const other of pieces) {
        if (other !== first && !grouped.has(other) && !group.includes(other) && other.page === first.page && group.some((g) => rectIntersection(g.bbox, other.bbox) !== null)) group.push(other);
      }
      if (group.length < 2) continue;
      for (const g of group) grouped.add(g);
      const entries = group.map((g) => g.representativeEntry!);
      const largest = entries.reduce((a, b) => (b.maxRelativeArea > a.maxRelativeArea ? b : a));
      const bbox = group.map((g) => g.bbox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
      const unit: ExtractionUnit = { representativeEntry: largest, memberEntries: entries, page: first.page, bbox, clusterMemberCount: entries.length, classification: 'decoration', confidence: first.confidence, reason: SPREAD_COMPANION_REASON };
      companions.push({ page: first.page, bbox, unit, edge: true });
    }
    if (edgeRights.length + companions.length > 0) {
      for (const [left, right] of findSpreadPairs([...offeredLefts, ...edgeRights, ...companions], pageBoxByPage)) {
        // One half offered, the other the figure at the page's edge or a hidden companion (either side of the gutter).
        if (left.edge === right.edge || right.page !== left.page + 1) continue;
        leftHalfKeys.add(halfKey(left.unit)!);
        rightHalfKeys.add(halfKey(right.unit)!);
        for (const half of [left, right]) {
          if (half.unit.reason !== SPREAD_COMPANION_REASON) continue;
          // A companion of pieces stands for them: the pieces are not looked at by themselves as well (one of them shares its key).
          const pieceUnits = half.unit.memberEntries.length > 1 ? new Set(half.unit.memberEntries) : null;
          const others = (unitsByPage.get(half.unit.page) ?? []).filter((u) => pieceUnits === null || !(u.memberEntries.length === 1 && pieceUnits.has(u.memberEntries[0]!)));
          unitsByPage.set(half.unit.page, [...others, half.unit]);
        }
      }
    }
  }
  // A picture laid aslant across the gutter (a map turned on the spread, cut by each page): a raster on one page that runs past its right edge
  // and one on the next page that runs past its left edge, at overlapping heights. Their boxes do not line up (each is the box of a turned
  // raster), so each is rendered over what it shows (see `ASLANT_HALF_REASON`) and the two are joined as halves.
  const aslantRightKeyOf = new Map<string, string>();
  const aslantLeftKeys = new Set<string>();
  {
    // The occurrence of a half, its box cut to what its clips let through (a turned raster runs far past them).
    const occOf = (u: ExtractionUnit) => {
      const occ = u.representativeEntry?.occurrences.find((o) => o.page === u.page);
      if (occ === undefined) return undefined;
      let bbox: Rect | null = occ.bbox;
      for (const path of occ.clip?.paths ?? []) {
        const bounds = clipPathBBox(path);
        if (bounds !== null && bbox !== null) bbox = rectIntersection(bbox, bounds);
      }
      return { ...occ, shownBox: bbox ?? occ.bbox };
    };
    const aslant = halfCandidates.filter((u) => !pairedUnits.has(u) && !leftHalfKeys.has(halfKey(u) ?? '') && !rightHalfKeys.has(halfKey(u) ?? '') && halfKey(u) !== null && occOf(u)?.placement?.rotated === true && occOf(u)?.placement?.quarterTurns === undefined);
    const taken = new Set<ExtractionUnit>();
    for (const left of aslant) {
      const leftBox = pageBoxByPage.get(left.page);
      const leftOcc = occOf(left)!.bbox;
      // Its raster past the page's right edge (what it shows is checked when the page is read).
      if (leftBox === undefined || taken.has(left) || leftOcc.maxX <= leftBox.maxX + ASLANT_HALF_MIN_PAST_EDGE_PT) continue;
      const right = aslant.find((c) => {
        const rightBox = pageBoxByPage.get(c.page);
        const rightOcc = occOf(c)!.bbox;
        if (c === left || taken.has(c) || c.page !== left.page + 1 || rightBox === undefined || rightOcc.minX >= rightBox.minX - ASLANT_HALF_MIN_PAST_EDGE_PT) return false;
        const shared = Math.min(leftOcc.maxY, rightOcc.maxY, leftBox.maxY, rightBox.maxY) - Math.max(leftOcc.minY, rightOcc.minY, leftBox.minY, rightBox.minY);
        const smaller = Math.min(Math.min(leftOcc.maxY, leftBox.maxY) - Math.max(leftOcc.minY, leftBox.minY), Math.min(rightOcc.maxY, rightBox.maxY) - Math.max(rightOcc.minY, rightBox.minY));
        return smaller > 0 && shared >= ASLANT_HALF_MIN_SHARED_HEIGHT * smaller;
      });
      if (right === undefined) continue;
      taken.add(left);
      taken.add(right);
      aslantLeftKeys.add(halfKey(left)!);
      aslantRightKeyOf.set(halfKey(left)!, halfKey(right)!);
    }
  }
  const aslantRightKeys = new Set(aslantRightKeyOf.values());
  /** The heights the left half of a picture laid aslant shows, for its right half on the next page (by the right half's key). */
  const aslantRowsOf = new Map<string, { minY: number; maxY: number }>();
  const isLeftHalf = (u: ExtractionUnit): boolean => spreadRightOf.has(u) || (halfKey(u) !== null && (leftHalfKeys.has(halfKey(u)!) || aslantLeftKeys.has(halfKey(u)!)) && (u.memberEntries.length === 1 || u.reason === SPREAD_COMPANION_REASON || u.reason === PIECED_PICTURE_REASON));
  const isRightHalf = (u: ExtractionUnit): boolean => spreadRightHalves.has(u) || (halfKey(u) !== null && (rightHalfKeys.has(halfKey(u)!) || aslantRightKeys.has(halfKey(u)!)) && (u.memberEntries.length === 1 || u.reason === SPREAD_COMPANION_REASON || u.reason === PIECED_PICTURE_REASON));

  return {
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
  };
}

/** What `planExtraction` hands to the stages that process the pages. */
export type ExtractionPlan = ReturnType<typeof planExtraction>;
