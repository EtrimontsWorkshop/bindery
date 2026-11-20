import type { DecodedImage } from './normalizeDecodedImage.js';
import type { PixelRect } from './picturesOnGround.js';

/**
 * A page painted as one raster with a single sheet laid upright on its paper (a handout: a letter, a report, a blank sheet the page writes
 * on), the book's frame round the paper: the sheet, cut along its sides. The cards laid askew or over one another (see `cardsOnGround.ts`)
 * and the pictures apart on the paper (see `picturesOnGround.ts`) are found otherwise; a sheet of paper a shade off the page's is neither
 * (too like the paper for a picture, alone and upright for a card).
 *
 * The sheet is told by its colour: across the middle of the page, the rows and the columns where most of what lies there is off the page's
 * paper make one block, with the paper round it on all four sides. Measured on a book of handouts: a bluish sheet on cream paper and a tan
 * one on off-white differ from the paper by 14-30 (mean of the three channels); the paper itself varies by 4.
 */

/** The work raster is at most this many pixels on its long edge. */
const WORK_LONG_EDGE = 400;
/** The page's paper is read from the band this share of the page wide along its edges, inside the book's frame. */
const GROUND_BAND_FROM = 0.06;
const GROUND_BAND_TO = 0.1;
/** A pixel is off the paper when it differs from it by this much at least (mean of the three channels). */
const OFF_GROUND = 10;
/** Rows and columns are measured across the middle of the page: this share of it on each side is left out (the frame, its ornaments). */
const MIDDLE_FROM = 0.25;
/** A row or a column is the sheet's when this share of it at least is off the paper... */
const SHEET_LINE_MIN_OFF = 0.8;
/** ...and the paper's when this share at most is. */
const PAPER_LINE_MAX_OFF = 0.25;
/** Rows or columns of the sheet may be broken by this share of the page at most (a line of its print as light as the paper). */
const SHEET_MAX_GAP = 0.01;
/** The sheet covers this share of the page at least, and at most. */
const SHEET_MIN_AREA = 0.15;
const SHEET_MAX_AREA = 0.8;
/** Most of the sheet is its paper: this share of it at least lies within this of its median colour (a floor plan, a photograph does not). */
const SHEET_PAPER_TOLERANCE = 20;
const SHEET_MIN_PAPER = 0.6;
/** On each side of it, this share of the page at least is paper (it lies on the paper, inside the frame, not over the page's edge). */
const PAPER_MIN_MARGIN = 0.03;

export function findSingleCardOnGround(image: DecodedImage): PixelRect | null {
  const scale = Math.min(1, WORK_LONG_EDGE / Math.max(image.width, image.height));
  const W = Math.max(1, Math.round(image.width * scale));
  const H = Math.max(1, Math.round(image.height * scale));
  if (W < 64 || H < 64) return null;
  const colour = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (Math.min(image.height - 1, Math.floor((y + 0.5) / scale)) * image.width + Math.min(image.width - 1, Math.floor((x + 0.5) / scale))) * 4;
      const alpha = image.rgba[at + 3]! / 255;
      for (let c = 0; c < 3; c++) colour[(y * W + x) * 3 + c] = image.rgba[at + c]! * alpha + 255 * (1 - alpha);
    }
  }
  // The paper: the median colour of the bands just inside the frame, left and right, over the middle of the page's height.
  const samples: number[][] = [[], [], []];
  for (let y = Math.round(H * MIDDLE_FROM); y < Math.round(H * (1 - MIDDLE_FROM)); y++) {
    for (const [from, to] of [
      [GROUND_BAND_FROM, GROUND_BAND_TO],
      [1 - GROUND_BAND_TO, 1 - GROUND_BAND_FROM],
    ] as const) {
      for (let x = Math.round(W * from); x < Math.round(W * to); x++) for (let c = 0; c < 3; c++) samples[c]!.push(colour[(y * W + x) * 3 + c]!);
    }
  }
  if (samples[0]!.length === 0) return null;
  const ground = samples.map((s) => s.sort((a, b) => a - b)[Math.floor(s.length / 2)]!);
  const off = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const d = (Math.abs(colour[p * 3]! - ground[0]!) + Math.abs(colour[p * 3 + 1]! - ground[1]!) + Math.abs(colour[p * 3 + 2]! - ground[2]!)) / 3;
    off[p] = d >= OFF_GROUND ? 1 : 0;
  }
  const share = (from: number, to: number, at: (i: number) => number): number => {
    let n = 0;
    for (let i = from; i < to; i++) n += off[at(i)]!;
    return to > from ? n / (to - from) : 0;
  };
  // The longest run of lines that are the sheet's, gaps of a few lines bridged.
  const run = (shares: number[], length: number): [number, number] | null => {
    const maxGap = Math.max(1, Math.round(SHEET_MAX_GAP * length));
    let best: [number, number] | null = null;
    let start = -1;
    let last = -1;
    for (let i = 0; i <= shares.length; i++) {
      const sheet = i < shares.length && shares[i]! >= SHEET_LINE_MIN_OFF;
      if (sheet) {
        if (start < 0 || i - last > maxGap + 1) start = i;
        last = i;
      }
      if (start >= 0 && (best === null || last - start > best[1] - best[0])) best = [start, last];
      if (!sheet && i - last > maxGap) start = -1;
    }
    return best;
  };
  const x0 = Math.round(W * MIDDLE_FROM);
  const x1 = Math.round(W * (1 - MIDDLE_FROM));
  const rowShares = Array.from({ length: H }, (_, y) => share(x0, x1, (x) => y * W + x));
  const rows = run(rowShares, H);
  if (rows === null) return null;
  const [top, bottom] = rows;
  const colShares = Array.from({ length: W }, (_, x) => share(top, bottom + 1, (y) => y * W + x));
  const cols = run(colShares, W);
  if (cols === null) return null;
  const [left, right] = cols;
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (width * height < SHEET_MIN_AREA * W * H || width * height > SHEET_MAX_AREA * W * H) return null;
  // Paper round it on all four sides: lines just outside the sheet are the paper's.
  const margin = Math.max(1, Math.round(PAPER_MIN_MARGIN * Math.min(W, H)));
  if (top < margin || left < margin || H - 1 - bottom < margin || W - 1 - right < margin) return null;
  const paperRow = (y: number): boolean => share(left, right + 1, (x) => y * W + x) <= PAPER_LINE_MAX_OFF;
  const paperCol = (x: number): boolean => share(top, bottom + 1, (y) => y * W + x) <= PAPER_LINE_MAX_OFF;
  const gap = Math.max(2, Math.round(SHEET_MAX_GAP * Math.max(W, H)) + 2);
  if (!paperRow(top - gap) || !paperRow(bottom + gap) || !paperCol(left - gap) || !paperCol(right + gap)) return null;
  // A sheet of paper: most of it is of one colour (its paper, under its print); a picture laid on the page (a floor plan) is not.
  const inside: number[][] = [[], [], []];
  for (let y = top; y <= bottom; y += 2) for (let x = left; x <= right; x += 2) for (let c = 0; c < 3; c++) inside[c]!.push(colour[(y * W + x) * 3 + c]!);
  const paper = inside.map((v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!);
  let plain = 0;
  for (let i = 0; i < inside[0]!.length; i++) {
    const d = (Math.abs(inside[0]![i]! - paper[0]!) + Math.abs(inside[1]![i]! - paper[1]!) + Math.abs(inside[2]![i]! - paper[2]!)) / 3;
    if (d <= SHEET_PAPER_TOLERANCE) plain++;
  }
  if (plain < SHEET_MIN_PAPER * inside[0]!.length) return null;
  return { x: Math.floor(left / scale), y: Math.floor(top / scale), width: Math.ceil(width / scale), height: Math.ceil(height / scale) };
}
