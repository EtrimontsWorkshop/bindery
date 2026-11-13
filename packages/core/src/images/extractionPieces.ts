import { clusterByOverlap } from '../clustering.js';
import { overlapRatio, rectArea, rectIntersection, unionRect, type Matrix, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import { FINGERPRINT_GRID, type ContentFingerprint } from '../inventory/contentFingerprint.js';
import { isBackdropShape, type ClassifiedImage } from './classify.js';
import { connectedGroups, type OpaqueMask } from './opaqueOverlap.js';
import { clipsShareCorner, isShapedClip, pointInClipPath, type ClipInfo } from '../inventory/clipPaths.js';
import { CO_MEMBER_SIGNIFICANT_AREA } from './strategy.js';
import { EDGE_TOUCH_MAX_OVERLAP_RATIO, isAnchorCandidate, isBleedingUndecided, isForcedFullBleedContent, textCoverage } from './extractionLooks.js';
import type { ExtractionUnit } from './extractionTypes.js';

/**
 * Image extraction, rules about pictures stored in PIECES: grouping candidates, ornaments at the edge, slices of one
 * picture, tiles with seams, repaints, and boxes kept clear of text. Moved out of `buildImageExtraction.ts` unchanged.
 */

export function partitionCandidatesIntoGroups(candidates: readonly ClassifiedImage[]): ClassifiedImage[][] {
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
export const LAYOUT_CARD_MIN_AREA = 0.25;

/**
 * The frame of a card of text (a box of rules on parchment) has ornaments that straddle its edge: a title plaque across the top, a flourish
 * across the bottom. The card's own box cuts them in half. A piece that mostly lies over the card's width, reaches past its edge by a few
 * points and has a good part of itself inside it belongs to the card.
 */
export const ORNAMENT_MIN_INSIDE_SHARE = 0.3;
export const ORNAMENT_MIN_WIDTH_INSIDE_SHARE = 0.8;
export const ORNAMENT_MAX_REACH_PT = 50;
/** A piece that sticks out at the sides further than this is a band of the page (a footer), not an ornament of the card. */
export const ORNAMENT_MAX_SIDE_REACH_PT = 25;
/** Ornaments are small pieces: a page-area share above which a decoration is not one. */
export const ORNAMENT_MAX_AREA = 0.05;

/** Pieces that come within this distance of the edge of the page are its header or footer, not an ornament of a card. */
export const ORNAMENT_PAGE_MARGIN_PT = 30;

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
export const SPLIT_BANNER_MASKED_MIN_AREA = 0.045;
export const SPLIT_BANNER_REPRESENTATIVE_MIN_AREA = 0.5;

/**
 * Share of a picture's own box that the page's text must cover for the picture to be a card of text (a parchment with a stat block on it). A
 * portrait with a caption line or a paragraph touching it stays well below this; the cards measured on a real adventure are at 38%.
 */
export const SPLIT_TEXT_CARD_MIN_COVERAGE = 0.3;
/** A picture that a card of text is told apart from is a picture of consequence (a portrait), not a clip or a tape: at least this share of the page. */
export const SPLIT_TEXT_CARD_PICTURE_MIN_AREA = 0.1;
/** A picture lying this far on the card (a photo on a newspaper clipping, a signature on a sheet) is part of it: the card is left whole. */
export const SPLIT_TEXT_CARD_MAX_PICTURE_ON_CARD = 0.8;

/** Share of the smaller of two frames that they may overlap by and still be two pictures. */
export const FRAMES_MAX_OVERLAP_SHARE = 0.25;
/** Two pictures without frames: the boxes of their rasters may overlap by this share of the smaller one (neighbors that touch) and still be two pictures. */
export const BOXES_MAX_OVERLAP_SHARE = 0.1;

/** The outline (a polygon, flat x/y pairs) of the frame (the clip) a picture is shown in on `page`, or undefined when it is not shown in one. */
export function visibleWindow(entry: ImageEntry, page: number): readonly number[] | undefined {
  const polygon = entry.occurrences.find((o) => o.page === page)?.clip?.paths[0]?.[0];
  return polygon === undefined || polygon.length < 6 ? undefined : polygon;
}

/**
 * The reason of a unit whose pictures are slices of one picture, each cut out by a shaped clip (see `isShapedClip`). The rasters of the
 * slices run far past what they show (transparent, over the page's heading and text), so the unit is rendered over the box of the points
 * the slices show: opaque in their raster and inside their clips.
 */
export const SLICED_PICTURE_REASON = 'Z26-sliced-picture';
/**
 * The reason of a picture painted as a few pieces, each shown in a clip of its own (a drawing in a torn frame painted as strips), told apart
 * from the tiles of a picture beside it (see `splitMosaicFromRest`). Placed like a sliced picture (see `SLICED_PICTURE_REASON`), it is taken
 * from its pieces' own pixels laid over one another (see `composeOverBox`): a render of its box would bring the page's text round its tilted frame.
 */
export const CLIPPED_PIECES_REASON = 'Z27-clipped-pieces';
/** The matrix of a raster painted upright in `box` (mirrored as given): the unit square onto the box. */
export function uprightMatrix(box: Rect, flipX: boolean, flipY: boolean): Matrix {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  return [flipX ? -w : w, 0, 0, flipY ? -h : h, flipX ? box.maxX : box.minX, flipY ? box.maxY : box.minY];
}

/** Whether a picture is a piece of a picture painted in pieces: cut out by a straight clip (see `isShapedClip`), or a raster turned aslant with no clip (a strip of a blade laid along it). */
export function isPieceOf(entry: ImageEntry, page: number): boolean {
  const own = entry.occurrences.find((o) => o.page === page);
  return own !== undefined && (isShapedClip(own.clip) || (own.clip === undefined && own.ctm !== undefined && own.placement?.quarterTurns === undefined));
}

/**
 * Whether `members` are the slices of one picture: each cut out by a straight clip (see `isShapedClip`), and the `significant` ones
 * joined through the corners their clips share (the cut runs from one slice to the next).
 */
export function areSlicesOfOnePicture(members: readonly ImageEntry[], significant: readonly ImageEntry[], page: number): boolean {
  const clips = members.map((m) => m.occurrences.find((o) => o.page === page)?.clip);
  if (!clips.every((c): c is ClipInfo => c !== undefined && isShapedClip(c))) return false;
  const groups = connectedGroups(members.length, (i, j) => clipsShareCorner(clips[i]!, clips[j]!));
  return groups.some((g) => significant.every((m) => g.includes(members.indexOf(m))));
}

/** A small picture painted in pieces has this many of them at least (a sword: six strips of its blade and its hilt, laid aslant). */
export const SMALL_SLICED_PICTURE_MIN_PIECES = 3;
/** Distance between the points at which the slices of a picture are looked at, in points of the page. */
export const SLICE_SAMPLE_STEP_PT = 1;
/**
 * The box of a sliced picture reaches this far past what its slices show: the soft end of an edge, and the small pieces that were hidden as
 * the page's ornaments. Measured on one book: the tip of a blade 7 pt past the slices; the heading and the text 16 pt and more away.
 */
export const SLICE_MARGIN_PT = 8;
/** A render cut to what its drawings show reaches this far past them (the soft end of an edge). */
export const INK_BOX_MARGIN_PT = 4;
/** A render is cut to what its drawings show only while this share of it is left (a picture whose ink was not found is left whole). */
export const INK_BOX_MIN_KEPT_SHARE = 0.4;
/** A render is cut to what its drawings show only when the paper at the edge of its largest raster is light (drawings on paper, not a cover on a dark ground). */
export const INK_BOX_MIN_PAPER_LUMINANCE = 200;
/**
 * ... and when the page's words cover at most this share of it: drawings beside the text, not a card of text. Measured on three books: drawings
 * beside a table or a column 0.03-0.14, cards and notes of text 0.2-0.72.
 */
export const INK_BOX_MAX_WORD_COVERAGE = 0.15;
/** ... and at least this share (a few words at the corner of a render are not worth a cut that may miss a pale part of a drawing). */
export const INK_BOX_MIN_WORD_COVERAGE = 0.02;

/**
 * The box of the points of `members` that the page shows: inked in their raster (`masks`, by objId) and inside every clip of theirs. A
 * point is taken back to the raster through the matrix the picture is painted with (the slices of a picture are often turned).
 */
export function shownBoxOfSlices(members: readonly ImageEntry[], page: number, masks: ReadonlyMap<string, OpaqueMask>): Rect | null {
  let shown: Rect | null = null;
  for (const m of members) {
    const own = m.occurrences.find((o) => o.page === page);
    const mask = m.objId === null ? undefined : masks.get(m.objId);
    if (own === undefined || mask === undefined) continue;
    const ctm = own.clip?.ctm ?? own.ctm ?? uprightMatrix(own.bbox, own.placement?.flipX === true, own.placement?.flipY === true);
    const [a, b, c, d, e, f] = ctm;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) continue;
    for (let y = own.bbox.minY + SLICE_SAMPLE_STEP_PT / 2; y < own.bbox.maxY; y += SLICE_SAMPLE_STEP_PT) {
      for (let x = own.bbox.minX + SLICE_SAMPLE_STEP_PT / 2; x < own.bbox.maxX; x += SLICE_SAMPLE_STEP_PT) {
        // The unit square of the image: (0, 0) its bottom left corner; the first row of the raster is its top.
        const u = (d * (x - e) - c * (y - f)) / det;
        const v = (a * (y - f) - b * (x - e)) / det;
        if (u < 0 || u >= 1 || v <= 0 || v > 1) continue;
        const col = Math.min(mask.width - 1, Math.floor(u * mask.width));
        const row = Math.min(mask.height - 1, Math.floor((1 - v) * mask.height));
        if (mask.opaque[row * mask.width + col] !== 1 || !(own.clip?.paths ?? []).every((path) => pointInClipPath(path, x, y))) continue;
        const point = { minX: x - SLICE_SAMPLE_STEP_PT / 2, minY: y - SLICE_SAMPLE_STEP_PT / 2, maxX: x + SLICE_SAMPLE_STEP_PT / 2, maxY: y + SLICE_SAMPLE_STEP_PT / 2 };
        shown = shown === null ? point : unionRect(shown, point);
      }
    }
  }
  return shown;
}

export function polygonArea(polygon: readonly number[]): number {
  let twice = 0;
  for (let i = 0, j = polygon.length / 2 - 1; i < polygon.length / 2; j = i++) twice += polygon[2 * j]! * polygon[2 * i + 1]! - polygon[2 * i]! * polygon[2 * j + 1]!;
  return Math.abs(twice) / 2;
}

/** The part of `subject` that lies inside the convex polygon `clip` (Sutherland-Hodgman), as flat x/y pairs. */
export function clipPolygon(subject: readonly number[], clip: readonly number[]): number[] {
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
export const TILE_SEAM_MAX_OVERLAP_PT = 1.5;
export const TILE_SEAM_MAX_GAP_PT = 0.5;
/** The seam runs along this share of the shorter side of the two tiles. */
export const TILE_SEAM_MIN_ALIGNED_SHARE = 0.9;
/** The tiles of one picture have the same pixel density (a collage of different pictures hardly ever does): the densities differ by at most this share. */
export const TILE_MAX_DENSITY_DIFFERENCE = 0.05;

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
export function isRepaintOf(a: { entry: ImageEntry; box: Rect }, b: { entry: ImageEntry; box: Rect }): boolean {
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1;
  return a.entry.intrinsicWidth === b.entry.intrinsicWidth && a.entry.intrinsicHeight === b.entry.intrinsicHeight && near(a.box.minX, b.box.minX) && near(a.box.minY, b.box.minY) && near(a.box.maxX, b.box.maxX) && near(a.box.maxY, b.box.maxY);
}

/** `unit` without the rasters that repaint another of its members on this page (see `isRepaintOf`). */
export function withoutRepaints(unit: ExtractionUnit): ExtractionUnit {
  const boxOf = (m: ImageEntry): Rect | undefined => m.occurrences.find((o) => o.page === unit.page)?.bbox;
  const kept = unit.memberEntries.filter((m, at) => {
    const box = boxOf(m);
    return box === undefined || !unit.memberEntries.slice(0, at).some((k) => boxOf(k) !== undefined && isRepaintOf({ entry: k, box: boxOf(k)! }, { entry: m, box }));
  });
  if (kept.length === unit.memberEntries.length) return unit;
  return { ...unit, memberEntries: kept, clusterMemberCount: kept.length };
}

export function windowsAreApart(a: readonly number[], b: readonly number[], maxShare: number): boolean {
  const shared = polygonArea(clipPolygon(a, b));
  return shared < maxShare * Math.min(polygonArea(a), polygonArea(b));
}

/**
 * Two pictures that abut along the whole of a side (within this many points, a gap or an overlap) are tiles of one
 * picture cut into rasters (a map stored as a plan, a strip of its ground and a panel of its legend), when the side
 * they share is at least this share of each of the two sides: the seam runs from edge to edge of both (a small picture
 * set against a big one is not a tile of it). Measured on one book: the tiles of a map overlap
 * by 2.1-2.3 pt along 0.98-1 of their sides.
 */
export const MOSAIC_MAX_SEAM_PT = 3;
export const MOSAIC_MIN_SHARED_SIDE = 0.9;
/**
 * The tiles of one picture run on across their seam: the cells of their content fingerprints along it differ by this
 * much at most (0-255). Measured on three books: the tiles of maps 3-22, two frames of a comic set edge to edge 31-48,
 * portraits stacked edge to edge 46 and more.
 */
export const MOSAIC_MAX_SEAM_DIFFERENCE = 25;
/**
 * A raster that fills its page is no tile of a picture: a page's paper meets the paper of the facing page that bleeds into it (a spread of two
 * backgrounds), whose seam runs on just as smoothly.
 */
export const MOSAIC_TILE_MAX_PAGE_SHARE = 0.97;
/** A picture whose box lies within the region of an offered render by at least this share is shown by that render (see `renderedBoxesByPage`). */
export const RENDERED_PIECE_MIN_INSIDE_SHARE = 0.95;
/**
 * Pieces of the page's paper (see `paperPieces`): a unit within this many points of a page edge (or past it) runs off that edge; each raster of it
 * is below this share of the page; light on average (area-weighted mean luminance of their own pixels, 0-255); with at most this share of the
 * unit under page words, unless the unit covers this share of the page. Measured on one book: the paper's corner pieces 188-215 and its tiles
 * under a chapter's text 225, against 119 and 174 for the parts of a cover painting.
 */
export const PAPER_PIECE_EDGE_PT = 2;
export const PAPER_PIECE_MAX_PAGE_SHARE = 0.15;
export const PAPER_PIECE_MIN_MEAN_LUMINANCE = 180;
export const PAPER_PIECE_MAX_WORD_COVERAGE = 0.02;
export const PAPER_PIECES_MIN_PAGE_SHARE = 0.9;

export function unitPageShareOf(box: Rect, pageBox: Rect): number {
  const shared = rectIntersection(box, pageBox);
  return shared === null || rectArea(pageBox) <= 0 ? 0 : rectArea(shared) / rectArea(pageBox);
}

/** Whether `a` and `b` abut along a whole side (see `MOSAIC_MAX_SEAM_PT`), side by side or one above the other. */
export function areMosaicTiles(a: Rect, b: Rect): boolean {
  const sharedRun = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const seam = (aEnd: number, bStart: number): boolean => Math.abs(aEnd - bStart) <= MOSAIC_MAX_SEAM_PT;
  const ha = a.maxY - a.minY;
  const hb = b.maxY - b.minY;
  const wa = a.maxX - a.minX;
  const wb = b.maxX - b.minX;
  const sideBySide = (seam(a.maxX, b.minX) || seam(b.maxX, a.minX)) && sharedRun(a.minY, a.maxY, b.minY, b.maxY) >= MOSAIC_MIN_SHARED_SIDE * Math.max(ha, hb);
  const stacked = (seam(a.maxY, b.minY) || seam(b.maxY, a.minY)) && sharedRun(a.minX, a.maxX, b.minX, b.maxX) >= MOSAIC_MIN_SHARED_SIDE * Math.max(wa, wb);
  return sideBySide || stacked;
}

/**
 * Mean difference (0-255) between the edges of two tiles that meet at a seam, read from their content fingerprints:
 * the cells of each fingerprint at the seam, at points along the run of it the two share. `null` when either has no
 * fingerprint or they do not meet.
 */
export function seamDifference(a: { box: Rect; fingerprint?: ContentFingerprint }, b: { box: Rect; fingerprint?: ContentFingerprint }): number | null {
  if (!a.fingerprint || !b.fingerprint) return null;
  const n = FINGERPRINT_GRID;
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= MOSAIC_MAX_SEAM_PT;
  // The fingerprint's cell at a point of the page (PDF space is y up; row 0 of a fingerprint is the top of the picture), at the given edge.
  const cellAt = (t: { box: Rect; fingerprint?: ContentFingerprint }, x: number, y: number): number => {
    const col = Math.min(n - 1, Math.max(0, Math.floor(((x - t.box.minX) / (t.box.maxX - t.box.minX)) * n)));
    const row = Math.min(n - 1, Math.max(0, Math.floor(((t.box.maxY - y) / (t.box.maxY - t.box.minY)) * n)));
    return t.fingerprint![row * n + col]!;
  };
  const points: { xa: number; ya: number; xb: number; yb: number }[] = [];
  const along = (from: number, to: number): number[] => (to > from ? Array.from({ length: n }, (_, i) => from + ((i + 0.5) / n) * (to - from)) : []);
  if (near(a.box.maxX, b.box.minX) || near(b.box.maxX, a.box.minX)) {
    const [left, right] = near(a.box.maxX, b.box.minX) ? [a, b] : [b, a];
    for (const y of along(Math.max(a.box.minY, b.box.minY), Math.min(a.box.maxY, b.box.maxY))) points.push({ xa: left.box.maxX - 0.01, ya: y, xb: right.box.minX + 0.01, yb: y });
    if (points.length === 0) return null;
    return points.reduce((sum, p) => sum + Math.abs(cellAt(left, p.xa, p.ya) - cellAt(right, p.xb, p.yb)), 0) / points.length;
  }
  if (near(a.box.minY, b.box.maxY) || near(b.box.minY, a.box.maxY)) {
    const [upper, lower] = near(a.box.minY, b.box.maxY) ? [a, b] : [b, a];
    for (const x of along(Math.max(a.box.minX, b.box.minX), Math.min(a.box.maxX, b.box.maxX))) points.push({ xa: x, ya: upper.box.minY + 0.01, xb: x, yb: lower.box.maxY - 0.01 });
    if (points.length === 0) return null;
    return points.reduce((sum, p) => sum + Math.abs(cellAt(upper, p.xa, p.ya) - cellAt(lower, p.xb, p.yb)), 0) / points.length;
  }
  return null;
}

/**
 * Tiles of one picture laid like bricks of different sizes, overlapping a little (see `BRICK_MAX_OVERLAP_PT`), most too small to be offered by
 * themselves: rasters of one pixel density (within `BRICK_MAX_DENSITY_DIFFERENCE`) that meet or overlap each other, with an offered picture among
 * them, and that cover the rectangle of their union (`BRICK_MIN_COVER`) without overlapping much (`BRICK_MAX_AREA_EXCESS`) and with little of the
 * page's text over them (`BRICK_MAX_TEXT_COVERAGE`: bricks under a box of text are its backdrop) are one picture. A
 * raster that reaches the page's edge (a piece of the page's paper at its corner) is not one of them. Measured on one book: a scene cut into nine
 * rasters of 4.17-4.19 px/pt overlapping by up to 13 pt was offered as two of its pieces.
 */
export const BRICK_MAX_OVERLAP_PT = 15;
export const BRICK_MAX_DENSITY_DIFFERENCE = 0.03;
export const BRICK_MIN_COVER = 0.98;
export const BRICK_MAX_AREA_EXCESS = 0.15;
export const BRICK_PAGE_EDGE_PT = 1;
export const BRICK_COVER_GRID = 64;
export const BRICK_MAX_TEXT_COVERAGE = 0.1;

export function joinBrickTiles(units: ExtractionUnit[], leftovers: readonly ClassifiedImage[], isTile: (u: ExtractionUnit) => boolean, pageBoxByPage: ReadonlyMap<number, Rect> | undefined, textBoxesByPage: ReadonlyMap<number, readonly Rect[]> | undefined): ExtractionUnit[] {
  if (pageBoxByPage === undefined) return units;
  type Piece = { entry: ImageEntry; box: Rect; page: number; unit: ExtractionUnit | null };
  const density = (p: Piece): [number, number] | null => {
    const full = p.entry.occurrences.find((o) => o.page === p.page)?.bbox;
    return full && p.entry.intrinsicWidth && p.entry.intrinsicHeight && full.maxX > full.minX && full.maxY > full.minY ? [p.entry.intrinsicWidth / (full.maxX - full.minX), p.entry.intrinsicHeight / (full.maxY - full.minY)] : null;
  };
  const sameDensity = (a: Piece, b: Piece): boolean => {
    const da = density(a);
    const db = density(b);
    return da !== null && db !== null && Math.abs(da[0] - db[0]) <= BRICK_MAX_DENSITY_DIFFERENCE * da[0] && Math.abs(da[1] - db[1]) <= BRICK_MAX_DENSITY_DIFFERENCE * da[1];
  };
  const atPageEdge = (p: Piece): boolean => {
    const page = pageBoxByPage.get(p.page);
    return page === undefined || p.box.minX <= page.minX + BRICK_PAGE_EDGE_PT || p.box.minY <= page.minY + BRICK_PAGE_EDGE_PT || p.box.maxX >= page.maxX - BRICK_PAGE_EDGE_PT || p.box.maxY >= page.maxY - BRICK_PAGE_EDGE_PT;
  };
  // The part of a raster that shows: its box, cut by its clip when that is a rectangle (a brick cut short where the next one lies over it).
  const plain = (e: ImageEntry, page: number): Rect | undefined => {
    const occ = e.occurrences.find((o) => o.page === page);
    if (occ === undefined || occ.placement?.rotated === true) return undefined;
    if (occ.clip === undefined) return occ.bbox;
    const window = visibleWindow(e, page);
    if (window === undefined || window.length !== 8) return undefined;
    const xs = [window[0]!, window[2]!, window[4]!, window[6]!];
    const ys = [window[1]!, window[3]!, window[5]!, window[7]!];
    const axisAligned = [0, 1, 2, 3].every((i) => {
      const j = (i + 1) % 4;
      return Math.abs(xs[i]! - xs[j]!) <= 0.5 || Math.abs(ys[i]! - ys[j]!) <= 0.5;
    });
    if (!axisAligned) return undefined;
    return rectIntersection(occ.bbox, { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }) ?? undefined;
  };
  const meet = (a: Rect, b: Rect): boolean => {
    const gapX = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX);
    const gapY = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY);
    // Edge to edge (one gap at most a seam, the other run a real overlap), or overlapping by a band no deeper than a brick's overlap.
    if (gapX > MOSAIC_MAX_SEAM_PT || gapY > MOSAIC_MAX_SEAM_PT) return false;
    if (gapX > 0 || gapY > 0) return gapX <= 0 ? -gapX > MOSAIC_MAX_SEAM_PT : -gapY > MOSAIC_MAX_SEAM_PT;
    return Math.min(-gapX, -gapY) <= BRICK_MAX_OVERLAP_PT;
  };
  const inUnits = new Set(units.flatMap((u) => u.memberEntries));
  const pieces: Piece[] = [];
  for (const u of units) {
    if (!isTile(u)) continue;
    for (const m of u.memberEntries) {
      const box = plain(m, u.page);
      if (box !== undefined) pieces.push({ entry: m, box, page: u.page, unit: u });
    }
  }
  for (const c of leftovers) {
    if (inUnits.has(c.entry) || c.entry.occurrences.length !== 1) continue;
    const page = c.entry.occurrences[0]!.page;
    const box = plain(c.entry, page);
    if (box !== undefined) pieces.push({ entry: c.entry, box, page, unit: null });
  }
  const usable = pieces.filter((p) => density(p) !== null && !atPageEdge(p));
  const parent = usable.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) if (usable[i]!.page === usable[j]!.page && sameDensity(usable[i]!, usable[j]!) && meet(usable[i]!.box, usable[j]!.box)) parent[find(i)] = find(j);
  const groups = new Map<number, Piece[]>();
  usable.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));
  const replaced = new Map<ExtractionUnit, ExtractionUnit | null>();
  for (const group of groups.values()) {
    const groupUnits = [...new Set(group.map((p) => p.unit).filter((u): u is ExtractionUnit => u !== null))];
    if (group.length < 3 || groupUnits.length === 0 || groupUnits.some((u) => replaced.has(u))) continue;
    // Every raster of a unit taken in must be a brick of the group: a unit is joined whole or not at all.
    if (groupUnits.some((u) => u.memberEntries.some((m) => !group.some((p) => p.entry === m)))) continue;
    const bbox = group.slice(1).reduce((r, p) => unionRect(r, p.box), group[0]!.box);
    const area = (r: Rect): number => Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
    if (group.reduce((sum, p) => sum + area(p.box), 0) > (1 + BRICK_MAX_AREA_EXCESS) * area(bbox)) continue;
    let covered = 0;
    const w = (bbox.maxX - bbox.minX) / BRICK_COVER_GRID;
    const h = (bbox.maxY - bbox.minY) / BRICK_COVER_GRID;
    for (let gy = 0; gy < BRICK_COVER_GRID; gy++) {
      for (let gx = 0; gx < BRICK_COVER_GRID; gx++) {
        const x = bbox.minX + (gx + 0.5) * w;
        const y = bbox.minY + (gy + 0.5) * h;
        if (group.some((p) => x >= p.box.minX && x <= p.box.maxX && y >= p.box.minY && y <= p.box.maxY)) covered++;
      }
    }
    if (covered < BRICK_MIN_COVER * BRICK_COVER_GRID * BRICK_COVER_GRID) continue;
    // Bricks under the page's text are the backdrop of a box of text, judged as such piece by piece.
    if (textCoverage(bbox, textBoxesByPage?.get(group[0]!.page)) > BRICK_MAX_TEXT_COVERAGE) continue;
    const entries = group.map((p) => p.entry);
    const representative = entries.reduce((best, e) => (e.maxRelativeArea > best.maxRelativeArea ? e : best));
    const first = groupUnits[0]!;
    const joined: ExtractionUnit = {
      ...first,
      representativeEntry: representative,
      memberEntries: entries,
      bbox,
      clusterMemberCount: entries.length,
      classification: groupUnits.some((u) => u.classification === 'content') ? 'content' : 'undecided',
    };
    groupUnits.forEach((u, i) => replaced.set(u, i === 0 ? joined : null));
  }
  if (replaced.size === 0) return units;
  return units.flatMap((u) => {
    if (!replaced.has(u)) return [u];
    const r = replaced.get(u);
    return r ? [r] : [];
  });
}

/**
 * The tiles of one picture laid like bricks (the seams of one row not in line with those of the next) do not share a
 * whole side two by two. They are still one picture when together they fill a rectangle, each tile within this share
 * of its area of an exact fill (the overlap or gap of the seams), and each meets one of the others without a change of
 * content (see `MOSAIC_MAX_SEAM_DIFFERENCE`). A strip of the picture too small to be offered on its own (`leftovers`:
 * the candidates in no unit, and the small pictures of a crowded page) takes part as a tile, and is kept only as one.
 * Strips that run on from the tiles into the design of the page (the ends of a frame under a box of text, leaving a
 * hole) are left out; a set of units that does not fill a rectangle is not joined. Measured on one book: an advert cut into
 * four rasters and a strip with the tops of its letters, filled to 0.99.
 */
export const TILED_RECTANGLE_MAX_FILL_ERROR = 0.03;
/** A set of tiles that leaves a hole is searched for the strips that keep it a rectangle up to this many strips (2^n subsets). */
export const TILED_RECTANGLE_MAX_STRIPS = 10;
/**
 * A picture left out of the units is a strip of a tiled picture only when it is this many times longer than wide.
 * Measured on two books: the strip with the tops of an advert's letters 14:1; the pieces of a box of text below a
 * portrait (offered among the images with text) 1:1.
 */
export const TILED_RECTANGLE_MIN_STRIP_ASPECT = 4;
/**
 * A picture stored as a grid of small rasters of one size (a portrait as 9 rows of 5): this many of them at least, set edge to edge, filling
 * their rectangle and running on across the seams. Each is too small to be offered by itself (taken for the parts of a form, or for a speck).
 */
export const GRID_PICTURE_MIN_TILES = 6;
/** A box is cut clear of the text that runs across its edge only while this share of its height or width is left. */
export const CLEAR_OF_TEXT_MIN_KEPT_SHARE = 0.8;

/**
 * `box` cut clear of the blocks of text that run across its top or bottom edge (a name set in large letters over the foot of a portrait), or
 * across its left or right edge, as long as most of it is left (see `CLEAR_OF_TEXT_MIN_KEPT_SHARE`). Text inside the box is not touched.
 */
export function clearOfCrossingText(box: Rect, textBoxes: readonly Rect[], edges: 'all' | 'sides' = 'all'): Rect {
  let out = box;
  const h = box.maxY - box.minY;
  const w = box.maxX - box.minX;
  for (const t of textBoxes) {
    if (rectIntersection(t, out) === null) continue;
    const across = t.minX < out.maxX && t.maxX > out.minX;
    const down = t.minY < out.maxY && t.maxY > out.minY;
    if (edges === 'all' && across && t.minY < out.minY && t.maxY > out.minY && t.maxY - box.minY <= (1 - CLEAR_OF_TEXT_MIN_KEPT_SHARE) * h) out = { ...out, minY: t.maxY };
    else if (edges === 'all' && across && t.maxY > out.maxY && t.minY < out.maxY && box.maxY - t.minY <= (1 - CLEAR_OF_TEXT_MIN_KEPT_SHARE) * h) out = { ...out, maxY: t.minY };
    else if (down && t.minX < out.minX && t.maxX > out.minX && t.maxX - box.minX <= (1 - CLEAR_OF_TEXT_MIN_KEPT_SHARE) * w) out = { ...out, minX: t.maxX };
    else if (down && t.maxX > out.maxX && t.minX < out.maxX && box.maxX - t.minX <= (1 - CLEAR_OF_TEXT_MIN_KEPT_SHARE) * w) out = { ...out, maxX: t.minX };
  }
  return out;
}

/**
 * The rows of `box` clear of a column of the page's text that runs over its top or its foot: the blocks of text that cross that edge and the
 * blocks set on under them (a paragraph after a paragraph, `ROWS_CLEAR_OF_TEXT_MAX_GAP_PT` apart at most), within the share of its height that
 * `clearOfCrossingText` may cut. Labels inside the picture (the numbers and names on a map) cross no edge and are left. A margin (pt) keeps the
 * descenders of the last line, which run below the box of its block, out of the rows as well.
 */
export const ROWS_CLEAR_OF_TEXT_MARGIN_PT = 4;
export const ROWS_CLEAR_OF_TEXT_MAX_GAP_PT = 12;
export function rowsClearOfText(box: Rect, textBoxes: readonly Rect[]): { minY: number; maxY: number } {
  const band = (1 - CLEAR_OF_TEXT_MIN_KEPT_SHARE) * (box.maxY - box.minY);
  const across = textBoxes.filter((t) => t.minX < box.maxX && t.maxX > box.minX);
  // From the edge at maxY inwards, then from the edge at minY.
  let top = box.maxY;
  if (across.some((t) => t.minY < box.maxY && t.maxY > box.maxY)) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of across) {
        if (t.maxY > box.maxY - band && t.minY < top && t.minY >= box.maxY - band && t.maxY >= top - ROWS_CLEAR_OF_TEXT_MAX_GAP_PT) {
          top = t.minY;
          grew = true;
        }
      }
    }
  }
  let foot = box.minY;
  if (across.some((t) => t.minY < box.minY && t.maxY > box.minY)) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of across) {
        if (t.minY < box.minY + band && t.maxY > foot && t.maxY <= box.minY + band && t.minY <= foot + ROWS_CLEAR_OF_TEXT_MAX_GAP_PT) {
          foot = t.maxY;
          grew = true;
        }
      }
    }
  }
  return { minY: foot === box.minY ? foot : foot + ROWS_CLEAR_OF_TEXT_MARGIN_PT, maxY: top === box.maxY ? top : top - ROWS_CLEAR_OF_TEXT_MARGIN_PT };
}

/** Page-area share from which a faded layer counts as a panel (the misty ground a figure stands on) and not as a picture of its own. */
export const PANEL_BEHIND_FIGURE_MIN_AREA = 0.1;
/** ...and up to this share (a faded picture that fills most of the page is a background art of its own) and at up to this opacity (the faded pictures worth offering sit at 50%-65%). */
export const PANEL_BEHIND_FIGURE_MAX_AREA = 0.5;
export const PANEL_BEHIND_FIGURE_MAX_OPACITY = 0.45;

/**
 * A large layer painted faded (at most 45% opaque everywhere it appears) in a unit that also holds an opaque picture of consequence: the misty panel the figure
 * stands in front of, not a second picture. On its own a faded picture is a picture worth offering (a watermark, a faded sketch); it is the figure
 * beside it that makes it a backdrop.
 */
export function isPanelBehindFigure(entry: ImageEntry, unit: ExtractionUnit): boolean {
  if (entry.maxOpacity === undefined || entry.maxOpacity > PANEL_BEHIND_FIGURE_MAX_OPACITY || entry.maxRelativeArea < PANEL_BEHIND_FIGURE_MIN_AREA || entry.maxRelativeArea > PANEL_BEHIND_FIGURE_MAX_AREA) return false;
  return unit.memberEntries.some((m) => m !== entry && m.maxOpacity === undefined && !isBackdropShape(m) && m.maxRelativeArea >= CO_MEMBER_SIGNIFICANT_AREA);
}
