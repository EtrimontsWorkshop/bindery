import type { Rect } from '../geometry.js';
import { rectArea } from '../geometry.js';

/**
 * A drawing made of vector paths (a cartoon figure, an icon set, a diagram) is not an image of the PDF: there is no raster to take, and the
 * only way to offer it is to render the part of the page it covers. Such a drawing is found as a cluster of many filled paths that lie close
 * together and fill the box they make.
 */

/** A shape is joined with the ones that come within this many points of it. */
const CLUSTER_GAP_PT = 3;
/** A cluster of fewer shapes is a bullet, a flourish or a letter, not a drawing. */
const MIN_SHAPES = 15;
/** A cluster smaller than this (either side, in points) is an icon. */
const MIN_SIDE_PT = 30;
/** Share of the page that the box of a drawing covers: from a figure to a big diagram; more is a backdrop. */
const MIN_PAGE_SHARE = 0.01;
const MAX_PAGE_SHARE = 0.5;
/** The boxes of the shapes of a drawing add up to this share of its box at least (a scatter of specks does not): they overlap, so the sum may exceed 1. */
const MIN_FILL = 0.3;
/** A cluster wider than this share of the page is the width of a text column or more: a table, a banner, not a figure. */
const MAX_WIDTH_SHARE = 0.78;
/** A cluster longer than this many times its width (a table, a header plate, a line of digits) is not a drawing. */
const MAX_ASPECT = 5;
/** A shape this large is a backdrop or a frame and joins nothing. */
const MAX_SHAPE_PAGE_SHARE = 0.25;
/** A shape thinner than this (both sides, in points) is a hairline or a dot. */
const MIN_SHAPE_SIDE_PT = 0.5;
const GRID_CELL_PT = 16;

export interface FigureShape {
  bbox: Rect;
}

export interface VectorFigure {
  bbox: Rect;
  shapeCount: number;
  /** The boxes of the shapes the drawing is made of. */
  shapeBoxes: Rect[];
}

/** The drawings of one page: clusters of its shapes that look like one (see the thresholds above). */
export function findVectorFigures(shapes: readonly FigureShape[], pageBox: Rect): VectorFigure[] {
  const pageArea = rectArea(pageBox);
  if (pageArea <= 0) return [];
  const usable = shapes.filter((s) => {
    const w = s.bbox.maxX - s.bbox.minX;
    const h = s.bbox.maxY - s.bbox.minY;
    return Math.max(w, h) >= MIN_SHAPE_SIDE_PT && (w * h) / pageArea <= MAX_SHAPE_PAGE_SHARE;
  });
  if (usable.length < MIN_SHAPES) return [];

  // Union-find over the shapes that touch (within the gap), found through a grid of cells.
  const parent = usable.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    for (let cur = i; parent[cur] !== root; ) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const cells = new Map<string, number[]>();
  usable.forEach((s, i) => {
    const x0 = Math.floor((s.bbox.minX - CLUSTER_GAP_PT) / GRID_CELL_PT);
    const x1 = Math.floor((s.bbox.maxX + CLUSTER_GAP_PT) / GRID_CELL_PT);
    const y0 = Math.floor((s.bbox.minY - CLUSTER_GAP_PT) / GRID_CELL_PT);
    const y1 = Math.floor((s.bbox.maxY + CLUSTER_GAP_PT) / GRID_CELL_PT);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        const bucket = cells.get(key);
        if (bucket === undefined) {
          cells.set(key, [i]);
          continue;
        }
        for (const j of bucket) {
          const other = usable[j]!.bbox;
          if (s.bbox.minX - CLUSTER_GAP_PT <= other.maxX && other.minX - CLUSTER_GAP_PT <= s.bbox.maxX && s.bbox.minY - CLUSTER_GAP_PT <= other.maxY && other.minY - CLUSTER_GAP_PT <= s.bbox.maxY) {
            const a = find(i);
            const b = find(j);
            if (a !== b) parent[a] = b;
          }
        }
        bucket.push(i);
      }
    }
  });

  const clusters = new Map<number, { bbox: Rect; count: number; shapeArea: number; boxes: Rect[] }>();
  usable.forEach((s, i) => {
    const root = find(i);
    const area = (s.bbox.maxX - s.bbox.minX) * (s.bbox.maxY - s.bbox.minY);
    const c = clusters.get(root);
    if (c === undefined) {
      clusters.set(root, { bbox: { ...s.bbox }, count: 1, shapeArea: area, boxes: [s.bbox] });
      return;
    }
    c.boxes.push(s.bbox);
    c.bbox = { minX: Math.min(c.bbox.minX, s.bbox.minX), minY: Math.min(c.bbox.minY, s.bbox.minY), maxX: Math.max(c.bbox.maxX, s.bbox.maxX), maxY: Math.max(c.bbox.maxY, s.bbox.maxY) };
    c.count++;
    c.shapeArea += area;
  });

  const figures: VectorFigure[] = [];
  for (const c of clusters.values()) {
    const w = c.bbox.maxX - c.bbox.minX;
    const h = c.bbox.maxY - c.bbox.minY;
    const share = (w * h) / pageArea;
    if (c.count < MIN_SHAPES || Math.min(w, h) < MIN_SIDE_PT || share < MIN_PAGE_SHARE || share > MAX_PAGE_SHARE) continue;
    if (Math.max(w, h) / Math.min(w, h) > MAX_ASPECT || w / (pageBox.maxX - pageBox.minX) > MAX_WIDTH_SHARE) continue;
    if (c.shapeArea / (w * h) < MIN_FILL) continue;
    figures.push({ bbox: c.bbox, shapeCount: c.count, shapeBoxes: c.boxes });
  }
  return figures.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
}
