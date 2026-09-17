import type { Rect } from '../geometry.js';

/**
 * [Bug measured live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] The section boundary
 * (dragged or found geometrically by Y) had no knowledge of columns — on a
 * two-column page, the "geometrically closest" candidate at a chosen height
 * could be a PROSE token FROM THE NEIGHBORING COLUMN, rather than the header
 * ending the section in its OWN column. The reporter explicitly confirmed this is
 * NOT the narrow "two characters side by side" case (deferred as O5 in step 29) — it applies to
 * EVERY two-column page, i.e. the norm in RPG rulebooks.
 *
 * `findColumnBand` determines the X band (ONLY the horizontal axis — columns in these
 * layouts run the full height of the page, so Y is irrelevant) of the column
 * containing a given token, using an interval-merging method: each token is an
 * interval `[minX, maxX]`, intervals that touch or overlap are
 * merged into groups — the "column" is the group containing the target. On a
 * SINGLE-COLUMN page, all text merges into ONE group (full content width) —
 * zero behavior change for single-column layouts (both of this project's reference
 * profiles).
 *
 * The assumption that makes this heuristic reliable (confirmed on a real
 * sample): every real column contains AT LEAST one token
 * (typically a long line of prose — an attack description, a skills list, a monster
 * description) wide enough to BRIDGE the larger gaps between narrow tokens in the same
 * column (e.g. single attribute-grid labels like "STR ... CON ... LUCK" have
 * gaps between them wider than normal word spacing) — without such a "bridge" that
 * same column could incorrectly split into several groups. RPG statblocks almost
 * always have at least one such line (attack/skills description) in the same
 * column as the grid, so the assumption holds in practice.
 */
export interface ColumnBandToken {
  bbox: Rect;
}

export interface ColumnBand {
  minX: number;
  maxX: number;
}

export function findColumnBand(tokens: readonly ColumnBandToken[], targetBbox: Rect): ColumnBand | null {
  if (tokens.length === 0) return null;
  const intervals = tokens.map((t) => ({ minX: t.bbox.minX, maxX: t.bbox.maxX })).sort((a, b) => a.minX - b.minX);

  const groups: ColumnBand[] = [];
  for (const iv of intervals) {
    const last = groups.at(-1);
    if (last && iv.minX <= last.maxX) {
      last.maxX = Math.max(last.maxX, iv.maxX);
    } else {
      groups.push({ minX: iv.minX, maxX: iv.maxX });
    }
  }

  const targetCenter = (targetBbox.minX + targetBbox.maxX) / 2;
  return groups.find((g) => targetCenter >= g.minX && targetCenter <= g.maxX) ?? null;
}

/** Whether `bbox` lies (by its center) inside the `band` — a `null` band (e.g. no tokens on the page) NEVER rejects; a safe no-op instead of a false rejection. */
export function isWithinColumnBand(bbox: Rect, band: ColumnBand | null): boolean {
  if (!band) return true;
  const center = (bbox.minX + bbox.maxX) / 2;
  return center >= band.minX && center <= band.maxX;
}
