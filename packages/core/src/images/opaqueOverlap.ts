import type { Rect } from '../geometry.js';

/** A coarse map of where a raster is not transparent: one flag per cell, rows from the top of the raster. */
export interface OpaqueMask {
  width: number;
  height: number;
  opaque: Uint8Array;
  /** For a mask of ink (see `probeInkMask`): the luminance (0-255) of the paper the ink was told from, the median color of the raster's edge. */
  paperLuminance?: number;
}

/** A raster as the page paints it: the box it fills, whether it is mirrored there, and where it is not transparent. */
export interface PlacedMask {
  box: Rect;
  flipX: boolean;
  flipY: boolean;
  mask: OpaqueMask;
}

/** Distance between the points at which two placed masks are compared, in points of the page. */
const SAMPLE_STEP_PT = 1;
/** Number of sample points where both are opaque from which two pictures count as overlapping (a single stray point is the soft edge of a cut-out). */
const MIN_OVERLAP_POINTS = 6;

function opaqueAt(placed: PlacedMask, x: number, y: number): boolean {
  const { box, mask } = placed;
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (w <= 0 || h <= 0) return false;
  let u = (x - box.minX) / w;
  let v = (box.maxY - y) / h;
  if (placed.flipX) u = 1 - u;
  if (placed.flipY) v = 1 - v;
  const cx = Math.min(mask.width - 1, Math.max(0, Math.floor(u * mask.width)));
  const cy = Math.min(mask.height - 1, Math.max(0, Math.floor(v * mask.height)));
  return mask.opaque[cy * mask.width + cx] === 1;
}

/** The number of sample points (one per point of the page) where both placed masks are opaque, and the number where `a` is opaque anywhere in its box. */
export function overlapPointCounts(a: PlacedMask, b: PlacedMask): { shared: number; ofA: number; ofB: number } {
  const count = (placed: PlacedMask, other?: PlacedMask): number => {
    const box = other === undefined ? placed.box : { minX: Math.max(placed.box.minX, other.box.minX), maxX: Math.min(placed.box.maxX, other.box.maxX), minY: Math.max(placed.box.minY, other.box.minY), maxY: Math.min(placed.box.maxY, other.box.maxY) };
    let n = 0;
    for (let y = box.minY + SAMPLE_STEP_PT / 2; y < box.maxY; y += SAMPLE_STEP_PT) for (let x = box.minX + SAMPLE_STEP_PT / 2; x < box.maxX; x += SAMPLE_STEP_PT) if (opaqueAt(placed, x, y) && (other === undefined || opaqueAt(other, x, y))) n++;
    return n;
  };
  return { shared: count(a, b), ofA: count(a), ofB: count(b) };
}

/** Whether the visible pixels of two pictures, as the page paints them, lie over one another anywhere (and not merely their boxes). */
export function placedMasksOverlap(a: PlacedMask, b: PlacedMask): boolean {
  const minX = Math.max(a.box.minX, b.box.minX);
  const maxX = Math.min(a.box.maxX, b.box.maxX);
  const minY = Math.max(a.box.minY, b.box.minY);
  const maxY = Math.min(a.box.maxY, b.box.maxY);
  if (maxX <= minX || maxY <= minY) return false;
  let shared = 0;
  for (let y = minY + SAMPLE_STEP_PT / 2; y < maxY; y += SAMPLE_STEP_PT) {
    for (let x = minX + SAMPLE_STEP_PT / 2; x < maxX; x += SAMPLE_STEP_PT) {
      if (opaqueAt(a, x, y) && opaqueAt(b, x, y) && ++shared >= MIN_OVERLAP_POINTS) return true;
    }
  }
  return false;
}

/** Share of the smaller picture's inked area that two pictures must have in common to overlap: the soft edges of two drawings that stand side by side touch over a fraction of a percent. */
const MIN_INK_OVERLAP_SHARE = 0.015;

/** Whether two drawn pictures (masks of ink, see `probeInkMask`) lie over one another by more than their soft edges. */
export function placedInksOverlap(a: PlacedMask, b: PlacedMask): boolean {
  const { shared, ofA, ofB } = overlapPointCounts(a, b);
  return shared >= MIN_OVERLAP_POINTS && shared >= MIN_INK_OVERLAP_SHARE * Math.min(ofA, ofB);
}

/** Groups indices `0..count-1` by the pairs for which `connected` holds, transitively; groups come out in order of their first index. */
export function connectedGroups(count: number, connected: (i: number, j: number) => boolean): number[][] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!;
    return i;
  };
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) if (find(i) !== find(j) && connected(i, j)) parent[find(j)] = find(i);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()];
}
