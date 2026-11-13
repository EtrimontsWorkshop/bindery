import type { Rect } from '../geometry.js';
import { rectArea, rectIntersection } from '../geometry.js';

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
/**
 * A cluster whose shapes run past an edge of the page, and which the page cuts to a band along that edge narrower than
 * this share of the page, is a part of the page's design that bleeds off it (a chapter tab, the edge of a lettered
 * backdrop, the swirl beside a heading), not a drawing. Measured on three books: such bands 37-106 pt wide (0.06-0.25 of
 * the page), the drawings cut by the page's edge 239 pt and wider (0.4 of the page and more).
 */
const EDGE_BAND_MAX_SHARE = 0.3;
/**
 * A cluster whose shapes run past this many edges of the page is the page's design (a swirl in the corner of every page, the band of its
 * margin from top to bottom), however wide. Measured on one book: its corners and margins, 67-166 pt wide, on every page.
 */
const CORNER_MIN_EDGES_PAST = 2;
/** A shape this large is a backdrop or a frame and joins nothing. */
const MAX_SHAPE_PAGE_SHARE = 0.25;
/** A shape thinner than this (both sides, in points) is a hairline or a dot. */
const MIN_SHAPE_SIDE_PT = 0.5;
const GRID_CELL_PT = 16;
/** A shape that holds all the others of its cluster and is this many times the area of their union is a plate the drawing lies on (the patch of paper at a page's corner), not a part of it. */
const BACKDROP_MIN_AREA_RATIO = 2.5;
/** How far (points) the others may stick out of the plate and it still holds them. */
const BACKDROP_HOLD_TOLERANCE_PT = 2;

export interface FigureShape {
  bbox: Rect;
}

export interface VectorFigure {
  bbox: Rect;
  /** The box of the cluster as it was found, with the plate that the drawing lies on (see `withoutBackdrop`); `bbox` is the same without it. What covers the drawing is judged by this box. */
  foundBbox: Rect;
  shapeCount: number;
  /** The boxes of the shapes the drawing is made of. */
  shapeBoxes: Rect[];
}

/** The drawings of one page: clusters of its shapes that look like one (see the thresholds above). */
export function findVectorFigures(shapes: readonly FigureShape[], pageBox: Rect): VectorFigure[] {
  const pageArea = rectArea(pageBox);
  if (pageArea <= 0) return [];
  // Only what lies on the page is drawn: a shape off it (a part of a spread's design left past the page's edge) is not seen, and one across its edge is seen up to it.
  const onPage: { bbox: Rect; whole: Rect }[] = [];
  for (const s of shapes) {
    const bbox = rectIntersection(s.bbox, pageBox);
    if (bbox !== null && bbox.maxX > bbox.minX && bbox.maxY > bbox.minY) onPage.push({ bbox, whole: s.bbox });
  }
  const usable = onPage.filter((s) => {
    const w = s.bbox.maxX - s.bbox.minX;
    const h = s.bbox.maxY - s.bbox.minY;
    return Math.max(w, h) >= MIN_SHAPE_SIDE_PT && (w * h) / pageArea <= MAX_SHAPE_PAGE_SHARE;
  });
  if (usable.length < MIN_SHAPES) return [];

  const clusters = clusterTouching(usable, pageBox);
  const figures: VectorFigure[] = [];
  for (const cluster of clusters) {
    const c = withoutBackdrop(cluster);
    const w = c.bbox.maxX - c.bbox.minX;
    const h = c.bbox.maxY - c.bbox.minY;
    const share = (w * h) / pageArea;
    // How much of the page a drawing is is judged by the cluster as it was found, with its plate: the crop to the drawing is a refinement of it, not a smaller drawing.
    const foundShare = rectArea(cluster.bbox) / pageArea;
    if (c.count < MIN_SHAPES || Math.min(w, h) < MIN_SIDE_PT || foundShare < MIN_PAGE_SHARE || share > MAX_PAGE_SHARE) continue;
    if (Math.max(w, h) / Math.min(w, h) > MAX_ASPECT || w / (pageBox.maxX - pageBox.minX) > MAX_WIDTH_SHARE) continue;
    if (c.shapeArea / (w * h) < MIN_FILL) continue;
    // A strip of the page's design running past its edge (a tab, the bleed of a backdrop), cut by the page to a narrow band along that edge.
    const pageW = pageBox.maxX - pageBox.minX;
    const pageH = pageBox.maxY - pageBox.minY;
    const bandAtEdge =
      (cluster.past.has('left') && cluster.bbox.maxX - pageBox.minX < EDGE_BAND_MAX_SHARE * pageW) ||
      (cluster.past.has('right') && pageBox.maxX - cluster.bbox.minX < EDGE_BAND_MAX_SHARE * pageW) ||
      (cluster.past.has('bottom') && cluster.bbox.maxY - pageBox.minY < EDGE_BAND_MAX_SHARE * pageH) ||
      (cluster.past.has('top') && pageBox.maxY - cluster.bbox.minY < EDGE_BAND_MAX_SHARE * pageH);
    if (bandAtEdge) continue;
    // A cluster that runs past two edges of the page (an ornament in its corner, a band down the whole of its margin) is the page's design.
    if (cluster.past.size >= CORNER_MIN_EDGES_PAST) continue;
    figures.push({ bbox: c.bbox, foundBbox: cluster.bbox, shapeCount: c.count, shapeBoxes: c.boxes });
  }
  return figures.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
}

/** A cluster of boxes that touch one another (within `CLUSTER_GAP_PT`): its box, the sum of their areas, the edges of the page they run past. */
interface TouchingCluster {
  bbox: Rect;
  count: number;
  shapeArea: number;
  past: Set<string>;
  boxes: Rect[];
}

/** The clusters of `boxes` that touch (within the gap), by union-find through a grid of cells. */
function clusterTouching(boxes: readonly { bbox: Rect; whole?: Rect }[], pageBox: Rect): TouchingCluster[] {
  const parent = boxes.map((_, i) => i);
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
  boxes.forEach((s, i) => {
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
          const other = boxes[j]!.bbox;
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
  const clusters = new Map<number, TouchingCluster>();
  boxes.forEach((s, i) => {
    const root = find(i);
    const area = (s.bbox.maxX - s.bbox.minX) * (s.bbox.maxY - s.bbox.minY);
    const past = edgesPast(s.whole ?? s.bbox, pageBox);
    const c = clusters.get(root);
    if (c === undefined) {
      clusters.set(root, { bbox: { ...s.bbox }, count: 1, shapeArea: area, past, boxes: [s.bbox] });
      return;
    }
    c.boxes.push(s.bbox);
    c.bbox = { minX: Math.min(c.bbox.minX, s.bbox.minX), minY: Math.min(c.bbox.minY, s.bbox.minY), maxX: Math.max(c.bbox.maxX, s.bbox.maxX), maxY: Math.max(c.bbox.maxY, s.bbox.maxY) };
    c.count++;
    c.shapeArea += area;
    for (const edge of past) c.past.add(edge);
  });
  return [...clusters.values()];
}

/** A line drawing has at least this many lines (the walls of a floor plan, the strokes of an elevation); fewer are a frame, a rule, an ornament. */
const LINE_DRAWING_MIN_LINES = 40;
/** ...and is at least this big, on each side (points). */
const LINE_DRAWING_MIN_SIDE_PT = 60;
/** A straight line along an axis (thinner than this) at least this long is a rule of the layout's frame or grid, not a line of a drawing. */
const RULE_MAX_THICKNESS_PT = 0.5;
const RULE_MIN_LENGTH_PT = 100;
/** A line with less than this share of its box on the page is left out (see `findLineDrawings`). */
const LINE_MIN_ON_PAGE_SHARE = 0.5;

/** A line drawing: its box and the boxes of its lines. */
export interface LineDrawing {
  bbox: Rect;
  lines: Rect[];
}

/**
 * The drawings of a page made of stroked lines (a floor plan, the elevation of a building): clusters of its lines that
 * touch, with many lines, big enough. The lines are cut to the page (see `findVectorFigures`); the rules of the layout's
 * frame and the lines mostly past the page's edge are left out, as they would join the drawings they pass.
 */
export function findLineDrawings(lines: readonly FigureShape[], pageBox: Rect): LineDrawing[] {
  const onPage: { bbox: Rect; whole: Rect }[] = [];
  for (const l of lines) {
    const bbox = rectIntersection(l.bbox, pageBox);
    if (bbox === null || (bbox.maxX <= bbox.minX && bbox.maxY <= bbox.minY)) continue;
    // A line mostly past the page's edge belongs to what the page does not show (a drawing left on the pasteboard): cut at the edge, it would join the drawings along it.
    const span = (r: Rect): number => Math.max(r.maxX - r.minX, 0.01) * Math.max(r.maxY - r.minY, 0.01);
    if (span(bbox) < LINE_MIN_ON_PAGE_SHARE * span(l.bbox)) continue;
    // A long straight rule along the axes is a line of the layout's frame or grid: it would join every drawing it passes.
    const w = bbox.maxX - bbox.minX;
    const h = bbox.maxY - bbox.minY;
    if (Math.min(w, h) < RULE_MAX_THICKNESS_PT && Math.max(w, h) >= RULE_MIN_LENGTH_PT) continue;
    onPage.push({ bbox, whole: l.bbox });
  }
  if (onPage.length < LINE_DRAWING_MIN_LINES) return [];
  return clusterTouching(onPage, pageBox)
    .filter((c) => c.count >= LINE_DRAWING_MIN_LINES && c.bbox.maxX - c.bbox.minX >= LINE_DRAWING_MIN_SIDE_PT && c.bbox.maxY - c.bbox.minY >= LINE_DRAWING_MIN_SIDE_PT)
    .map((c) => ({ bbox: c.bbox, lines: c.boxes }))
    .sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
}

/** The edges of the page that `box` runs past. */
function edgesPast(box: Rect, pageBox: Rect): Set<string> {
  const edges = new Set<string>();
  if (box.minX < pageBox.minX) edges.add('left');
  if (box.maxX > pageBox.maxX) edges.add('right');
  if (box.minY < pageBox.minY) edges.add('bottom');
  if (box.maxY > pageBox.maxY) edges.add('top');
  return edges;
}

interface Cluster {
  bbox: Rect;
  count: number;
  shapeArea: number;
  boxes: Rect[];
}

/** `cluster` without the plate that its other shapes lie on, when it has one (see `BACKDROP_MIN_AREA_RATIO`); the cluster as it was otherwise. */
function withoutBackdrop(cluster: Cluster): Cluster {
  if (cluster.boxes.length < 2) return cluster;
  let largest = 0;
  for (let i = 1; i < cluster.boxes.length; i++) if (rectArea(cluster.boxes[i]!) > rectArea(cluster.boxes[largest]!)) largest = i;
  const plate = cluster.boxes[largest]!;
  const others = cluster.boxes.filter((_, i) => i !== largest);
  const union = others.reduce((acc, b) => ({ minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) }), others[0]!);
  const holds = union.minX >= plate.minX - BACKDROP_HOLD_TOLERANCE_PT && union.minY >= plate.minY - BACKDROP_HOLD_TOLERANCE_PT && union.maxX <= plate.maxX + BACKDROP_HOLD_TOLERANCE_PT && union.maxY <= plate.maxY + BACKDROP_HOLD_TOLERANCE_PT;
  if (!holds || rectArea(plate) < BACKDROP_MIN_AREA_RATIO * rectArea(union)) return cluster;
  return { bbox: union, count: others.length, shapeArea: cluster.shapeArea - rectArea(plate), boxes: others };
}

/** Rules of one frame end within this many points of one another; a frame is at least this tall and this share of the page wide. */
const FRAME_ALIGN_PT = 3;
const FRAME_MIN_HEIGHT_PT = 100;
const FRAME_MIN_WIDTH_SHARE = 0.5;
/** ...and a rule of the frame may run on past one of its sides by this many points (a header's rule). */
const FRAME_END_TOLERANCE_PT = 25;

/**
 * The frame of rules a page draws around a card (a record card of a handout, cut out along its frame): horizontal rules
 * of one width, at its top and bottom at least, between two vertical rules at their ends. The largest such box, or
 * `null`. Rules are the straight lines along the axes at least `RULE_MIN_LENGTH_PT` long.
 */
export function findRuleFrame(lines: readonly FigureShape[], pageBox: Rect): Rect | null {
  // Cut to the page; a rule has no thickness, so its box may be a segment.
  const rules = lines
    .map((l) => ({ minX: Math.max(l.bbox.minX, pageBox.minX), minY: Math.max(l.bbox.minY, pageBox.minY), maxX: Math.min(l.bbox.maxX, pageBox.maxX), maxY: Math.min(l.bbox.maxY, pageBox.maxY) }))
    .filter((b) => b.maxX >= b.minX && b.maxY >= b.minY);
  const horizontal = rules.filter((b) => b.maxY - b.minY < RULE_MAX_THICKNESS_PT && b.maxX - b.minX >= RULE_MIN_LENGTH_PT);
  const vertical = rules.filter((b) => b.maxX - b.minX < RULE_MAX_THICKNESS_PT && b.maxY - b.minY >= RULE_MIN_LENGTH_PT);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= FRAME_ALIGN_PT;
  let best: Rect | null = null;
  for (const h of horizontal) {
    if (h.maxX - h.minX < FRAME_MIN_WIDTH_SHARE * (pageBox.maxX - pageBox.minX)) continue;
    // A rule of the frame starts or ends with the others (a header rule may run on past the frame's far side).
    const row = horizontal.filter((o) => (near(o.minX, h.minX) && Math.abs(o.maxX - h.maxX) <= FRAME_END_TOLERANCE_PT) || (near(o.maxX, h.maxX) && Math.abs(o.minX - h.minX) <= FRAME_END_TOLERANCE_PT));
    const minY = Math.min(...row.map((o) => o.minY));
    const maxY = Math.max(...row.map((o) => o.maxY));
    if (maxY - minY < FRAME_MIN_HEIGHT_PT) continue;
    const side = (x: number): boolean => vertical.some((v) => near(v.minX, x) && v.minY <= minY + FRAME_ALIGN_PT && v.maxY >= maxY - FRAME_ALIGN_PT);
    if (!side(h.minX) || !side(h.maxX)) continue;
    const frame = { minX: h.minX, minY, maxX: h.maxX, maxY };
    if (best === null || rectArea(frame) > rectArea(best)) best = frame;
  }
  return best;
}
