import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * The ornaments of a book's own design: drop caps, flourishes and seals drawn in one colour of ink on blank paper (red in many books), and the
 * thin strips of its frames. Each is a small picture nobody could judge, and a book has dozens of them; its illustrations are drawn in other
 * colours, or in many. Measured on one book: 30 ornaments in red (hue 355-8, saturation 0.32-0.70, ink on 0.07-0.35 of the picture), its
 * sepia portraits and sketches at hue 19 and saturation 0.2-0.35, its paintings in many hues; three frame strips in brown, 3.4-4 times as tall
 * as wide and inked on a tenth of their area; a tall misty landscape of the same book 2.5 times as tall.
 */

/** A pixel is ink when it is visible and its darkest channel is below this share of white. */
const INK_MAX_MIN_CHANNEL = 0.8;
/** A picture is drawn in one colour when its ink's hues (weighted by saturation) concentrate this much (1: one hue). */
const ONE_COLOUR_MIN_CONCENTRATION = 0.95;
/** Ornament ink is saturated this much at least: a sepia drawing is paler. */
const ORNAMENT_MIN_SATURATION = 0.3;
/** ... and covers this share of the picture at most: a line ornament on blank paper, not a picture filled with colour. */
const ORNAMENT_MAX_INK_SHARE = 0.4;
/** Hues within this many degrees of one another are one colour of ink. */
const ORNAMENT_HUE_TOLERANCE_DEG = 15;
/** A book's ornament colour is the colour of this many such pictures at least: one red seal or a red logo in a book is no style of the book. */
const BOOK_ORNAMENT_MIN_COUNT = 6;
/** A strip of a frame: this many times longer than wide, inked on this share of its area at most, in one colour. */
const FRAME_STRIP_MIN_ASPECT = 3.2;
const FRAME_STRIP_MAX_INK_SHARE = 0.15;

export interface InkStyle {
  /** The share of the visible pixels that are ink. */
  inkShare: number;
  /** The mean saturation (0-1) of the ink. */
  saturation: number;
  /** The mean hue (degrees) of the ink, weighted by saturation. */
  hue: number;
  /** How much the ink's hues concentrate around `hue` (0-1). */
  concentration: number;
}

export function measureInkStyle(image: DecodedImage): InkStyle | null {
  const { rgba } = image;
  let visible = 0;
  let ink = 0;
  let saturation = 0;
  let sx = 0;
  let sy = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 40000)));
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      if (rgba[i + 3]! <= 16) continue;
      visible++;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (min > INK_MAX_MIN_CHANNEL) continue;
      ink++;
      const s = max === 0 ? 0 : (max - min) / max;
      saturation += s;
      if (max === min) continue;
      const h6 = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
      const angle = (h6 * Math.PI) / 3;
      sx += Math.cos(angle) * s;
      sy += Math.sin(angle) * s;
    }
  }
  if (visible === 0 || ink === 0) return null;
  return {
    inkShare: ink / visible,
    saturation: saturation / ink,
    hue: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360,
    concentration: saturation > 0 ? Math.hypot(sx, sy) / saturation : 0,
  };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Whether a picture is a line ornament in one saturated colour on blank paper (see `ORNAMENT_MIN_SATURATION`). */
export function isOneColourOrnament(style: InkStyle): boolean {
  return style.concentration >= ONE_COLOUR_MIN_CONCENTRATION && style.saturation >= ORNAMENT_MIN_SATURATION && style.inkShare <= ORNAMENT_MAX_INK_SHARE;
}

/** Whether a picture is a thin strip of a frame: long and narrow, sparsely inked in one colour. */
export function isFrameStrip(style: InkStyle, width: number, height: number): boolean {
  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  return aspect >= FRAME_STRIP_MIN_ASPECT && style.inkShare <= FRAME_STRIP_MAX_INK_SHARE && style.concentration >= ONE_COLOUR_MIN_CONCENTRATION;
}

/**
 * Of the book's pictures (by their ink style), the ones that are its ornaments: those in the colour that at least `BOOK_ORNAMENT_MIN_COUNT` one-colour
 * line ornaments of the book share, and the thin strips of its frames when the book has such ornaments. Indices into `styles`.
 */
export function findBookOrnaments(pictures: readonly { style: InkStyle | null; width: number; height: number }[]): Set<number> {
  const ornaments = pictures.map((p, i) => ({ i, style: p.style })).filter((p): p is { i: number; style: InkStyle } => p.style !== null && isOneColourOrnament(p.style));
  const found = new Set<number>();
  for (const o of ornaments) {
    const sameColour = ornaments.filter((other) => hueDistance(other.style.hue, o.style.hue) <= ORNAMENT_HUE_TOLERANCE_DEG);
    if (sameColour.length >= BOOK_ORNAMENT_MIN_COUNT) found.add(o.i);
  }
  if (found.size === 0) return found;
  pictures.forEach((p, i) => {
    if (p.style !== null && isFrameStrip(p.style, p.width, p.height)) found.add(i);
  });
  return found;
}
