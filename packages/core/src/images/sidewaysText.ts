import type { DecodedImage } from './normalizeDecodedImage.js';
import { rotateQuarterTurns } from './rotateQuarterTurns.js';

/**
 * Lettering drawn into a picture's pixels (the names on a map, the title of a plan) tells which way the picture stands, when
 * the page gives no direction for it: a map printed on its side to fit a portrait page carries its lettering running up or
 * down. Letters are found as small dark marks of about one size; a line of lettering is a chain of such marks side by side,
 * each about as tall as the next (upright lettering) or about as wide (lettering on its side). A picture whose chains run
 * mostly up and down lies on its side.
 *
 * Which way it lies is read from initial capitals: a capital opening a name stands just before the small letters, on
 * their foot, and rises beyond their head, so it shows both where the line starts and where its letters' tops point (see
 * `initialsOf`). Map lettering is mostly capitals, so this often finds too few to tell; then the way books usually turn
 * a picture is taken, its top towards the page's left edge, read by turning the book clockwise. In twenty labelled books
 * this stood up nine of ten maps lying on their side in one book (the tenth, read downwards, has no initials to tell) and
 * both in another; the baseline of the letters against their tops, or where their ink lies, told no better than chance.
 */

/** The picture is examined at most this long on its long edge (lettering of a map stays several pixels tall). */
const WORK_LONG_EDGE = 1600;
/** Half the side of the window a pixel is compared with to count as ink (darker than its surroundings). */
const LOCAL_RADIUS = 12;
/** A pixel this much darker than the mean of its window is ink. */
const INK_CONTRAST = 45;
/** A letter's box, in pixels of the working image: this tall (or wide) at least, at most. */
const LETTER_MIN_SIDE = 5;
const LETTER_MAX_SIDE = 48;
/** Share of a letter's box its ink fills, at least and at most (a solid block or a hairline is not a letter). */
const LETTER_MIN_FILL = 0.12;
const LETTER_MAX_FILL = 0.85;
/** Two letters of a line: about one size across the line (ratio at most this), ... */
const SAME_SIZE_RATIO = 1.35;
/** ... their middles this share of that size apart at most across the line, ... */
const ALIGN_SHARE = 0.25;
/** ... and the gap between them along the line at most this share of that size. */
const GAP_SHARE = 0.7;
/** A chain of this many letters at least is a line of lettering. */
const LINE_MIN_LETTERS = 4;
/** The picture lies on its side when the letters in lines running up and down are this many at least ... */
const SIDEWAYS_MIN_LETTERS = 40;
/** ... and this many times the letters in lines running across. */
const SIDEWAYS_MIN_RATIO = 3;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SidewaysLettering {
  /** Letters in lines running across the picture, and up and down it. */
  across: number;
  upDown: number;
  /**
   * Quarter turns clockwise that stand the picture up: 1 when its lettering reads upwards (its top lies to the left), 3
   * when it reads downwards; 0 when it does not lie on its side.
   */
  turns: 0 | 1 | 3;
}

function luminanceOf(image: DecodedImage, scale: number): { gray: Float32Array; width: number; height: number } {
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const gray = new Float32Array(width * height);
  const step = 1 / scale;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * step));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * step));
      const at = (sy * image.width + sx) * 4;
      const alpha = image.rgba[at + 3]! / 255;
      // A transparent pixel counts as white paper.
      const l = 0.299 * image.rgba[at]! + 0.587 * image.rgba[at + 1]! + 0.114 * image.rgba[at + 2]!;
      gray[y * width + x] = l * alpha + 255 * (1 - alpha);
    }
  }
  return { gray, width, height };
}

/** Ink: pixels darker than the mean of the window round them, by an integral image. */
function inkOf(gray: Float32Array, width: number, height: number): Uint8Array {
  const sum = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x]!;
      sum[(y + 1) * (width + 1) + x + 1] = sum[y * (width + 1) + x + 1]! + row;
    }
  }
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - LOCAL_RADIUS);
    const y1 = Math.min(height, y + LOCAL_RADIUS + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - LOCAL_RADIUS);
      const x1 = Math.min(width, x + LOCAL_RADIUS + 1);
      const total = sum[y1 * (width + 1) + x1]! - sum[y0 * (width + 1) + x1]! - sum[y1 * (width + 1) + x0]! + sum[y0 * (width + 1) + x0]!;
      const mean = total / ((y1 - y0) * (x1 - x0));
      if (mean - gray[y * width + x]! >= INK_CONTRAST) ink[y * width + x] = 1;
    }
  }
  return ink;
}

/** The boxes of the connected marks of ink (8-connected) that are letter-sized. */
function lettersOf(ink: Uint8Array, width: number, height: number): Box[] {
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const letters: Box[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.push(start);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    let tooBig = false;
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % width;
      const y = (at - x) / width;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x1 - x0 > LETTER_MAX_SIDE * 2 || y1 - y0 > LETTER_MAX_SIDE * 2) tooBig = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (ink[n] === 1 && seen[n] === 0) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (tooBig) continue;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const long = Math.max(w, h);
    if (long < LETTER_MIN_SIDE || long > LETTER_MAX_SIDE || Math.min(w, h) < 2) continue;
    const fill = count / (w * h);
    if (fill < LETTER_MIN_FILL || fill > LETTER_MAX_FILL) continue;
    letters.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return letters;
}

interface Line {
  letters: Box[];
}

/**
 * Chains of letters side by side along x (`along = 'x'`: lines running across) or along y (lines running up and down).
 * For lines along y the roles of the axes swap: the letters' widths are their size across the line.
 */
function linesOf(letters: readonly Box[], along: 'x' | 'y'): Line[] {
  const a0 = (b: Box) => (along === 'x' ? b.x0 : b.y0);
  const a1 = (b: Box) => (along === 'x' ? b.x1 : b.y1);
  const c0 = (b: Box) => (along === 'x' ? b.y0 : b.x0);
  const c1 = (b: Box) => (along === 'x' ? b.y1 : b.x1);
  const order = [...letters.keys()].sort((i, j) => a0(letters[i]!) - a0(letters[j]!));
  const parent = letters.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let n = 0; n < order.length; n++) {
    const p = letters[order[n]!]!;
    const ps = c1(p) - c0(p);
    const pm = (c0(p) + c1(p)) / 2;
    for (let m = n + 1; m < order.length; m++) {
      const q = letters[order[m]!]!;
      const size = Math.max(ps, c1(q) - c0(q));
      if (a0(q) - a1(p) > GAP_SHARE * size) {
        if (a0(q) - a1(p) > GAP_SHARE * LETTER_MAX_SIDE) break;
        continue;
      }
      const qs = c1(q) - c0(q);
      if (Math.max(ps, qs) > SAME_SIZE_RATIO * Math.min(ps, qs)) continue;
      if (Math.abs((c0(q) + c1(q)) / 2 - pm) > ALIGN_SHARE * size) continue;
      // Overlapping along the line by more than a little is not two letters side by side.
      if (a0(q) < a1(p) - 0.2 * size) continue;
      parent[find(order[m]!)] = find(order[n]!);
    }
  }
  const groups = new Map<number, Box[]>();
  letters.forEach((b, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(b);
    else groups.set(root, [b]);
  });
  return [...groups.values()].filter((g) => g.length >= LINE_MIN_LETTERS).map((g) => ({ letters: g }));
}

/** Initial capitals: taller across the line than its letters by this much at least, at most. */
const INITIAL_MIN_SIZE = 1.2;
const INITIAL_MAX_SIZE = 2.2;
/** An initial rises beyond one edge of the line by this share of the line's size at least, and stays within this of the other. */
const INITIAL_MIN_RISE = 0.2;
const INITIAL_EDGE_TOLERANCE = 0.15;
/** The lettering is taken to read downwards when this many initials at least say so, and this many times those that say upwards. */
const DOWNWARDS_MIN_INITIALS = 2;
const DOWNWARDS_MIN_RATIO = 2;

/**
 * Initial capitals of the lines running up and down (`lines` along y): a letter just beyond an end of a line, taller across
 * it than its letters, sharing the line's foot and rising beyond its head. Lettering read upwards has its initials below
 * the line (it starts at the bottom) rising to the left (the letters' tops point left); read downwards, above it rising to
 * the right. An initial that says neither (below, rising right: a letter hanging below the line, such as a "p") is not
 * counted.
 */
function initialsOf(lines: readonly Line[], letters: readonly Box[]): { upwards: number; downwards: number } {
  let upwards = 0;
  let downwards = 0;
  for (const line of lines) {
    const left = Math.min(...line.letters.map((b) => b.x0));
    const right = Math.max(...line.letters.map((b) => b.x1));
    const size = right - left;
    const top = Math.min(...line.letters.map((b) => b.y0));
    const bottom = Math.max(...line.letters.map((b) => b.y1));
    for (const b of letters) {
      const across = b.x1 - b.x0;
      if (across < INITIAL_MIN_SIZE * size || across > INITIAL_MAX_SIZE * size) continue;
      const above = b.y1 <= top + 0.2 * size && top - b.y1 <= GAP_SHARE * size;
      const below = b.y0 >= bottom - 0.2 * size && b.y0 - bottom <= GAP_SHARE * size;
      if (!above && !below) continue;
      const risesLeft = left - b.x0 > INITIAL_MIN_RISE * size && Math.abs(b.x1 - right) <= INITIAL_EDGE_TOLERANCE * size;
      const risesRight = b.x1 - right > INITIAL_MIN_RISE * size && Math.abs(left - b.x0) <= INITIAL_EDGE_TOLERANCE * size;
      if (below && risesLeft) upwards++;
      else if (above && risesRight) downwards++;
    }
  }
  return { upwards, downwards };
}

/** Which way the lettering drawn into `image` runs, and the quarter turns that stand the picture up (see above). */
export function sidewaysLettering(image: DecodedImage): SidewaysLettering {
  const scale = Math.min(1, WORK_LONG_EDGE / Math.max(image.width, image.height));
  const { gray, width, height } = luminanceOf(image, scale);
  const letters = lettersOf(inkOf(gray, width, height), width, height);
  const count = (lines: Line[]) => lines.reduce((s, l) => s + l.letters.length, 0);
  const across = count(linesOf(letters, 'x'));
  const upDownLines = linesOf(letters, 'y');
  const upDown = count(upDownLines);
  if (upDown < SIDEWAYS_MIN_LETTERS || upDown < SIDEWAYS_MIN_RATIO * across) return { across, upDown, turns: 0 };
  const { upwards, downwards } = initialsOf(upDownLines, letters);
  const readsDownwards = downwards >= DOWNWARDS_MIN_INITIALS && downwards >= DOWNWARDS_MIN_RATIO * upwards;
  return { across, upDown, turns: readsDownwards ? 3 : 1 };
}

/** `image` stood up when its lettering shows it lying on its side; `null` when it does not. */
export function standUpLettering(image: DecodedImage): DecodedImage | null {
  // A picture turned to fit a portrait page is itself portrait as it lies; a landscape one whose ornament or pattern runs up and down (the
  // border of a cover, a striped backdrop) is no picture on its side. Measured on 279 books: 9 portrait pictures stood up right, 2 landscape
  // ones turned wrongly.
  if (image.width >= image.height) return null;
  const { turns } = sidewaysLettering(image);
  return turns === 0 ? null : rotateQuarterTurns(image, turns);
}
