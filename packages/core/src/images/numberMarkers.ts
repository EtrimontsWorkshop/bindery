import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Numbered markers of a map: black discs with a white number in them (the key to the rooms of a floor plan), drawn into the raster. A marker is
 * found as a round, solid dark blob once the white strokes of its number (small islands that dark pixels enclose) are filled in; a wall or a line
 * is too thin to have the core of a disc. Discs of one size (at least three, so that a single black blob is not taken for a marker) that have a
 * number in them are painted over with the color around them.
 */

/** A pixel is dark when it is visible and its luminance is below this. */
const DARK_MAX_LUMINANCE = 90;
const DARK_MIN_ALPHA = 128;
/** The dark share of the picture between which it can be a map with markers (a plain page or a black picture has none). */
const MIN_DARK_SHARE = 0.003;
const MAX_DARK_SHARE = 0.5;
/** Largest side of a glyph island, as a share of the shorter side of the picture. */
const MAX_GLYPH_SIDE_SHARE = 0.05;
const MIN_GLYPH_PIXELS = 4;
const MAX_GLYPH_ISLANDS = 20000;
/** The core of a disc: where the dark is at least this far (share of the shorter side, at least MIN_CORE_PX) from the light. A line is thinner; the thicker walls need the first, wider value to be kept off a disc that they touch. */
const CORE_SHARES = [0.0085, 0.005];
const MIN_CORE_PX = 4;
/** The smallest disc, as a share of the picture's mean side (the letters of a page, thick as they are, are smaller than the markers of a map), and the largest, as a share of the shorter side. */
const MIN_MARKER_RADIUS_SHARE = 0.012;
const MAX_MARKER_RADIUS_SHARE = 0.07;
/** A core is round: its box is about square and it fills about the share of its box that a disc does. */
const CORE_MIN_ASPECT = 0.7;
const CORE_MIN_FILL = 0.6;
const CORE_MAX_FILL = 0.92;
const RAY_COUNT = 24;
/** At least this many of the rays (of 24) must reach the edge of the disc at about the same distance (the others may run into walls that touch it). */
const MIN_AGREEING_RAYS = 20;
const RADIUS_AGREEMENT = 0.1;
/** The number inside takes up between these shares of the disc's area. */
const MIN_GLYPH_AREA_SHARE = 0.03;
const MAX_GLYPH_AREA_SHARE = 0.5;
/** The inside of a marker is pure black (but for the number) and its number is white; the ground just outside is light. */
const SOLID_BLACK_MAX_LUMINANCE = 60;
const MIN_SOLID_SHARE = 0.97;
const MIN_GLYPH_LUMINANCE = 190;
const MIN_LIGHT_LUMINANCE = 190;
const MIN_LIGHT_RING_SHARE = 0.6;
/**
 * An island that is a plain oval (the counter of an o, an a, an e) is not part of a number: a disc whose only white is such ovals is a bold letter.
 */
const OVAL_MIN_FILL = 0.73;
const OVAL_MAX_FILL = 0.83;
const OVAL_MIN_ASPECT = 0.5;
/** Markers of a map share one size: the radii of the discs that are painted over lie within this share of their median. */
const RADIUS_SPREAD = 0.25;
const MIN_MARKERS = 3;
/** The painted-over circle is this much (px) wider than the disc, to take the light halo of the marker with it. */
const ERASE_MARGIN_PX = 2.5;

interface Island {
  x: number;
  y: number;
  pixels: number;
  /** Share of its box that the island fills (an oval counter fills about 0.78, a digit's strokes much less, a bar of a one 1). */
  fill: number;
  /** Shorter side over longer side of its box. */
  aspect: number;
}

interface Disc {
  x: number;
  y: number;
  r: number;
}

function luminance(rgba: Uint8ClampedArray, i: number): number {
  return 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
}

/**
 * Fills the small groups of light pixels that dark pixels enclose (they do not connect to the edge of the picture) into `filled` and returns
 * where they are.
 */
function fillGlyphIslands(dark: Uint8Array, width: number, height: number, filled: Uint8Array): Island[] {
  const maxSide = Math.max(4, Math.round(MAX_GLYPH_SIDE_SHARE * Math.min(width, height)));
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const visited = new Int32Array(width * height);
  const islands: Island[] = [];
  for (let start = 0; start < dark.length; start++) {
    if (dark[start] || seen[start]) continue;
    let top = 0;
    let count = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let touchesEdge = false;
    while (top > 0) {
      const p = stack[--top]!;
      visited[count++] = p;
      const x = p % width;
      const y = (p - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      if (x > 0 && !dark[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < width - 1 && !dark[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && !dark[p - width] && !seen[p - width]) { seen[p - width] = 1; stack[top++] = p - width; }
      if (y < height - 1 && !dark[p + width] && !seen[p + width]) { seen[p + width] = 1; stack[top++] = p + width; }
    }
    if (touchesEdge || count < MIN_GLYPH_PIXELS || maxX - minX + 1 > maxSide || maxY - minY + 1 > maxSide) continue;
    for (let k = 0; k < count; k++) filled[visited[k]!] = 1;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    islands.push({ x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2, pixels: count, fill: count / (w * h), aspect: Math.min(w, h) / Math.max(w, h) });
    if (islands.length > MAX_GLYPH_ISLANDS) return [];
  }
  return islands;
}

/** Distance (px) of every filled pixel from the nearest pixel that is not filled (0 for the others); a two-pass chamfer approximation. */
function distanceInside(filled: Uint8Array, width: number, height: number): Float32Array {
  const D = 1.4142;
  const dist = new Float32Array(width * height);
  for (let p = 0; p < dist.length; p++) dist[p] = filled[p] ? 1e9 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!filled[p]) continue;
      let d = dist[p]!;
      if (x === 0 || y === 0) d = Math.min(d, 1);
      if (x > 0) d = Math.min(d, dist[p - 1]! + 1);
      if (y > 0) {
        d = Math.min(d, dist[p - width]! + 1);
        if (x > 0) d = Math.min(d, dist[p - width - 1]! + D);
        if (x < width - 1) d = Math.min(d, dist[p - width + 1]! + D);
      }
      dist[p] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (!filled[p]) continue;
      let d = dist[p]!;
      if (x === width - 1 || y === height - 1) d = Math.min(d, 1);
      if (x < width - 1) d = Math.min(d, dist[p + 1]! + 1);
      if (y < height - 1) {
        d = Math.min(d, dist[p + width]! + 1);
        if (x < width - 1) d = Math.min(d, dist[p + width + 1]! + D);
        if (x > 0) d = Math.min(d, dist[p + width - 1]! + D);
      }
      dist[p] = d;
    }
  }
  return dist;
}

/** The round cores (pixels at least `coreDistance` from the light) of the filled dark: their centers and their largest distance. */
function findCores(dist: Float32Array, width: number, height: number, coreDistance: number): { x: number; y: number; peak: number }[] {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const cores: { x: number; y: number; peak: number }[] = [];
  for (let start = 0; start < dist.length; start++) {
    if (seen[start] || dist[start]! < coreDistance) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let peak = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % width;
      const y = (p - x) / width;
      count++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (dist[p]! > peak) peak = dist[p]!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (!seen[q] && dist[q]! >= coreDistance) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const aspect = Math.min(w, h) / Math.max(w, h);
    const fill = count / (w * h);
    if (aspect < CORE_MIN_ASPECT || fill < CORE_MIN_FILL || fill > CORE_MAX_FILL) continue;
    cores.push({ x: sumX / count + 0.5, y: sumY / count + 0.5, peak });
  }
  return cores;
}

/** The radius of the filled dark around (cx, cy) when it is the same in (nearly) every direction, or null. */
function radiusAround(cx: number, cy: number, filled: Uint8Array, width: number, height: number, maxRadius: number): number | null {
  const radii: number[] = [];
  for (let k = 0; k < RAY_COUNT; k++) {
    const angle = (2 * Math.PI * k) / RAY_COUNT;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let r = 0;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && filled[Math.floor(y) * width + Math.floor(x)] === 1;
    while (r < maxRadius && inside(cx + dx * r, cy + dy * r)) r += 0.5;
    if (r < maxRadius) radii.push(r);
  }
  if (radii.length < MIN_AGREEING_RAYS) return null;
  // The radius most of the rays agree on (the others ran into a wall that touches the disc).
  let best: number[] = [];
  for (const candidate of radii) {
    const group = radii.filter((r) => Math.abs(r - candidate) <= RADIUS_AGREEMENT * candidate);
    if (group.length > best.length) best = group;
  }
  if (best.length < MIN_AGREEING_RAYS) return null;
  const sorted = [...best].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Whether the disc looks like a marker: pure black but for a white number, with light ground around it. Illustrations are neither. */
function looksLikeMarker(image: DecodedImage, dark: Uint8Array, filled: Uint8Array, disc: Disc): boolean {
  const { width, height, rgba } = image;
  const reach = Math.max(2, 0.9 * disc.r);
  let inside = 0;
  let solid = 0;
  let glyph = 0;
  let glyphLuminance = 0;
  for (let y = Math.max(0, Math.floor(disc.y - reach)); y <= Math.min(height - 1, Math.ceil(disc.y + reach)); y++) {
    for (let x = Math.max(0, Math.floor(disc.x - reach)); x <= Math.min(width - 1, Math.ceil(disc.x + reach)); x++) {
      if (Math.hypot(x + 0.5 - disc.x, y + 0.5 - disc.y) > reach) continue;
      const p = y * width + x;
      const lum = luminance(rgba, p * 4);
      inside++;
      if (filled[p] && !dark[p]) {
        glyph++;
        glyphLuminance += lum;
        solid++;
      } else if (lum < SOLID_BLACK_MAX_LUMINANCE) solid++;
    }
  }
  if (inside === 0 || solid / inside < MIN_SOLID_SHARE || glyph === 0 || glyphLuminance / glyph < MIN_GLYPH_LUMINANCE) return false;
  let ring = 0;
  let light = 0;
  for (let k = 0; k < 48; k++) {
    const angle = (2 * Math.PI * k) / 48;
    const x = Math.round(disc.x + Math.cos(angle) * (disc.r + 3));
    const y = Math.round(disc.y + Math.sin(angle) * (disc.r + 3));
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const i = (y * width + x) * 4;
    ring++;
    if (rgba[i + 3]! < DARK_MIN_ALPHA || luminance(rgba, i) >= MIN_LIGHT_LUMINANCE) light++;
  }
  return ring > 0 && light / ring >= MIN_LIGHT_RING_SHARE;
}

/** The color around a disc: the median of the light half of the visible pixels on a ring just outside it, or transparent when the ring is mostly clear. */
function colorAround(image: DecodedImage, disc: Disc): [number, number, number, number] {
  const { width, height, rgba } = image;
  const samples: number[][] = [];
  let clear = 0;
  let total = 0;
  for (let k = 0; k < 48; k++) {
    const angle = (2 * Math.PI * k) / 48;
    for (const extra of [ERASE_MARGIN_PX + 2, ERASE_MARGIN_PX + 4]) {
      const x = Math.round(disc.x + Math.cos(angle) * (disc.r + extra));
      const y = Math.round(disc.y + Math.sin(angle) * (disc.r + extra));
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      total++;
      if (rgba[i + 3]! < DARK_MIN_ALPHA) clear++;
      else samples.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!, luminance(rgba, i)]);
    }
  }
  if (total === 0 || clear > total / 2 || samples.length === 0) return [255, 255, 255, 0];
  // The lightest quarter of the ring: a wall or a line that runs along it is dark, the ground around it is not.
  samples.sort((p, q) => q[4]! - p[4]!);
  const light = samples.slice(0, Math.max(1, Math.ceil(samples.length / 4)));
  const mid = (channel: number) => light.map((s) => s[channel]!).sort((p, q) => p - q)[Math.floor(light.length / 2)]!;
  return [mid(0), mid(1), mid(2), mid(3)];
}

/**
 * Numbered markers drawn as squares of one saturated colour (a red square with a white number), the key of a map painted in many colours: a
 * solid square of that colour with a light number in it. Measured on one book: 14 px squares at 600 px (colour 47% of the box, number 44%) and 41 px
 * at 2048 px (91% and 6%), solid either way (90% and more); the red labels and arcs of the same map are letters and lines, no squares, and the
 * patches of colour of other pictures (a roof, a banner, a flag) let the drawing show through.
 */
const SQUARE_MIN_SATURATION_SPREAD = 120;
const SQUARE_MIN_MAX_CHANNEL = 120;
/** The side of a square, as a share of the picture's shorter side. */
const SQUARE_MIN_SIDE_SHARE = 0.008;
const SQUARE_MAX_SIDE_SHARE = 0.06;
const SQUARE_MIN_ASPECT = 0.75;
/** Its colour fills between these shares of its box (the number takes the rest). */
const SQUARE_MIN_FILL = 0.45;
const SQUARE_MAX_FILL = 0.95;
/** The light number inside takes between these shares of its box. */
const SQUARE_MIN_GLYPH_SHARE = 0.03;
const SQUARE_MAX_GLYPH_SHARE = 0.4;
/** A marker is solid: its colour and its number fill this share of its box together (a patch of colour with the drawing showing through does not). */
const SQUARE_MIN_SOLID_SHARE = 0.85;
/** Squares of one colour: their hues lie within this many degrees of the median. */
const SQUARE_HUE_SPREAD_DEG = 20;
const SQUARE_ERASE_MARGIN_PX = 2;
/** The border of a square is looked at this share of its side inside its box, and this share of it is in the square's colour. */
const SQUARE_BORDER_INSET_SHARE = 0.08;
const SQUARE_MIN_BORDER_SHARE = 0.9;

interface Square {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hue: number;
}

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const h6 = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  return h6 * 60;
}

/** The coloured square markers of a picture (see `SQUARE_MIN_SATURATION_SPREAD`): three at least, of one size and one colour, or none. */
export function findSquareMarkers(image: DecodedImage): Square[] {
  const { width, height, rgba } = image;
  const shorter = Math.min(width, height);
  const minSide = Math.max(6, SQUARE_MIN_SIDE_SHARE * shorter);
  const maxSide = SQUARE_MAX_SIDE_SHARE * shorter;
  const coloured = new Uint8Array(width * height);
  for (let p = 0; p < coloured.length; p++) {
    const i = p * 4;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (rgba[i + 3]! >= DARK_MIN_ALPHA && Math.max(r, g, b) >= SQUARE_MIN_MAX_CHANNEL && Math.max(r, g, b) - Math.min(r, g, b) >= SQUARE_MIN_SATURATION_SPREAD) coloured[p] = 1;
  }
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const squares: Square[] = [];
  for (let start = 0; start < coloured.length; start++) {
    if (!coloured[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let sumHue = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % width;
      const y = (p - x) / width;
      count++;
      sumHue += hueOf(rgba[p * 4]!, rgba[p * 4 + 1]!, rgba[p * 4 + 2]!);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (maxX - minX > maxSide || maxY - minY > maxSide) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (coloured[q] && !seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < minSide || h < minSide || w > maxSide || h > maxSide || Math.min(w, h) / Math.max(w, h) < SQUARE_MIN_ASPECT) continue;
    const fill = count / (w * h);
    if (fill < SQUARE_MIN_FILL || fill > SQUARE_MAX_FILL) continue;
    // A light number inside it, and light ground around it.
    let glyph = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (!coloured[y * width + x] && luminance(rgba, (y * width + x) * 4) >= MIN_GLYPH_LUMINANCE) glyph++;
    const glyphShare = glyph / (w * h);
    if (glyphShare < SQUARE_MIN_GLYPH_SHARE || glyphShare > SQUARE_MAX_GLYPH_SHARE || fill + glyphShare < SQUARE_MIN_SOLID_SHARE) continue;
    // A square is closed all round in its colour, its number inside; a bold letter of a red headline (an O, a D, an E) has round corners or
    // gaps that open to its edge.
    const inset = Math.max(1, Math.round(SQUARE_BORDER_INSET_SHARE * Math.min(w, h)));
    let border = 0;
    let borderColoured = 0;
    for (let x = minX + inset; x <= maxX - inset; x++) {
      for (const y of [minY + inset, maxY - inset]) {
        border++;
        if (coloured[y * width + x]) borderColoured++;
      }
    }
    for (let y = minY + inset + 1; y < maxY - inset; y++) {
      for (const x of [minX + inset, maxX - inset]) {
        border++;
        if (coloured[y * width + x]) borderColoured++;
      }
    }
    if (border === 0 || borderColoured / border < SQUARE_MIN_BORDER_SHARE) continue;
    squares.push({ minX, minY, maxX, maxY, hue: sumHue / count });
  }
  if (squares.length < MIN_MARKERS) return [];
  const sides = squares.map((q) => Math.max(q.maxX - q.minX, q.maxY - q.minY)).sort((p, q) => p - q);
  const medianSide = sides[Math.floor(sides.length / 2)]!;
  const hues = squares.map((q) => q.hue).sort((p, q) => p - q);
  const medianHue = hues[Math.floor(hues.length / 2)]!;
  const hueDistance = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const markers = squares.filter((q) => Math.abs(Math.max(q.maxX - q.minX, q.maxY - q.minY) - medianSide) <= RADIUS_SPREAD * medianSide && hueDistance(q.hue, medianHue) <= SQUARE_HUE_SPREAD_DEG);
  return markers.length >= MIN_MARKERS ? markers : [];
}

/** `image` with its coloured square markers painted over with the colour around each, or null when it has none. */
function eraseSquareMarkers(image: DecodedImage): DecodedImage | null {
  const squares = findSquareMarkers(image);
  if (squares.length === 0) return null;
  const { width, height, rgba } = image;
  const out = new Uint8ClampedArray(rgba);
  for (const q of squares) {
    const x0 = Math.max(0, q.minX - SQUARE_ERASE_MARGIN_PX);
    const x1 = Math.min(width - 1, q.maxX + SQUARE_ERASE_MARGIN_PX);
    const y0 = Math.max(0, q.minY - SQUARE_ERASE_MARGIN_PX);
    const y1 = Math.min(height - 1, q.maxY + SQUARE_ERASE_MARGIN_PX);
    // Filled from its four edges (the pixels just outside the square on its row and its column, weighted by how near they are): the ground of the
    // map goes on under it, shaded as around it, instead of a flat patch of one colour.
    const ox0 = Math.max(0, x0 - 1);
    const ox1 = Math.min(width - 1, x1 + 1);
    const oy0 = Math.max(0, y0 - 1);
    const oy1 = Math.min(height - 1, y1 + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const edges: [number, number][] = [
          [y * width + ox0, x - ox0],
          [y * width + ox1, ox1 - x],
          [oy0 * width + x, y - oy0],
          [oy1 * width + x, oy1 - y],
        ];
        const value = [0, 0, 0, 0];
        let weight = 0;
        for (const [q, distance] of edges) {
          if (distance <= 0) continue;
          const w = 1 / distance;
          for (let c = 0; c < 4; c++) value[c]! += rgba[q * 4 + c]! * w;
          weight += w;
        }
        if (weight > 0) out.set(value.map((v) => v / weight), (y * width + x) * 4);
      }
    }
  }
  return { width, height, rgba: out };
}

/**
 * `image` with the numbered markers painted over (black discs with a white number, and squares of one colour with a light number), or null when it
 * has none (fewer than three markers of one kind and one size).
 */
export function eraseNumberMarkers(image: DecodedImage): DecodedImage | null {
  const withoutDiscs = eraseDiscMarkers(image);
  const withoutSquares = eraseSquareMarkers(withoutDiscs ?? image);
  return withoutSquares ?? withoutDiscs;
}

/** `image` with its black disc markers painted over, or null when it has none (fewer than three discs with a number in them, of one size). */
function eraseDiscMarkers(image: DecodedImage): DecodedImage | null {
  const { width, height, rgba } = image;
  if (width < 32 || height < 32) return null;
  const dark = new Uint8Array(width * height);
  let darkCount = 0;
  for (let p = 0; p < dark.length; p++) {
    const i = p * 4;
    if (rgba[i + 3]! >= DARK_MIN_ALPHA && luminance(rgba, i) < DARK_MAX_LUMINANCE) {
      dark[p] = 1;
      darkCount++;
    }
  }
  const share = darkCount / dark.length;
  if (share < MIN_DARK_SHARE || share > MAX_DARK_SHARE) return null;

  const filled = new Uint8Array(dark);
  const islands = fillGlyphIslands(dark, width, height, filled);
  if (islands.length < MIN_MARKERS) return null;
  const shorter = Math.min(width, height);
  const maxRadius = MAX_MARKER_RADIUS_SHARE * shorter;
  const dist = distanceInside(filled, width, height);

  const discs: Disc[] = [];
  for (const share of CORE_SHARES) {
   const coreDistance = Math.max(MIN_CORE_PX, share * shorter);
   for (const core of findCores(dist, width, height, coreDistance)) {
    const r = radiusAround(core.x, core.y, filled, width, height, maxRadius);
    if (r === null || r < coreDistance || r < MIN_MARKER_RADIUS_SHARE * Math.sqrt(width * height)) continue;
    if (discs.some((d) => Math.hypot(d.x - core.x, d.y - core.y) < 0.5 * Math.max(d.r, r))) continue;
    // The number: islands inside the disc, taking a fitting share of its area.
    let glyphPixels = 0;
    let digitLike = 0;
    for (const island of islands) {
      if (Math.hypot(island.x - core.x, island.y - core.y) > 0.85 * r) continue;
      glyphPixels += island.pixels;
      if (!(island.fill >= OVAL_MIN_FILL && island.fill <= OVAL_MAX_FILL && island.aspect >= OVAL_MIN_ASPECT)) digitLike++;
    }
    if (digitLike === 0) continue;
    const glyphShare = glyphPixels / (Math.PI * r * r);
    if (glyphShare < MIN_GLYPH_AREA_SHARE || glyphShare > MAX_GLYPH_AREA_SHARE) continue;
    const candidate = { x: core.x, y: core.y, r };
    if (!looksLikeMarker(image, dark, filled, candidate)) continue;
    discs.push(candidate);
   }
  }
  if (discs.length < MIN_MARKERS) return null;
  const radii = discs.map((d) => d.r).sort((p, q) => p - q);
  const median = radii[Math.floor(radii.length / 2)]!;
  const markers = discs.filter((d) => Math.abs(d.r - median) <= RADIUS_SPREAD * median);
  if (markers.length < MIN_MARKERS) return null;

  const out = new Uint8ClampedArray(rgba);
  for (const disc of markers) {
    const color = colorAround(image, disc);
    const reach = disc.r + ERASE_MARGIN_PX;
    const x0 = Math.max(0, Math.floor(disc.x - reach));
    const x1 = Math.min(width - 1, Math.ceil(disc.x + reach));
    const y0 = Math.max(0, Math.floor(disc.y - reach));
    const y1 = Math.min(height - 1, Math.ceil(disc.y + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + 0.5 - disc.x, y + 0.5 - disc.y) > reach) continue;
        out.set(color, (y * width + x) * 4);
      }
    }
  }
  return { width, height, rgba: out };
}
