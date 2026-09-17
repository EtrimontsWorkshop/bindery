import { clusterByOverlap } from '../clustering.js';
import { groupByQuantizedPosition } from '../collections.js';
import type { Rect } from '../geometry.js';
import { overlapRatio, relativeArea as computeRelativeArea } from '../geometry.js';
import type { WalkEvent } from './walkOperators.js';

/**
 * Image registry — objId -> occurrences across pages, mask evidence, cluster
 * (MDD phase 3, F0 Q2/Q3, Step 4 Z3). Content/decoration classification
 * BELONGS TO PHASE 3 — this module only collects facts (pageRefs,
 * maskEvidence, clusterId), it never decides.
 */

/**
 * Three independent evidence paths for a mask — each individually has a gap:
 * - 'group'    — the image is inside a beginGroup/Luminosity. Strongest evidence, trust unconditionally.
 * - 'opcode'   — paintImageMaskXObject (83). Unambiguous by the PDF format's own definition.
 * - 'geometry' — the bbox overlaps >=95% with an image drawn at index<=3 earlier.
 *                Weak evidence (could also be an ordinary duplicate) — never collapse to a boolean.
 */
export type MaskEvidence = 'group' | 'opcode' | 'geometry' | null;

export interface ImageOccurrence {
  page: number;
  bbox: Rect;
  index: number;
}

export interface ImageEntry {
  objId: string | null;
  /** The same resource may be drawn multiple times (on one or several pages). */
  occurrences: ImageOccurrence[];
  /** Unique page numbers. */
  pageRefs: number[];
  /** The largest bbox/page-area ratio across all occurrences. */
  maxRelativeArea: number;
  isMaskLayer: boolean;
  maskEvidence: MaskEvidence;
  masksImageObjId?: string;
  clusterId?: string;
  /**
   * [Step 16 Z1] Intrinsic resolution from the FIRST occurrence that carries
   * it (see `WalkEvent['image'].intrinsicWidth/Height`). `null` when no
   * opcode in this entry supplied it (repeat/inline). Used as an additional
   * key component in `correlateImagesByBBox` — two different images in the
   * same page frame almost certainly have different resource resolution,
   * despite an identical bbox on the page.
   */
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
  /**
   * [Step 5 Z6, debt from Step 4] The `objId` of another entry that this
   * entry got POSITIONALLY LINKED to (quantized bbox, see
   * `correlateImagesByBBox`) — most likely the SAME PDF resource that pdf.js
   * split into separate entries because it doesn't assign a stable objId
   * from the first use (RAPORT-KROK-4.md). Does NOT overwrite `pageRefs` —
   * this is a separate, explicit correlation fact, not an identity change;
   * classifying what to do about it belongs to phase 3.
   */
  correlatedWith?: string;
}

const OPCODE_PAINT_IMAGE_MASK_XOBJECT = 83;
const GEOMETRY_OVERLAP_THRESHOLD = 0.95;
const GEOMETRY_INDEX_WINDOW = 3;

interface RawOccurrence extends ImageOccurrence {
  objId: string | null;
  opcode: number;
  groupSubtype: string | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
}

/** Input: 'image' events from walkOperators for ONE page, in occurrence order. */
export interface PageImageEvents {
  page: number;
  pageBox: Rect;
  events: readonly WalkEvent[];
}

function collectRawOccurrences(pages: readonly PageImageEvents[]): { page: number; occ: RawOccurrence }[] {
  const all: { page: number; occ: RawOccurrence }[] = [];
  for (const { page, events } of pages) {
    for (const e of events) {
      if (e.type !== 'image') continue;
      all.push({
        page,
        occ: {
          page,
          bbox: e.bbox,
          index: e.index,
          objId: e.objId,
          opcode: e.opcode,
          groupSubtype: e.inGroup?.subtype ?? null,
          intrinsicWidth: e.intrinsicWidth,
          intrinsicHeight: e.intrinsicHeight,
        },
      });
    }
  }
  return all;
}


/**
 * How many subsequent occurrences ON THE SAME PAGE to search when looking
 * for content drawn UNDER a mask (evidence 'group'/'opcode') — between the
 * mask group's close and the actual painting of the masked content, several
 * other, unrelated operators can occur (e.g. `setGState`), so it isn't
 * always literally the NEXT element.
 */
const GROUP_MASK_SEARCH_WINDOW = 5;

/**
 * [Step 7, discovery] `masksImageObjId` used to be set SOLELY by the
 * 'geometry' path (the weakest evidence) — the 'group'/'opcode' paths (the
 * STRONGEST evidence) never recorded WHICH image is masked, because
 * `beginGroup` wraps SOLELY the mask form's own content (MDD), not the
 * masked image — there is no direct link in the operator list. Without this
 * fix, Z2 (extraction strategy, step 7) never detected `isMasked=true` for
 * the MOST CERTAIN mask case (an explicit `beginGroup`/`Luminosity`), only
 * for the weakest one. The fix: a geometric match (like the 'geometry'
 * path), but searching FORWARD (content is painted AFTER the mask group
 * closes, not before) — the mask form's bbox (after the CTM fix from Z4, see
 * walkOperators.ts) overlaps the masked content's bbox, because both inherit
 * the same external `cm` matrix at the moment `gs` is invoked.
 */
function findMaskedContentObjId(occurrences: readonly RawOccurrence[], indices: readonly number[], pos: number, maskOcc: RawOccurrence): string | undefined {
  for (let fwd = 1; fwd <= GROUP_MASK_SEARCH_WINDOW; fwd++) {
    const nextPos = pos + fwd;
    if (nextPos >= indices.length) break;
    const nextOcc = occurrences[indices[nextPos]!]!;
    if (nextOcc.objId === maskOcc.objId) continue;
    if (overlapRatio(nextOcc.bbox, maskOcc.bbox) >= GEOMETRY_OVERLAP_THRESHOLD) return nextOcc.objId ?? undefined;
  }
  return undefined;
}

/** Detects mask evidence for each occurrence (paths group/opcode/geometry, in that order of strength). */
function detectMaskEvidence(
  occurrences: readonly RawOccurrence[],
): { evidence: MaskEvidence; masksObjId?: string }[] {
  const results: { evidence: MaskEvidence; masksObjId?: string }[] = occurrences.map(() => ({ evidence: null }));

  // Group indices per page, in ascending `index` order — needed for the geometry path.
  const byPage = new Map<number, number[]>();
  occurrences.forEach((o, i) => {
    const arr = byPage.get(o.page) ?? [];
    arr.push(i);
    byPage.set(o.page, arr);
  });
  for (const indices of byPage.values()) {
    indices.sort((a, b) => occurrences[a]!.index - occurrences[b]!.index);
  }

  for (const [, indices] of byPage) {
    for (let pos = 0; pos < indices.length; pos++) {
      const i = indices[pos]!;
      const occ = occurrences[i]!;

      // Path 1 — group (strongest evidence).
      if (occ.groupSubtype === 'Luminosity') {
        results[i] = { evidence: 'group', masksObjId: findMaskedContentObjId(occurrences, indices, pos, occ) };
        continue;
      }
      // Path 2 — opcode (unambiguous).
      if (occ.opcode === OPCODE_PAINT_IMAGE_MASK_XOBJECT) {
        results[i] = { evidence: 'opcode', masksObjId: findMaskedContentObjId(occurrences, indices, pos, occ) };
        continue;
      }
      // Path 3 — geometry (weak evidence): an image drawn index<=3 EARLIER on
      // the same page with a bbox that overlaps >=95%.
      for (let back = 1; back <= GEOMETRY_INDEX_WINDOW; back++) {
        const prevPos = pos - back;
        if (prevPos < 0) break;
        const prevIdx = indices[prevPos]!;
        const prevOcc = occurrences[prevIdx]!;
        if (occ.index - prevOcc.index > GEOMETRY_INDEX_WINDOW) break;
        if (overlapRatio(occ.bbox, prevOcc.bbox) >= GEOMETRY_OVERLAP_THRESHOLD) {
          results[i] = { evidence: 'geometry', masksObjId: prevOcc.objId ?? undefined };
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Builds the image registry from `walkOperators` events collected from ALL
 * pages of the document. Zero image decoding — purely geometric/structural facts.
 */
export function buildImageEntries(pages: readonly PageImageEvents[]): ImageEntry[] {
  const rawList = collectRawOccurrences(pages);
  const occurrences = rawList.map((r) => r.occ);
  const clusterIdByOccurrence = clusterByOverlap(
    occurrences,
    (o) => o.page,
    (o) => o.bbox,
  );
  const maskInfo = detectMaskEvidence(occurrences);
  const pageBoxByPage = new Map(pages.map((p) => [p.page, p.pageBox]));

  // Grouping key: objId when available; otherwise each inline occurrence is
  // its own separate entry (no object reference to correlate by).
  const entriesByKey = new Map<string, ImageEntry>();
  let inlineCounter = 0;

  occurrences.forEach((occ, i) => {
    const key = occ.objId ?? `__inline_${inlineCounter++}__`;
    let entry = entriesByKey.get(key);
    if (!entry) {
      entry = {
        objId: occ.objId,
        occurrences: [],
        pageRefs: [],
        maxRelativeArea: 0,
        isMaskLayer: false,
        maskEvidence: null,
        intrinsicWidth: null,
        intrinsicHeight: null,
      };
      entriesByKey.set(key, entry);
    }

    entry.occurrences.push({ page: occ.page, bbox: occ.bbox, index: occ.index });

    // The first occurrence carrying the intrinsic resolution is enough — the
    // same objId always refers to the same resource, so later occurrences
    // carry (incidentally) the same value.
    if (entry.intrinsicWidth === null && occ.intrinsicWidth !== null) entry.intrinsicWidth = occ.intrinsicWidth;
    if (entry.intrinsicHeight === null && occ.intrinsicHeight !== null) entry.intrinsicHeight = occ.intrinsicHeight;

    const pageBox = pageBoxByPage.get(occ.page);
    if (pageBox) {
      const ra = computeRelativeArea(occ.bbox, pageBox);
      if (ra > entry.maxRelativeArea) entry.maxRelativeArea = ra;
    }

    const evidence = maskInfo[i]!;
    // 'group' > 'opcode' > 'geometry' > null — if the entry already has stronger
    // evidence from another occurrence, don't overwrite it with weaker evidence.
    const strength: Record<Exclude<MaskEvidence, null>, number> = { group: 3, opcode: 2, geometry: 1 };
    const currentStrength = entry.maskEvidence ? strength[entry.maskEvidence] : 0;
    const newStrength = evidence.evidence ? strength[evidence.evidence] : 0;
    if (newStrength > currentStrength) {
      entry.maskEvidence = evidence.evidence;
      entry.isMaskLayer = evidence.evidence === 'group' || evidence.evidence === 'opcode';
      if (evidence.masksObjId) entry.masksImageObjId = evidence.masksObjId;
    }

    if (!entry.clusterId) entry.clusterId = clusterIdByOccurrence.get(occ);
  });

  for (const entry of entriesByKey.values()) {
    entry.pageRefs = [...new Set(entry.occurrences.map((o) => o.page))].sort((a, b) => a - b);
  }

  const sorted = [...entriesByKey.values()].sort((a, b) => (a.objId ?? '').localeCompare(b.objId ?? ''));
  return correlateImagesByBBox(sorted);
}

/** Quantization to 0.5pt — running headers/footers/frames are static by definition, so small rounding noise is the only tolerance needed. */
const CORRELATION_QUANTIZE_PT = 0.5;

function quantize(v: number): number {
  return Math.round(v / CORRELATION_QUANTIZE_PT) * CORRELATION_QUANTIZE_PT;
}

function quantizedBBoxKey(bbox: Rect): string {
  return `${quantize(bbox.minX)}|${quantize(bbox.minY)}|${quantize(bbox.maxX)}|${quantize(bbox.maxY)}`;
}

/**
 * [Step 16 Z1] Intrinsic resolution appended to the key — see the discovery
 * in RAPORT-KROK-15.md (a group of 148 correlated pages mixing
 * useful/fragment/decoration labels). Hypothesis: this isn't one resource
 * repeated 148 times, just a shared FRAME (the same rectangle on the page)
 * with different content inside — positional correlation alone doesn't tell
 * these cases apart. The same PDF resource always has identical intrinsic
 * resolution; different illustrations in the same frame almost never do.
 * Missing data (`null`) is treated as its OWN category (`*x*`), not as "no
 * constraint" — entries without a resolution are correlated only with each
 * other, never with entries that have one, so as not to roll back caution
 * below the state before this change.
 */
function intrinsicSizeKey(entry: ImageEntry): string {
  const w = entry.intrinsicWidth;
  const h = entry.intrinsicHeight;
  return `${w ?? '*'}x${h ?? '*'}`;
}

/**
 * [Step 30, a bug measured live in "Zew Cthulhu 7ed. Wrak.pdf"] An image
 * covering NEARLY THE WHOLE page has a bbox almost IDENTICAL to its OWN
 * page's MediaBox REGARDLESS OF WHAT IT ACTUALLY DEPICTS — unlike a small,
 * SPECIFICALLY positioned element (a corner logo, a divider frame), where
 * "the same position across many pages" is a genuine, surprising signal of
 * shared identity (exactly this function's documented purpose — see the
 * comment below). For a full-bleed page spread, this coincidence is
 * GUARANTEED geometry, not evidence.
 *
 * Measured directly: a unique cover (p. 1, a cosmic-horror giant over a
 * ship) and the SEPARATELY EMBEDDED, completely different textured
 * background of each subsequent page have their OWN, DIFFERENT pixels
 * (visually confirmed), but an IDENTICAL bbox (the whole page) AND even
 * identical intrinsic resolution (exported from a DTP tool to one template
 * canvas size) — without this exclusion, correlation mistook 30 of 35 images
 * in the book for "two repeating resources", driving `content` down to zero
 * across the whole document. Excluded ENTIRELY from this mechanism —
 * correlation remains for smaller, genuinely positioned elements (its
 * documented purpose below). Deduplication of TRULY identical full-page
 * images (that really are the same resource) still works later, in the
 * extraction phase, via `closeCorrelationByHash` (`finalize.ts`) — THAT
 * mechanism compares actual content after decoding, so it doesn't suffer
 * from the same geometric blindness.
 */
const FULL_PAGE_AREA_THRESHOLD = 0.97;

/**
 * Links entries whose FIRST occurrence has an identical (after quantization)
 * bbox AND identical intrinsic resolution — without decoding pixels
 * (Step 5 Z6.2, extended in Step 16 Z1, narrowed in Step 30 — see
 * `FULL_PAGE_AREA_THRESHOLD` above). Zero-decode, so this is still an
 * APPROXIMATION: two different, small icons repeating at the same position
 * AND with the same resolution (e.g. bullet markers) produce a false link —
 * acceptable for headers/footers/frames (this task's purpose), but
 * classifying "is this really the same resource" still belongs to phase 3
 * (cf. `masksImageObjId`, likewise only a suggestion).
 */
export function correlateImagesByBBox(entries: readonly ImageEntry[]): ImageEntry[] {
  const correlatable = entries.filter((entry) => entry.objId !== null && entry.occurrences.length > 0 && entry.maxRelativeArea < FULL_PAGE_AREA_THRESHOLD);
  const groups = groupByQuantizedPosition(
    correlatable,
    (entry) => `${quantizedBBoxKey(entry.occurrences[0]!.bbox)}|${intrinsicSizeKey(entry)}`,
  );

  const canonicalObjIdByObjId = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Canonical = the most occurrences; ties broken by objId (determinism, no dependence on input order).
    const canonical = [...group].sort(
      (a, b) => b.occurrences.length - a.occurrences.length || a.objId!.localeCompare(b.objId!),
    )[0]!;
    for (const entry of group) {
      if (entry.objId !== canonical.objId) canonicalObjIdByObjId.set(entry.objId!, canonical.objId!);
    }
  }

  if (canonicalObjIdByObjId.size === 0) return [...entries];
  return entries.map((entry) => {
    const correlatedWith = entry.objId ? canonicalObjIdByObjId.get(entry.objId) : undefined;
    return correlatedWith ? { ...entry, correlatedWith } : entry;
  });
}
