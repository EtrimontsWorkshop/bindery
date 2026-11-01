import type { DecodedImage } from './normalizeDecodedImage.js';

/** Width every raster is measured at. */
const MEASURE_WIDTH = 384;
/** A pixel is on an edge when the brightness changes by more than this across it (both directions summed). */
const EDGE_STEP = 40;
/** A cell: a flat region of this many pixels that fills at least this share of its bounding box and is about as wide as it is high. */
const CELL_MIN_AREA = 40;
const CELL_MIN_SIDE = 6;
const CELL_MIN_FILL = 0.8;
const CELL_MIN_ASPECT = 0.6;
const CELL_MAX_ASPECT = 1.7;
/** A cell larger than this share of the raster is a background, not a box. */
const CELL_MAX_AREA_SHARE = 0.2;
/** Cells of one size: each side within this share (and at least two pixels) of the first one's. */
const SAME_SIZE_TOLERANCE = 0.12;

/**
 * A track of boxes (stress, wounds, a row of tick boxes) is a few dozen boxes of one size filling a quarter of a picture. Measured on 2200
 * pictures from nine books: the two tracks have 20 such cells covering 0.24 of the picture. The pictures that look alike are a battle map under a
 * grid (23 cells covering 0.10) or a plan on graph paper (553 covering 0.52); both lie outside these bounds, as does everything else with 8 or more.
 */
const TRACK_MIN_CELLS = 16;
const TRACK_MAX_CELLS = 60;
const TRACK_MIN_AREA_SHARE = 0.2;
const TRACK_MAX_AREA_SHARE = 0.6;

export interface BoxGridMeasure {
  /** How many cells share the most common size. */
  cells: number;
  /** The share of the raster those cells cover. */
  areaShare: number;
}

export function measureBoxGrid(image: DecodedImage): BoxGridMeasure | null {
  if (image.width < 120 || image.height < 16) return null;
  const W = MEASURE_WIDTH;
  const H = Math.max(8, Math.round((image.height * W) / image.width));
  const { rgba } = image;
  const grey = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / W));
      const i = (sy * image.width + sx) * 4;
      const a = rgba[i + 3]! / 255;
      grey[y * W + x] = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * a + 255 * (1 - a);
    }
  }
  const edge = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (Math.abs(grey[i + 1]! - grey[i - 1]!) + Math.abs(grey[i + W]! - grey[i - W]!) > EDGE_STEP) edge[i] = 1;
    }
  }

  const total = W * H;
  const seen = new Uint8Array(total);
  const stack: number[] = [];
  const cells: { width: number; height: number; area: number }[] = [];
  for (let start = 0; start < total; start++) {
    if (edge[start] || seen[start]) continue;
    let area = 0;
    let minX = W;
    let maxX = 0;
    let minY = H;
    let maxY = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      area++;
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !edge[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && !edge[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (p >= W && !edge[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (p < total - W && !edge[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const aspect = width / height;
    if (area < CELL_MIN_AREA || width < CELL_MIN_SIDE || height < CELL_MIN_SIDE || area / (width * height) < CELL_MIN_FILL) continue;
    if (aspect < CELL_MIN_ASPECT || aspect > CELL_MAX_ASPECT || area > total * CELL_MAX_AREA_SHARE) continue;
    cells.push({ width, height, area });
  }

  let best: BoxGridMeasure = { cells: 0, areaShare: 0 };
  for (const a of cells) {
    let count = 0;
    let areaSum = 0;
    for (const b of cells) {
      if (Math.abs(b.width - a.width) > Math.max(2, a.width * SAME_SIZE_TOLERANCE) || Math.abs(b.height - a.height) > Math.max(2, a.height * SAME_SIZE_TOLERANCE)) continue;
      count++;
      areaSum += b.area;
    }
    if (count > best.cells) best = { cells: count, areaShare: areaSum / total };
  }
  return best;
}

export function looksLikeTrackOfBoxes(image: DecodedImage): boolean {
  const m = measureBoxGrid(image);
  return m !== null && m.cells >= TRACK_MIN_CELLS && m.cells <= TRACK_MAX_CELLS && m.areaShare >= TRACK_MIN_AREA_SHARE && m.areaShare <= TRACK_MAX_AREA_SHARE;
}
