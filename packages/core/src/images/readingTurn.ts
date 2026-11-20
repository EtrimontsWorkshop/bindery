import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { rotateAndCropImage } from './rotateCrop.js';
import { rotateQuarterTurns } from './rotateQuarterTurns.js';

/**
 * A card of text that the book prints turned (a letter set sideways in a column) or tilted (a note lying askew) is
 * offered turned the way it reads: its text runs left to right. The direction of the text is the page's own — pdf.js
 * gives every piece of text with the matrix it is drawn with — so a card whose text is drawn into its raster (a form)
 * has none and is left as it is.
 */

/** A text item's box with the direction of its text (degrees counterclockwise in page space) and its length. */
export interface DirectedText extends Rect {
  angle?: number;
  chars?: number;
}

/** Characters of text a card must hold for its direction to be read from it. */
const MIN_CHARS = 20;
/** Items within this many degrees of one another run the same way. */
const SAME_DIRECTION_DEG = 3;
/** Share of the card's characters that must run the same way for that to be its direction. */
const MIN_DIRECTION_SHARE = 0.6;
/** A card whose text is upright within this many degrees is left as it is (a hand-set line wavers by a degree). */
const UPRIGHT_TOLERANCE_DEG = 1.5;

/** Degrees to (-180, 180]. */
function normalize(angle: number): number {
  let a = angle % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a;
}

/**
 * The direction the text lying on `region` runs in (degrees counterclockwise in page space), weighted by length: the
 * direction most of its characters share. `null` when there is too little text, when it has no direction given, or
 * when no direction holds most of it.
 */
export function dominantTextAngle(region: Rect, texts: readonly DirectedText[] | undefined): number | null {
  const inside = (texts ?? []).filter((t) => {
    if (t.angle === undefined) return false;
    const cx = (t.minX + t.maxX) / 2;
    const cy = (t.minY + t.maxY) / 2;
    return cx >= region.minX && cx <= region.maxX && cy >= region.minY && cy <= region.maxY;
  });
  const total = inside.reduce((sum, t) => sum + (t.chars ?? 1), 0);
  if (total < MIN_CHARS) return null;
  let best: { weight: number; angle: number } | null = null;
  for (const candidate of inside) {
    const around = inside.filter((t) => Math.abs(normalize(t.angle! - candidate.angle!)) <= SAME_DIRECTION_DEG);
    const weight = around.reduce((sum, t) => sum + (t.chars ?? 1), 0);
    if (best !== null && weight <= best.weight) continue;
    // The mean of the directions around the candidate, taken relative to it (so that 179 and -179 average to 180).
    const mean = candidate.angle! + around.reduce((sum, t) => sum + normalize(t.angle! - candidate.angle!) * (t.chars ?? 1), 0) / weight;
    best = { weight, angle: normalize(mean) };
  }
  return best !== null && best.weight >= MIN_DIRECTION_SHARE * total ? best.angle : null;
}

/**
 * `image` turned so that text running at `angle` (degrees counterclockwise in page space) reads left to right; `null`
 * when it already does. A turn by quarter turns is exact; any other is resampled, onto a canvas large enough to hold
 * the whole turned image (its corners transparent).
 */
export function turnUpright(image: DecodedImage, angle: number): DecodedImage | null {
  const a = normalize(angle);
  if (Math.abs(a) <= UPRIGHT_TOLERANCE_DEG) return null;
  const quarters = Math.round(a / 90);
  if (Math.abs(a - quarters * 90) <= UPRIGHT_TOLERANCE_DEG) {
    // Text running up the page (90) is turned a quarter clockwise, text running down it (-90) a quarter counterclockwise.
    const turns = (((quarters % 4) + 4) % 4) as 0 | 1 | 2 | 3;
    return turns === 0 ? null : rotateQuarterTurns(image, turns);
  }
  // In the image (y down) the text runs at -a: the output's x axis is laid along it.
  const rad = (-a * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return rotateAndCropImage(image, {
    centerX: image.width / 2,
    centerY: image.height / 2,
    outputWidth: Math.round(image.width * cos + image.height * sin),
    outputHeight: Math.round(image.width * sin + image.height * cos),
    rotationRad: rad,
  });
}

/**
 * A document the book prints on its side (a newspaper cutting or an open notebook turned a quarter to fit the page),
 * whose text is part of its picture: stood up again. The page gives no direction for text drawn into a raster, so the
 * rule above cannot turn it; what tells is the placement and the pixels together. The PDF stores such a scan upright
 * and paints it turned by a quarter, so the stored orientation is the one it reads in — but only when it does read:
 * most pictures painted with a quarter turn are stored sideways and stand upright on the page (130 of the 139 such
 * pictures in twenty labelled books were right as the page shows them; the nine that were not were all documents
 * lying on their side).
 *
 * `image` is the picture as the page shows it, `placedTurns` the quarter turns (clockwise) the page applied to the
 * stored raster, `readsAsDocument` the judge of rows of text in pixels. Returns the picture turned back, or `null`
 * when it reads as it is or does not read either way.
 */
export function standUpSidewaysDocument(
  image: DecodedImage,
  placedTurns: 1 | 3,
  readsAsDocument: (image: DecodedImage) => boolean,
  /** Whether lettering drawn into the picture runs up and down it (see `sidewaysText.ts`). */
  liesSideways: (image: DecodedImage) => boolean = () => false,
): DecodedImage | null {
  const stoodUp = rotateQuarterTurns(image, placedTurns === 1 ? 3 : 1);
  if (!readsAsDocument(image)) return readsAsDocument(stoodUp) ? stoodUp : null;
  // A document that reads either way by its rows (a cutting, a notebook full of writing): its lettering tells. Running up and
  // down as the page shows it, the picture is turned back to the way the PDF stores it. Measured: a newspaper cutting and an
  // open notebook in one book, both read only so.
  return readsAsDocument(stoodUp) && liesSideways(image) ? stoodUp : null;
}
