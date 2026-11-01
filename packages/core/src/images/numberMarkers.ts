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
 * `image` with the numbered markers painted over, or null when it has none (fewer than three discs with a number in them, of one size).
 */
export function eraseNumberMarkers(image: DecodedImage): DecodedImage | null {
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
