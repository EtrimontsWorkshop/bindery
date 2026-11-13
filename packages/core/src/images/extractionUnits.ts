import { rectArea, rectIntersection, relativeArea, unionRect, type Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion, VectorShape } from '../inventory/vectorRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { confidenceForReason, isBackdropShape, isTranslucentEverywhere, type ClassifiedImage } from './classify.js';
import { findRuleFrame, findVectorFigures } from './vectorFigures.js';
import { CO_MEMBER_SIGNIFICANT_AREA } from './strategy.js';
import type { ExtractionUnit } from './extractionTypes.js';
import { isPanelBehindFigure, partitionCandidatesIntoGroups } from './extractionPieces.js';
import { CLUSTER_AREA_SAFEGUARD_THRESHOLD, LARGE_VECTOR_AREA_THRESHOLD, textCoverage } from './extractionLooks.js';
import { LINE_DRAWING_MAX_UNIT_PAGE_SHARE } from './extractionJoins.js';

/**
 * Image extraction, building the UNITS of work from classified images: which image represents a unit, how images
 * group into one, and the units made of vector drawings alone. Moved out of `buildImageExtraction.ts` unchanged.
 */

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('buildImageExtraction aborted by AbortSignal', 'AbortError');
}

/**
 * Share of opaque pixels below which a picture is a cut-out figure on a transparent ground: the text that lies
 * in its bbox lies on the page (on the transparent part, next to the figure), not on the picture. Measured on a
 * real rulebook: the cut-out figures are 25%-45% opaque, the paper notes and handouts that carry text are 100%.
 */
export const TEXT_OVER_PICTURE_MIN_OPAQUE_FRACTION = 0.6;
/**
 * A member of a unit counts as covered by another when that one, painted later and fully opaque, covers this much
 * of it (the same measure as the covered-picture rule of the classifier) — and the covering picture is opaque
 * for real: at least this share of its pixels (a vignette or a cut-out figure with a transparent middle is not).
 */
export const COVERED_MEMBER_MIN_COVER = 0.75;
export const COVER_MIN_OPAQUE_FRACTION = 0.9;
/** Share of the region of a cut-out figure that page text must cover for the render to be judged as dragging text in. */
export const CUTOUT_TEXT_MIN_COVERAGE = 0.01;

/**
 * A faded paper vignette — the soft white edge laid over an illustration so that it melts into the page — is a
 * raster that is mostly transparent and whose opaque part is the color of the paper. Measured on a real rulebook:
 * the vignette is 23% opaque with a mean brightness of 207, the cut-out figures are 33%-51% opaque with a
 * mean brightness of 53-77. It is not a picture, and the illustration under it is.
 */
export const PAPER_OVERLAY_MAX_OPAQUE_FRACTION = 0.5;
export const PAPER_OVERLAY_MIN_BRIGHTNESS = 185;
/** The share of the picture under it that a vignette must cover: it is laid over the illustration to melt its edge, not beside it. A pale drawing (sheets of paper) that only touches the next picture is a picture of the same illustration. */
export const PAPER_OVERLAY_MIN_COVER_OF_PICTURE = 0.5;
/**
 * A dark translucent texture is a panel behind the other picture of its unit only when that picture is at least this
 * share of its size: a dark map painted translucent with a small neon sign on its corner (0.12 of it, measured on one
 * book) is a map, not a panel behind the sign.
 */
export const PANEL_BEHIND_PICTURE_MIN_AREA_SHARE = 0.25;

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
export const SAME_PLACE_GAP_PT = 2;

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
export function groupIntoUnits(candidates: readonly ClassifiedImage[], pageBoxByPage: ReadonlyMap<number, Rect>, maskedObjIds: ReadonlySet<string>, diagnostics: Diagnostic[]): ExtractionUnit[] {
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
export function findVectorOnlyUnits(vectors: readonly VectorRegion[], pagesWithAnyImage: ReadonlySet<number>): ExtractionUnit[] {
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

/** The reason of a unit that is a card of a handout, framed by rules (see `findCardUnits`). */
export const CARD_REASON = 'Z24-framed-card';
/**
 * A card: a frame of rules (see `findRuleFrame`) at least this share of the page, with this many pictures in it at least
 * and this many characters of text at most. Measured on five books of a line: the record cards of a set of handouts,
 * 0.67 of the page, 14 pictures, 480-658 characters; the framed panels of the rulebooks are a third of the page or less,
 * or hold a page of text.
 */
export const CARD_MIN_PAGE_SHARE = 0.5;
export const CARD_MIN_PICTURES = 2;
export const CARD_MAX_CHARS = 700;

/**
 * The cards of a set of handouts (a personnel record: photographs, fingerprints and the fields of a form within a frame
 * of rules, to be cut out along it): the whole card, rendered as the page shows it, offered among the images with text.
 * Its pictures are offered by themselves as well.
 */
export function findCardUnits(lines: readonly VectorShape[], images: readonly ImageEntry[], pageBoxByPage: ReadonlyMap<number, Rect>, wordBoxesByPage?: ReadonlyMap<number, readonly (Rect & { chars?: number })[]>): ExtractionUnit[] {
  const linesByPage = new Map<number, VectorShape[]>();
  for (const l of lines) linesByPage.set(l.page, [...(linesByPage.get(l.page) ?? []), l]);
  const units: ExtractionUnit[] = [];
  for (const [page, pageLines] of linesByPage) {
    const pageBox = pageBoxByPage.get(page);
    if (pageBox === undefined) continue;
    const frame = findRuleFrame(pageLines, pageBox);
    if (frame === null || rectArea(frame) < CARD_MIN_PAGE_SHARE * rectArea(pageBox)) continue;
    const inside = (b: Rect): boolean => {
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      return cx >= frame.minX && cx <= frame.maxX && cy >= frame.minY && cy <= frame.maxY;
    };
    const pictures = images.filter((e) => e.occurrences.some((o) => o.page === page && inside(o.bbox) && rectArea(o.bbox) < LINE_DRAWING_MAX_UNIT_PAGE_SHARE * rectArea(frame)));
    const chars = (wordBoxesByPage?.get(page) ?? []).filter(inside).reduce((sum, w) => sum + (w.chars ?? 1), 0);
    if (pictures.length < CARD_MIN_PICTURES || chars > CARD_MAX_CHARS) continue;
    units.push({ representativeEntry: null, memberEntries: [], page, bbox: frame, clusterMemberCount: 0, classification: 'content', confidence: confidenceForReason('Z1-no-strong-signal'), reason: CARD_REASON });
  }
  return units;
}

/** The reason of a unit that is a drawing made of vector paths (see `vectorFigures.ts`). */
export const VECTOR_FIGURE_REASON = 'Z2-vector-figure';
/** A drawing is not offered when the pictures offered on its page (the translucent panels of the layout are not pictures) cover this share of its box (the paths are the decoration of a picture), or the boxes of the page's text blocks this much of it (a table, a form: the blocks of a paragraph that wraps around a figure reach over its box, so the limit is high). */
export const FIGURE_MAX_IMAGE_COVER = 0.5;
export const FIGURE_MAX_TEXT_COVERAGE = 0.75;
/**
 * A drawing is not offered either when the page's WORDS cover this share of its box: the words, unlike the blocks of a
 * wrapping paragraph, lie on the drawing itself — a table on striped rows, a plate of text, a heading drawn over a
 * texture. Measured on 20 books: 44 such clusters at 0.07-0.65 (tables, stat plates, banners of text), the drawings
 * (figures, logos, icons) at 0-0.02.
 */
export const FIGURE_MAX_WORD_COVERAGE = 0.05;
/**
 * A cluster of paths whose shapes are nearly all of one size is a grid of boxes (the tick boxes of a character sheet, a
 * track of stress), not a drawing: the shapes of a drawing differ. Measured on 21 books: the drawings found had at most
 * 52% of their shapes of their commonest size (rounded to a point), the grid of a character sheet's track 100%.
 */
export const FIGURE_MAX_SAME_SIZE_SHARE = 0.8;

/** Share of the shapes that have the commonest size (each side rounded to a point). */
export function sameSizeShare(boxes: readonly Rect[]): number {
  if (boxes.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const b of boxes) {
    const key = `${Math.round(b.maxX - b.minX)}x${Math.round(b.maxY - b.minY)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / boxes.length;
}
/** A drawing that is found at the same place, of the same size, on this many pages is a running ornament (measured on one book: its margin drawn with 182 and 183 shapes, its corner with 26 to 28). */
export const FIGURE_REPEAT_PAGES = 3;
export const FIGURE_REPEAT_GRID_PT = 6;
/** A render of a drawing that is white over this share of its pixels shows a plate or a few lines on an empty page: not a picture. A figure on the tinted paper of a book is nowhere near it. */
export const FIGURE_MAX_WHITE_SHARE = 0.8;

/**
 * The vector drawings of the document as units to render: clusters of filled paths (a cartoon figure, a set of icons), except those that
 * lie on a picture, are mostly text, are a grid of boxes, or are repeated on page after page. Each is offered as undecided.
 */
export function findVectorFigureUnits(
  shapes: readonly { page: number; bbox: Rect }[],
  images: readonly ImageEntry[],
  pageBoxByPage: ReadonlyMap<number, Rect>,
  textBoxesByPage: ReadonlyMap<number, readonly Rect[]>,
  wordBoxesByPage?: ReadonlyMap<number, readonly Rect[]>,
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
  // The place and the size, not the number of shapes: a running ornament is drawn with a few shapes more or less from page to page.
  const signature = (f: { bbox: Rect }): string => [f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY].map((v) => Math.round(v / FIGURE_REPEAT_GRID_PT)).join(',');
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
      if (wordBoxesByPage !== undefined && textCoverage(f.foundBbox, wordBoxesByPage.get(f.page)) >= FIGURE_MAX_WORD_COVERAGE) return false;
      if (sameSizeShare(f.shapeBoxes) >= FIGURE_MAX_SAME_SIZE_SHARE) return false;
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
export function syntheticVectorOnlyEntry(pageNumber: number, bbox: Rect, relativeArea = 1): ImageEntry {
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
