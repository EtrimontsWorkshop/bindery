import type { ImageEntry } from '../inventory/imageRegistry.js';

/**
 * Extraction strategy (Step 7 Z2, MDD phase 3). Not every image classified
 * as `content` may be extracted directly — the decision always comes with
 * an explicit justification (`reason`), never a plain `boolean` (per the
 * brief: needed in the report and on the review screen, phase 9).
 *
 * The brief's table has five rows, but only TWO final strategies:
 * - `direct` — only "a single image, no mask, no cluster".
 * - `region-render` — everything else (mask, cluster, no image/vector, transparency over background).
 *
 * Note: "an image with transparency over background" (the table's last row)
 * has no independent signal today that's detectable without decoding the
 * alpha channel — we DELIBERATELY do NOT build a separate mechanism for this
 * (per the brief: don't invest in U5-like gaps). Treated as a subset of "an
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
}

export function decideExtractionStrategy(input: StrategyInput): StrategyDecision {
  if (input.entry === null) {
    return { strategy: 'region-render', reason: 'Z2-vector-only-no-image' };
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
 * algorithm (`groupIntoUnits`/`partitionCandidatesIntoGroups`, based on
 * anchors and an overlap ratio, fixed in Step 16 precisely because
 * `clusterId`-based grouping gave wrong results on
 * `img_p13_*`/`img_p15_*`). These two numbers CAN differ for the same
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
