import type { DecodedImage } from './normalizeDecodedImage.js';

/** Width every raster is measured at. */
const MEASURE_WIDTH = 256;
/** A pixel is paper (nothing drawn) when every channel is at least this, or it is transparent. */
const PAPER_CHANNEL_MIN = 232;
const TRANSPARENT_ALPHA_MAX = 16;
/** Ink of a colour: saturated and not nearly black. */
const COLOURED_MIN_SATURATION = 0.5;
const COLOURED_MIN_VALUE = 60;
/** A droplet: a component of coloured ink of this many pixels (at `MEASURE_WIDTH`). */
const DROPLET_MIN_AREA = 2;
const DROPLET_MAX_AREA = 40;

/**
 * A splatter (blood, paint, ink) is one colour of ink thrown on paper: mostly paper, the ink saturated and of a single hue, and made of a
 * great many separate droplets. Measured on 18 pictures that a first, looser version of this rule hid in eight rulebooks: the 14 splatters have
 * 0.82-0.96 paper and a hue concentration of 0.998 or more (one faint drip 0.995); the four pictures it must not hide (a lamp, a swirl of leaves,
 * two figures) have 0.71-0.79 paper and 0.979-0.996 hue concentration.
 */
const SPLATTER_MIN_PAPER_SHARE = 0.8;
const SPLATTER_MIN_COLOURED_INK_SHARE = 0.6;
const SPLATTER_MIN_HUE_CONCENTRATION = 0.997;
const SPLATTER_MIN_DROPLETS = 50;

export interface InkSplatterMeasure {
  paperShare: number;
  colouredInkShare: number;
  hueConcentration: number;
  droplets: number;
  /** The share of the coloured ink that lies in droplets (see `DROPLET_MAX_AREA`). */
  dropletInkShare: number;
  /** The share of the raster covered by coloured ink. */
  colouredCover: number;
  /** The share of the ink that is nearly black. */
  darkInkShare: number;
  /** Droplets of nearly black ink. */
  darkDroplets: number;
  /** The share of the nearly black ink that lies in droplets (a line drawing has most of its ink in long strokes). */
  darkDropletInkShare: number;
  /** The share of the raster covered by nearly black ink. */
  darkCover: number;
  /** The share of the ink that has no colour (black, or grey where it fades at the edges of a blot). */
  neutralInkShare: number;
}

/** Ink is nearly black when its brightest channel is below this. */
const DARK_INK_MAX_VALUE = 90;
/** Ink has no colour when its channels differ by no more than this. */
const NEUTRAL_INK_MAX_SPREAD = 30;

/** The number of components of 1s in `mask` that are the size of a droplet. */
function countDroplets(mask: Uint8Array, W: number, total: number): { droplets: number; dropletPixels: number } {
  const seen = new Uint8Array(total);
  const stack: number[] = [];
  let droplets = 0;
  let dropletPixels = 0;
  for (let start = 0; start < total; start++) {
    if (!mask[start] || seen[start]) continue;
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      area++;
      const x = p % W;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (p >= W && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (p < total - W && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    if (area >= DROPLET_MIN_AREA && area <= DROPLET_MAX_AREA) {
      droplets++;
      dropletPixels += area;
    }
  }
  return { droplets, dropletPixels };
}

export function measureInkSplatter(image: DecodedImage): InkSplatterMeasure | null {
  if (image.width < 16 || image.height < 16) return null;
  const W = MEASURE_WIDTH;
  const H = Math.max(8, Math.round((image.height * W) / image.width));
  const { rgba } = image;
  const coloured = new Uint8Array(W * H);
  const dark = new Uint8Array(W * H);
  let paper = 0;
  let ink = 0;
  let colouredCount = 0;
  let darkCount = 0;
  let neutralCount = 0;
  let hueX = 0;
  let hueY = 0;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / W));
      const i = (sy * image.width + sx) * 4;
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (rgba[i + 3]! <= TRANSPARENT_ALPHA_MAX || min >= PAPER_CHANNEL_MIN) {
        paper++;
        continue;
      }
      ink++;
      if (max < DARK_INK_MAX_VALUE) {
        dark[y * W + x] = 1;
        darkCount++;
      }
      if (max - min <= NEUTRAL_INK_MAX_SPREAD) neutralCount++;
      if (max < COLOURED_MIN_VALUE || (max - min) / max < COLOURED_MIN_SATURATION) continue;
      coloured[y * W + x] = 1;
      colouredCount++;
      const d = max - min;
      const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hueX += Math.cos((hue * Math.PI) / 3);
      hueY += Math.sin((hue * Math.PI) / 3);
    }
  }
  const total = W * H;
  if (ink === 0) return null;

  const colouredDroplets = countDroplets(coloured, W, total);
  const darkResult = darkCount > 0 ? countDroplets(dark, W, total) : { droplets: 0, dropletPixels: 0 };
  const darkDroplets = darkResult.droplets;
  return {
    paperShare: paper / total,
    colouredInkShare: colouredCount / ink,
    hueConcentration: colouredCount > 0 ? Math.hypot(hueX, hueY) / colouredCount : 0,
    droplets: colouredDroplets.droplets,
    dropletInkShare: colouredCount > 0 ? colouredDroplets.dropletPixels / colouredCount : 0,
    colouredCover: colouredCount / total,
    darkInkShare: darkCount / ink,
    darkDroplets,
    darkDropletInkShare: darkCount > 0 ? darkResult.dropletPixels / darkCount : 0,
    darkCover: darkCount / total,
    neutralInkShare: neutralCount / ink,
  };
}

/**
 * Black ink is thrown on a transparent ground as a blot and droplets: the paper (or the transparent ground) is nearly all of the raster, the ink
 * all but black, and the droplets many. Measured on 2200 pictures from nine rulebooks: the 16 black splatters have 0.90 or more paper and at
 * least 60 droplets, and no raster that is mostly paper and black has between 30 and 59; the one that has fewer paper (a QR code, 0.79) is outside.
 * Two finger prints on a transparent ground are hidden with them.
 */
const BLACK_SPLATTER_MIN_PAPER_SHARE = 0.85;
const BLACK_SPLATTER_MIN_DARK_INK_SHARE = 0.95;
const BLACK_SPLATTER_MIN_DROPLETS = 50;

/**
 * Specks of black ink on a clear ground (what is left of a splatter that is mostly faint): paper all but a sliver, a few droplets, and the ink covering hardly any of the
 * raster. Measured on 13 pictures from five books: the nine splatters have 0.98 or more paper and cover 0.2%-1.6%; the two line drawings that have as many droplets (a monster, a
 * grave) have 0.90 paper, cover 10% and keep 1% of their ink in droplets.
 */
const SPECKS_MIN_PAPER_SHARE = 0.97;
/**
 * A raster that is all paper but a handful of specks (at most 0.3% of it is ink) is an empty sheet with dust on it: two of them in one book have 5 and 8 droplets.
 */
const DUST_MIN_PAPER_SHARE = 0.99;
const DUST_MAX_COVER = 0.003;
const DUST_MIN_DROPLETS = 3;
/**
 * A blot of black ink with many droplets whose edges fade into grey (so that only 77% of its ink is nearly black): neutral ink all but entirely, a great many droplets, and not much of the raster covered.
 * Measured on one splatter: 0.93 paper, 77% black ink, 100% neutral ink, 123 droplets, 5% covered; five sketches that match the rest of it have 32%-45% black ink.
 */
const FADING_BLOT_MIN_PAPER_SHARE = 0.9;
const FADING_BLOT_MIN_NEUTRAL_INK_SHARE = 0.95;
/** ...and most of the ink is nearly black (the sepia and grey drawings that otherwise look the same have 32%-45%; the blot 77%). */
const FADING_BLOT_MIN_DARK_INK_SHARE = 0.7;
const FADING_BLOT_MIN_DROPLETS = 100;
const FADING_BLOT_MAX_COVER = 0.1;
const SPECKS_MAX_COVER = 0.03;
const SPECKS_MIN_DROPLETS = 8;

/**
 * A raster with this much paper (its own pixels, not a render on the page's tint) whose ink is all one colour and which has a great many droplets is a splatter at a slightly lower
 * concentration of hue: its droplets run over a gradient of the same ink. Measured: the splatter blended into a pink page (0.93 paper, 99% coloured ink, 169 droplets, hue 0.995);
 * a diagram of blood drops with labels and arrows (0.94 paper, 76% coloured ink, 54 droplets, hue 0.995) is a drawing and stays one.
 */
const CLEAN_RASTER_MIN_PAPER_SHARE = 0.9;
const CLEAN_RASTER_MIN_COLOURED_INK_SHARE = 0.9;
const CLEAN_RASTER_MIN_DROPLETS = 100;
const CLEAN_RASTER_MIN_HUE_CONCENTRATION = 0.99;

export function looksLikeInkSplatter(image: DecodedImage): boolean {
  const m = measureInkSplatter(image);
  if (m === null) return false;
  if (m.paperShare >= BLACK_SPLATTER_MIN_PAPER_SHARE && m.darkInkShare >= BLACK_SPLATTER_MIN_DARK_INK_SHARE && m.darkDroplets >= BLACK_SPLATTER_MIN_DROPLETS) return true;
  if (m.paperShare >= DUST_MIN_PAPER_SHARE && m.darkInkShare >= BLACK_SPLATTER_MIN_DARK_INK_SHARE && m.darkCover <= DUST_MAX_COVER && m.darkDroplets >= DUST_MIN_DROPLETS) return true;
  if (m.paperShare >= FADING_BLOT_MIN_PAPER_SHARE && m.neutralInkShare >= FADING_BLOT_MIN_NEUTRAL_INK_SHARE && m.darkInkShare >= FADING_BLOT_MIN_DARK_INK_SHARE && m.darkDroplets >= FADING_BLOT_MIN_DROPLETS && m.darkCover <= FADING_BLOT_MAX_COVER) return true;
  if (m.paperShare >= SPECKS_MIN_PAPER_SHARE && m.darkInkShare >= BLACK_SPLATTER_MIN_DARK_INK_SHARE && m.darkDroplets >= SPECKS_MIN_DROPLETS && m.darkCover <= SPECKS_MAX_COVER) return true;
  const cleanRaster = m.paperShare >= CLEAN_RASTER_MIN_PAPER_SHARE && m.colouredInkShare >= CLEAN_RASTER_MIN_COLOURED_INK_SHARE && m.droplets >= CLEAN_RASTER_MIN_DROPLETS && m.hueConcentration >= CLEAN_RASTER_MIN_HUE_CONCENTRATION;
  return cleanRaster || (m.paperShare >= SPLATTER_MIN_PAPER_SHARE && m.colouredInkShare >= SPLATTER_MIN_COLOURED_INK_SHARE && m.hueConcentration >= SPLATTER_MIN_HUE_CONCENTRATION && m.droplets >= SPLATTER_MIN_DROPLETS);
}
