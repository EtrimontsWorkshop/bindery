import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Pictures painted into a page's own raster. Some books store a page as ONE image: the paper, the ornamental frame of
 * the book, and on it a map, a photograph or two. The PDF has no separate picture to take, so all the analysis could
 * offer was the whole page — the map with its paper and frame around it, or two pictures as one. Measured on twenty
 * books with every picture labelled: 48 of the 56 pictures that were wanted but taken wrongly were of this kind.
 *
 * What is looked for: a plain ground running round the edge of the raster (the paper), and on it solid regions that are
 * not ground, clear of the raster's edge. Thin things (the lines and ribbons of a frame, a rule, a page number) are not solid and fall away. Each
 * region left is a picture, returned as its rectangle in the raster's pixels.
 *
 * Returns `null` when the raster is not such a page: no plain ground round its edge (a picture that fills the page),
 * nothing solid on it (a blank sheet), too much of it, or something this method cannot cut cleanly (a drawing in line,
 * a picture running off the edge): such a page is left whole, as it was before.
 */

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A raster is the page's own when it is placed over this share of the page at least; only such a raster is searched for pictures. */
export const PAGE_RASTER_MIN_PAGE_SHARE = 0.85;
/** The raster is looked at on a grid of about this many cells along its long edge. */
const GRID_LONG_EDGE = 320;
/** The ground is read from a band this wide round the edge (share of the short edge) ... */
const EDGE_BAND_SHARE = 0.05;
/** ... and is plain when this share of the band is within tolerance of the band's median colour (a frame's lines take a little of it). */
const EDGE_BAND_MIN_PLAIN_SHARE = 0.6;
/**
 * Paper is light. A dark or a strongly coloured edge is the picture's own (a night scene, a sky, a black page with a
 * strip of art): cutting "what is not ground" out of such a page cut pictures in half. The darkest channel of the
 * ground is this at least.
 */
const GROUND_MIN_CHANNEL = 170;
/** How far from the ground's colour (mean difference of the three channels) a cell still is ground. Paper is mottled. */
const GROUND_TOLERANCE = 26;
/** How far from it a cell is ink for telling the book's frame from the drawing: a pale print on the paper round a frame is not. */
const STRONG_INK_TOLERANCE = 60;
/**
 * A drawing in line (a floor plan, an engraving) is mostly ground between its lines: gaps up to this share of the short
 * edge are closed first, so that it is one solid region like a photograph is ...
 */
const CLOSE_GAP_SHARE = 0.03;
/** ... and then anything thinner than this share of the short edge is a line of the frame, not a picture: it is worn away. */
const THIN_SHARE = 0.045;
/** What is solid yet no picture (too small, hollow) may take this share of the raster at most; more, and the page is not understood: left whole. */
const UNEXPLAINED_MAX_SHARE = 0.03;
/** A picture is this share of the raster at least (a coin beside a map is about 1%; a smudge is less) ... */
const PICTURE_MIN_AREA_SHARE = 0.008;
/** ... and is solid: this share of its rectangle at least is not ground (a hollow frame is not). */
const PICTURE_MIN_FILL = 0.55;
/**
 * ... before any gap was closed, too: a drawing in line comes apart into pieces under this method (a floor plan gave six),
 * so a page with one is left whole instead (this share of the rectangle at least is not ground as the raster is).
 */
const PICTURE_MIN_RAW_FILL = 0.4;
/** A picture lies ON the ground: its rectangle keeps this far (share of the short edge) from the raster's edge. One that reaches the edge is the page's own picture. */
const PICTURE_MIN_EDGE_MARGIN_SHARE = 0.025;
/** A row or column at a picture's edge belongs to it while this share of it is not ground. */
const EDGE_ROW_MIN_FILL = 0.5;
/** The pictures found cover this share of the raster at most together; more, and the page is a picture with a margin already offered well enough. */
const PICTURES_MAX_TOTAL_SHARE = 0.9;
/** More regions than this is a page of pieces (a form, a collage of labels), not a few pictures. */
const PICTURES_MAX_COUNT = 6;

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] ?? 0;
}

/** A square dilation (`keepWhenAll` false) or erosion (true) of a grid of cells by `radius`, along rows, then along columns. */
function morph(source: Uint8Array, gw: number, gh: number, keepWhenAll: boolean, radius: number): Uint8Array {
  const pass = (input: Uint8Array, alongX: boolean): Uint8Array => {
    const output = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let all = true;
        let any = false;
        for (let d = -radius; d <= radius; d++) {
          const x = alongX ? gx + d : gx;
          const y = alongX ? gy : gy + d;
          const value = x >= 0 && y >= 0 && x < gw && y < gh ? input[y * gw + x]! : 0;
          if (value) any = true;
          else all = false;
        }
        output[gy * gw + gx] = (keepWhenAll ? all : any) ? 1 : 0;
      }
    }
    return output;
  };
  return pass(pass(source, true), false);
}

interface CellRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The rectangles of the connected regions (8-connected) of the set cells, with the count of cells of each. */
function regionsOf(solid: Uint8Array, gw: number, gh: number): (CellRect & { cells: number })[] {
  const seen = new Uint8Array(gw * gh);
  const regions: (CellRect & { cells: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < gw * gh; start++) {
    if (!solid[start] || seen[start]) continue;
    const region = { minX: gw, minY: gh, maxX: -1, maxY: -1, cells: 0 };
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % gw;
      const y = (at - x) / gw;
      region.cells++;
      if (x < region.minX) region.minX = x;
      if (x > region.maxX) region.maxX = x;
      if (y < region.minY) region.minY = y;
      if (y > region.maxY) region.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const next = ny * gw + nx;
          if (solid[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    regions.push(region);
  }
  return regions;
}

interface Ground {
  /** The grid: its size, and the raster's pixels per cell. */
  gw: number;
  gh: number;
  scale: number;
  /** Cells that are not ground, as the raster is. */
  raw: Uint8Array;
  /** Cells far from the ground's colour (`STRONG_INK_TOLERANCE`): ink, not a pale print on the paper. */
  strong: Uint8Array;
}

/**
 * The raster on the grid, when it is a page of light paper whose plain ground runs along every side (see above); `null`
 * otherwise.
 */
function groundOf(image: DecodedImage): Ground | null {
  const { width, height, rgba } = image;
  if (width < 64 || height < 64) return null;
  const scale = Math.max(1, Math.max(width, height) / GRID_LONG_EDGE);
  const gw = Math.max(1, Math.floor(width / scale));
  const gh = Math.max(1, Math.floor(height / scale));
  // One colour per cell: the pixel at its middle (a mean would blur a thin line into the ground and a picture's edge into both).
  const cell = (gx: number, gy: number): number => (Math.min(height - 1, Math.floor((gy + 0.5) * scale)) * width + Math.min(width - 1, Math.floor((gx + 0.5) * scale))) * 4;

  const band = Math.max(2, Math.round(Math.min(gw, gh) * EDGE_BAND_SHARE));
  const inBand = (gx: number, gy: number): boolean => gx < band || gy < band || gx >= gw - band || gy >= gh - band;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!inBand(gx, gy)) continue;
      const i = cell(gx, gy);
      reds.push(rgba[i]!);
      greens.push(rgba[i + 1]!);
      blues.push(rgba[i + 2]!);
    }
  }
  const ground = [medianOf(reds), medianOf(greens), medianOf(blues)] as const;
  const isGround = (gx: number, gy: number): boolean => {
    const i = cell(gx, gy);
    // A transparent pixel shows the page under the raster: ground.
    return rgba[i + 3]! <= 32 || (Math.abs(rgba[i]! - ground[0]) + Math.abs(rgba[i + 1]! - ground[1]) + Math.abs(rgba[i + 2]! - ground[2])) / 3 <= GROUND_TOLERANCE;
  };

  let bandCells = 0;
  let bandGround = 0;
  const solid = new Uint8Array(gw * gh);
  const strong = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const g = isGround(gx, gy);
      if (!g) solid[gy * gw + gx] = 1;
      const i = cell(gx, gy);
      if (rgba[i + 3]! > 32 && (Math.abs(rgba[i]! - ground[0]) + Math.abs(rgba[i + 1]! - ground[1]) + Math.abs(rgba[i + 2]! - ground[2])) / 3 > STRONG_INK_TOLERANCE) strong[gy * gw + gx] = 1;
      if (inBand(gx, gy)) {
        bandCells++;
        if (g) bandGround++;
      }
    }
  }
  if (Math.min(...ground) < GROUND_MIN_CHANNEL) return null;
  if (bandGround < EDGE_BAND_MIN_PLAIN_SHARE * bandCells) return null;
  // The ground runs along every side, not only most of the way round (a picture with a pale sky at the top is not on paper).
  // At each place along a side, the band is ground when most of its depth is (a line of the frame running along it takes a few cells).
  const sideIsPlain = (cellAt: (along: number, depth: number) => [number, number], length: number): boolean => {
    let plain = 0;
    for (let along = 0; along < length; along++) {
      let groundCells = 0;
      for (let depth = 0; depth < band; depth++) {
        const [x, y] = cellAt(along, depth);
        if (!solid[y * gw + x]) groundCells++;
      }
      if (groundCells * 2 >= band) plain++;
    }
    return plain >= EDGE_BAND_MIN_PLAIN_SHARE * length;
  };
  if (!sideIsPlain((a, d) => [a, d], gw) || !sideIsPlain((a, d) => [a, gh - 1 - d], gw) || !sideIsPlain((a, d) => [d, a], gh) || !sideIsPlain((a, d) => [gw - 1 - d, a], gh)) return null;
  return { gw, gh, scale, raw: solid, strong };
}

export function findPicturesOnGround(image: DecodedImage): PixelRect[] | null {
  const ground = groundOf(image);
  if (ground === null) return null;
  const { width, height } = image;
  const { gw, gh, scale, raw } = ground;

  // Gaps between lines are closed, then thin things are worn away (a square erosion) and what is left grown back to its size.
  const radius = Math.max(1, Math.round((Math.min(gw, gh) * THIN_SHARE) / 2));
  const closeRadius = Math.max(1, Math.round((Math.min(gw, gh) * CLOSE_GAP_SHARE) / 2));
  const closed = morph(morph(raw, gw, gh, false, closeRadius), gw, gh, true, closeRadius);
  const solid = morph(morph(closed, gw, gh, true, radius), gw, gh, false, radius);

  // Connected regions of what is left.
  const regions: CellRect[] = regionsOf(solid, gw, gh).map(({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY }));

  // Regions whose rectangles overlap are one picture (a photograph laid over the corner of another).
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < regions.length && !merged; a++) {
      for (let b = a + 1; b < regions.length && !merged; b++) {
        const ra = regions[a]!;
        const rb = regions[b]!;
        if (ra.minX <= rb.maxX && rb.minX <= ra.maxX && ra.minY <= rb.maxY && rb.minY <= ra.maxY) {
          regions[a] = { minX: Math.min(ra.minX, rb.minX), minY: Math.min(ra.minY, rb.minY), maxX: Math.max(ra.maxX, rb.maxX), maxY: Math.max(ra.maxY, rb.maxY) };
          regions.splice(b, 1);
          merged = true;
        }
      }
    }
  }

  const fillOf = (r: { minX: number; minY: number; maxX: number; maxY: number }): number => {
    let filled = 0;
    for (let y = r.minY; y <= r.maxY; y++) for (let x = r.minX; x <= r.maxX; x++) if (closed[y * gw + x]) filled++;
    return filled / ((r.maxX - r.minX + 1) * (r.maxY - r.minY + 1));
  };
  const rawFillOf = (r: { minX: number; minY: number; maxX: number; maxY: number }): number => {
    let filled = 0;
    for (let y = r.minY; y <= r.maxY; y++) for (let x = r.minX; x <= r.maxX; x++) if (raw[y * gw + x]) filled++;
    return filled / ((r.maxX - r.minX + 1) * (r.maxY - r.minY + 1));
  };
  const pictures: PixelRect[] = [];
  const kept: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  let covered = 0;
  for (const region of regions) {
    // The wearing away took the picture's own edge with the frame's lines: the rectangle grows back over rows and columns that are picture.
    const r = { ...region };
    const rowFill = (y: number): number => {
      let filled = 0;
      for (let x = r.minX; x <= r.maxX; x++) if (closed[y * gw + x]) filled++;
      return filled / (r.maxX - r.minX + 1);
    };
    const columnFill = (x: number): number => {
      let filled = 0;
      for (let y = r.minY; y <= r.maxY; y++) if (closed[y * gw + x]) filled++;
      return filled / (r.maxY - r.minY + 1);
    };
    for (let grown = 0; grown < 2 * radius && r.minY > 0 && rowFill(r.minY - 1) >= EDGE_ROW_MIN_FILL; grown++) r.minY--;
    for (let grown = 0; grown < 2 * radius && r.maxY < gh - 1 && rowFill(r.maxY + 1) >= EDGE_ROW_MIN_FILL; grown++) r.maxY++;
    for (let grown = 0; grown < 2 * radius && r.minX > 0 && columnFill(r.minX - 1) >= EDGE_ROW_MIN_FILL; grown++) r.minX--;
    for (let grown = 0; grown < 2 * radius && r.maxX < gw - 1 && columnFill(r.maxX + 1) >= EDGE_ROW_MIN_FILL; grown++) r.maxX++;

    const areaShare = ((r.maxX - r.minX + 1) * (r.maxY - r.minY + 1)) / (gw * gh);
    if (areaShare < PICTURE_MIN_AREA_SHARE || fillOf(r) < PICTURE_MIN_FILL) continue;
    // A region that is no solid picture, or that runs into the raster's edge: the page is not a few pictures on paper.
    const margin = Math.max(1, Math.round(Math.min(gw, gh) * PICTURE_MIN_EDGE_MARGIN_SHARE));
    if (rawFillOf(r) < PICTURE_MIN_RAW_FILL || r.minX < margin || r.minY < margin || r.maxX >= gw - margin || r.maxY >= gh - margin) return null;
    covered += areaShare;
    kept.push(r);
    const x = Math.max(0, Math.floor(r.minX * scale));
    const y = Math.max(0, Math.floor(r.minY * scale));
    pictures.push({ x, y, width: Math.min(width, Math.ceil((r.maxX + 1) * scale)) - x, height: Math.min(height, Math.ceil((r.maxY + 1) * scale)) - y });
  }
  if (pictures.length === 0 || pictures.length > PICTURES_MAX_COUNT || covered > PICTURES_MAX_TOTAL_SHARE) return null;
  let unexplained = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (solid[y * gw + x] && !kept.some((r) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY)) unexplained++;
  if (unexplained > UNEXPLAINED_MAX_SHARE * gw * gh) return null;
  // In reading order: down the page, then across.
  return pictures.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Drawings on the page's paper within its frame. A map drawn on the book's own paper (its land is the paper, its coasts and
 * roads lines on it) or a floor plan in thin lines is no solid region: the method above cuts it into pieces and leaves the
 * page whole. Such a page is the frame of the book round its edge (ribbons, rules, ornaments), a margin of bare paper inside
 * it, and the drawing: each side's frame is read from the edge inwards up to the first run of bare paper, and what is drawn
 * inside it, gathered into one piece wherever its parts lie close, is a drawing.
 *
 * Returns `null` when the page has no frame of the book on two sides at least (a picture fading into the paper is the
 * page's own, a map ringed by its street index is one handout), when a side's ink runs from the very edge (a picture
 * running off the page), when nothing large is drawn inside (a page of the book's text, whose words are not in the
 * raster), or when too much is. Measured on twenty labelled books: eleven maps and plans in one book cut out without the
 * frame, and nothing changed in the others.
 */

/** Each side's frame lies within this share of the short edge from the edge. */
const FRAME_MAX_DEPTH_SHARE = 0.16;
/** A run of ink along a side that takes at most this share of any line along it is specks, not a frame nor a drawing. */
const SPECKS_MAX_INK = 0.05;
/** A run of ink of the frame is this share of the short edge thick at most. */
const FRAME_MAX_THICKNESS_SHARE = 0.07;
/** The book's frame is found on this many sides at least. */
const FRAMED_MIN_SIDES = 2;
/** A run of ink along a side is the frame when it takes this share of a line along the side at least (a title is less). */
const FRAME_MIN_INK = 0.25;
/** A line (row or column) along a side is bare paper when at most this share of it is ink ... */
const BARE_LINE_MAX_INK = 0.01;
/** ... and the frame ends where this many bare lines in a row begin (share of the short edge). */
const FRAME_GAP_SHARE = 0.012;
/** A line along a side this much ink at least is a drawing's own border (a dashed rule is about half ink). */
const OWN_BORDER_MIN_INK = 0.45;
/** The frame's ornament outside a drawing's own border takes at most this share of a line along the side. */
const ORNAMENT_MAX_INK = 0.4;
/** The parts of a drawing lie within this share of the short edge of one another (a label beside a plan, a wing of a house). */
const DRAWING_JOIN_SHARE = 0.04;
/** A part this share of the inside at most is a speck (a stain of the paper, a mark): not a drawing by itself. */
const SPECK_MAX_SHARE = 0.002;
/** A drawing is this share of the raster at least. */
const DRAWING_MIN_AREA_SHARE = 0.04;
/** A drawing is at most this many times as long as it is wide (a strip of the frame or a rule is not one). */
const DRAWING_MAX_ASPECT = 5;
/** A piece at most this share of the raster and this many times as long as wide is a title or a box for notes, not a drawing (measured: 0.03-0.06, 3.4-5). */
const STRIP_MAX_AREA_SHARE = 0.1;
const STRIP_MIN_ASPECT = 3;
/** A drawing is kept clear of its own edge by this many cells. */
const DRAWING_PAD_CELLS = 1;

export function findDrawingsOnGround(image: DecodedImage): PixelRect[] | null {
  const ground = groundOf(image);
  if (ground === null) return null;
  const { width, height } = image;
  const { gw, gh, scale, raw, strong } = ground;
  const short = Math.min(gw, gh);
  const maxDepth = Math.round(short * FRAME_MAX_DEPTH_SHARE);
  const gap = Math.max(2, Math.round(short * FRAME_GAP_SHARE));
  const maxThickness = Math.max(2, Math.round(short * FRAME_MAX_THICKNESS_SHARE));

  // Where each side's frame ends. Lines are read over the middle of the side (a corner ornament belongs to both sides).
  // From the edge the side is runs of ink between runs of bare paper. A run of ink that reaches along the side and is
  // followed by bare paper is the frame (a ribbon, a rule, the trim): the drawing lies beyond it. The first run that is
  // not is the drawing: it starts there, or at its own border (a line along most of the side, a map's rule) when the
  // frame's ornament runs into it. A drawing from the very edge runs off the page: not understood (`null`).
  let framedSides = 0;
  const frameDepth = (inkAt: (along: number, depth: number) => number, length: number): number | null => {
    const from = Math.round(length * 0.1);
    const to = length - from;
    const inkShare = (depth: number): number => {
      let ink = 0;
      for (let along = from; along < to; along++) ink += inkAt(along, depth);
      return ink / (to - from);
    };
    const shares = Array.from({ length: maxDepth }, (_, depth) => inkShare(depth));
    const isBare = (depth: number): boolean => shares[depth]! <= BARE_LINE_MAX_INK;
    let frameEnd = 0;
    let depth = 0;
    while (depth < maxDepth) {
      if (isBare(depth)) {
        depth++;
        continue;
      }
      const start = depth;
      let end = start;
      let widest = 0;
      while (end < maxDepth && !isBare(end)) widest = Math.max(widest, shares[end++]!);
      let bare = 0;
      while (end + bare < maxDepth && isBare(end + bare)) bare++;
      // Bare paper after it, or bare up to the depth where a frame can lie (a run that goes on past that depth is the drawing).
      const followedByPaper = bare >= gap || (bare > 0 && end + bare >= maxDepth);
      // A frame is thin (a ribbon, a rule); a thick band of ink (a column of text along the side) is the drawing's own.
      if (followedByPaper && widest >= FRAME_MIN_INK && end - start <= maxThickness) {
        if (frameEnd === 0) framedSides++;
        frameEnd = end;
        depth = end + bare;
        continue;
      }
      // A few specks (dirt at the trim) are neither frame nor drawing.
      if (followedByPaper && widest < SPECKS_MAX_INK) {
        depth = end + bare;
        continue;
      }
      if (followedByPaper) return frameEnd;
      // Outside that border only a pale, sparse ornament may lie; a picture there runs on past it.
      for (let line = start; line < end && (line === start || shares[line - 1]! < ORNAMENT_MAX_INK); line++) if (shares[line]! >= OWN_BORDER_MIN_INK) return line;
      // From the very edge: a picture running off the page fills its lines; a pale ornament of the frame only sprinkles them.
      return start === 0 && widest >= FRAME_MIN_INK ? null : frameEnd;
    }
    return frameEnd;
  };
  const at = (x: number, y: number): number => strong[y * gw + x]!;
  const top = frameDepth((a, d) => at(a, d), gw);
  const bottom = frameDepth((a, d) => at(a, gh - 1 - d), gw);
  const left = frameDepth((a, d) => at(d, a), gh);
  const right = frameDepth((a, d) => at(gw - 1 - d, a), gh);
  // The page has the book's frame: on two sides at least (a picture without one, fading into the paper, is the page's own).
  if (top === null || bottom === null || left === null || right === null || framedSides < FRAMED_MIN_SIDES) return null;
  const inside: CellRect = { minX: left, minY: top, maxX: gw - 1 - right, maxY: gh - 1 - bottom };

  // What is drawn inside the frame, its parts joined where they lie close.
  const ink = new Uint8Array(gw * gh);
  for (let y = inside.minY; y <= inside.maxY; y++) for (let x = inside.minX; x <= inside.maxX; x++) ink[y * gw + x] = raw[y * gw + x]!;
  const insideCells = (inside.maxX - inside.minX + 1) * (inside.maxY - inside.minY + 1);
  const parts = regionsOf(ink, gw, gh).filter((r) => r.cells > SPECK_MAX_SHARE * insideCells);
  const join = Math.max(1, Math.round(short * DRAWING_JOIN_SHARE));
  const drawings: CellRect[] = parts.map(({ minX, minY, maxX, maxY }) => ({ minX, minY, maxX, maxY }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < drawings.length && !merged; a++) {
      for (let b = a + 1; b < drawings.length && !merged; b++) {
        const ra = drawings[a]!;
        const rb = drawings[b]!;
        if (ra.minX - join <= rb.maxX && rb.minX - join <= ra.maxX && ra.minY - join <= rb.maxY && rb.minY - join <= ra.maxY) {
          drawings[a] = { minX: Math.min(ra.minX, rb.minX), minY: Math.min(ra.minY, rb.minY), maxX: Math.max(ra.maxX, rb.maxX), maxY: Math.max(ra.maxY, rb.maxY) };
          drawings.splice(b, 1);
          merged = true;
        }
      }
    }
  }
  const pictures: PixelRect[] = [];
  for (const r of drawings) {
    const w = r.maxX - r.minX + 1;
    const h = r.maxY - r.minY + 1;
    if ((w * h) / (gw * gh) < DRAWING_MIN_AREA_SHARE || Math.max(w, h) > DRAWING_MAX_ASPECT * Math.min(w, h)) continue;
    // A small, long piece is the title of a map or the box for notes under it, set apart from the drawing.
    if ((w * h) / (gw * gh) < STRIP_MAX_AREA_SHARE && Math.max(w, h) >= STRIP_MIN_ASPECT * Math.min(w, h)) continue;
    const minX = Math.max(inside.minX, r.minX - DRAWING_PAD_CELLS);
    const minY = Math.max(inside.minY, r.minY - DRAWING_PAD_CELLS);
    const maxX = Math.min(inside.maxX, r.maxX + DRAWING_PAD_CELLS);
    const maxY = Math.min(inside.maxY, r.maxY + DRAWING_PAD_CELLS);
    const x = Math.max(0, Math.floor(minX * scale));
    const y = Math.max(0, Math.floor(minY * scale));
    pictures.push({ x, y, width: Math.min(width, Math.ceil((maxX + 1) * scale)) - x, height: Math.min(height, Math.ceil((maxY + 1) * scale)) - y });
  }
  if (pictures.length === 0 || pictures.length > PICTURES_MAX_COUNT) return null;
  return pictures.sort((a, b) => a.y - b.y || a.x - b.x);
}
