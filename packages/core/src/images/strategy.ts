import type { ImageEntry } from '../inventory/imageRegistry.js';

/**
 * Extraction strategy. Not every image classified
 * as `content` may be extracted directly — the decision always comes with
 * an explicit justification (`reason`), never a plain `boolean` (needed in
 * the report and on the review screen).
 *
 * The decision table has five rows, but only TWO final strategies:
 * - `direct` — "a single image, no mask, no cluster", or a masked raster whose mask lets most of it through and
 *   whose raw resource has the shape of its place on the page, or a clustered raster whose region would be cut by text of the surrounding page
 *   (then the raw resource is cleaner than a render).
 * - `region-render` — everything else (mask, cluster, no image/vector, transparency over background).
 *
 * Note: "an image with transparency over background" (the table's last row)
 * has no independent signal today that's detectable without decoding the
 * alpha channel — we DELIBERATELY do NOT build a separate mechanism for this
 * (don't invest in gaps like this). Treated as a subset of "an
 * image with a mask" (`isMasked`): both require rendering the composition
 * instead of the raw resource, and `maskEvidence` already detects this for
 * cases with an explicit SMask/Luminosity mask or a mask opcode.
 */

export type ExtractionStrategy = 'direct' | 'region-render';

export interface StrategyDecision {
  strategy: ExtractionStrategy;
  reason: string;
}

export interface StrategyInput {
  /** `null` = a purely vector region (a drawn map), no image to extract. */
  entry: ImageEntry | null;
  /** Whether THIS resource is masked by another entry (its objId is the `masksImageObjId` of some entry with hard mask evidence). */
  isMasked: boolean;
  /** Number of DISTINCT resources (ImageEntry) sharing the same cluster of overlapping occurrences on the same page, INCLUDING this entry. */
  clusterMemberCount: number;
  /**
   * Whether body/caption text blocks of the page are cut by the edge of the unit's region — text of
   * the surrounding layout that a render of the region would slice into the picture. See
   * `textCrossesRegionEdge` in `buildImageExtraction.ts`.
   */
  textCrossesRegionEdge?: boolean;
  /**
   * Whether the raw resource has the shape of the place it is painted in (see `rawResourceFitsPlacement`
   * in `buildImageExtraction.ts`). A resource that does not is a texture or a fill used by the
   * composition, not the picture — taking it raw would swap the picture for a strip of paper.
   */
  rawResourceFitsPlacement?: boolean;
  /**
   * Whether the mask of a masked picture lets most of it through (see `MASK_MOSTLY_VISIBLE_FRACTION`
   * in `buildImageExtraction.ts`). A mask that only tilts or trims the picture does; a mask that hides a
   * large part of it is part of what the page shows.
   */
  maskMostlyVisible?: boolean;
  /**
   * Summed page-area share of the OTHER pictures of the unit (everything but the representative). A raw
   * resource shows one picture; if the rest of the unit is more than decoration, the region keeps them.
   */
  coMemberAreaShare?: number;
  /**
   * Whether text lies over the picture itself (a paper note, a newspaper handout). The text is drawn by
   * the page, not stored in the image: the raw resource is the blank paper, the render is what the page shows.
   */
  textOverPicture?: boolean;
}

/**
 * Page-area share of the other pictures of a unit from which they count as content of their own. Measured
 * on a real rulebook: the tape strips, crests and paperclips that sit on a photo add up to at most 4.4% of
 * the page; the units where a second picture would be lost start at 6.2%.
 */
export const CO_MEMBER_SIGNIFICANT_AREA = 0.05;

export function decideExtractionStrategy(input: StrategyInput): StrategyDecision {
  if (input.entry === null) {
    return { strategy: 'region-render', reason: 'Z2-vector-only-no-image' };
  }
  if (input.textOverPicture) {
    return { strategy: 'region-render', reason: 'Z2-text-over-picture-is-content' };
  }
  // A raw resource is one picture. When the unit holds other pictures of consequence, taking the
  // resource would drop them from every list, so the region is rendered.
  const hasSignificantCoMembers = (input.coMemberAreaShare ?? 0) >= CO_MEMBER_SIGNIFICANT_AREA;
  const rawIsCandidate = input.entry.objId !== null && input.rawResourceFitsPlacement === true && (input.isMasked || input.clusterMemberCount > 1);
  if (rawIsCandidate && hasSignificantCoMembers && (input.textCrossesRegionEdge || (input.isMasked && input.maskMostlyVisible))) {
    return { strategy: 'region-render', reason: 'Z2-cluster-has-significant-members' };
  }
  // Rendering the region would put the page's own text into the picture. Where the picture is a
  // raster resource, its raw pixels are the cleaner result — at the price of the mask's shape and of
  // whatever else is drawn over it (a frame, tape, small icons), which is the lesser evil here.
  if (input.textCrossesRegionEdge && rawIsCandidate) {
    return { strategy: 'direct', reason: 'Z2-text-crosses-region-prefer-raw-resource' };
  }
  // A masked picture is often a photo with a tilted or trimmed edge, a frame or a drop shadow around it. The
  // region of such a unit is the axis-aligned box of a tilted shape: it holds the page's background,
  // the margin strip and a neighbor's text. The photo itself is the raw resource, when that resource has
  // the shape of the place it is drawn in.
  if (input.isMasked && input.maskMostlyVisible && rawIsCandidate) {
    return { strategy: 'direct', reason: 'Z2-masked-raw-resource-fits-placement' };
  }
  if (input.isMasked) {
    return { strategy: 'region-render', reason: 'Z2-masked-direct-would-omit-mask' };
  }
  if (input.clusterMemberCount > 1) {
    return { strategy: 'region-render', reason: 'Z2-cluster-composition-is-content' };
  }
  return { strategy: 'direct', reason: 'Z2-single-clean-image' };
}

/**
 * Set of resource `objId`s MASKED by ANY entry with hard mask evidence
 * (`maskEvidence` group/opcode) pointing to them via `masksImageObjId`.
 */
export function computeMaskedObjIds(entries: readonly ImageEntry[]): ReadonlySet<string> {
  const masked = new Set<string>();
  for (const e of entries) {
    if ((e.maskEvidence === 'group' || e.maskEvidence === 'opcode') && e.masksImageObjId) {
      masked.add(e.masksImageObjId);
    }
  }
  return masked;
}

/**
 * Number of DISTINCT entries sharing the same `clusterId` (see
 * `ImageEntry.clusterId`, assigned in step 4 per first occurrence) — entries
 * with no `clusterId` count as solitary (1).
 *
 * [clarification after a full design review — DO NOT confuse with the
 * pipeline's real decision] This is a SIMPLIFIED, single-pass measure over
 * `clusterId` (an early signal from the inventory pass, computed BEFORE
 * filtering to content/undecided). The real `clusterMemberCount` used by
 * `buildImageExtraction.ts` for the actual `direct` vs `region-render`
 * decision comes from that file's COMPLETELY INDEPENDENT, two-stage
 * algorithm. These two numbers CAN differ for the same
 * image. This function exists exclusively for approximate reporting
 * (`tools/calibrate-images.ts`) and is tested as its OWN, isolated unit —
 * do NOT use it to predict/verify the actual extraction strategy of a
 * specific image.
 */
export function computeClusterMemberCounts(entries: readonly ImageEntry[]): ReadonlyMap<ImageEntry, number> {
  const countByClusterId = new Map<string, number>();
  for (const e of entries) {
    if (!e.clusterId) continue;
    countByClusterId.set(e.clusterId, (countByClusterId.get(e.clusterId) ?? 0) + 1);
  }
  const result = new Map<ImageEntry, number>();
  for (const e of entries) {
    result.set(e, e.clusterId ? (countByClusterId.get(e.clusterId) ?? 1) : 1);
  }
  return result;
}
