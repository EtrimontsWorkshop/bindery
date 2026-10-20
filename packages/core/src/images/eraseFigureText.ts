import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * A vector drawing is rendered as the part of the page its box covers, and the text of the page runs past it: strips of paragraphs in the empty corners of
 * the box. A pixel of the render is the drawing's when a shape of the drawing lies there; a pixel under a block of the page's text that no shape lies
 * under is the page's. Those are painted over with the color of the page around the drawing.
 */

/** A shape covers this many points beyond its own box (its outline, a stroke, anti-aliasing). */
const SHAPE_PAD_PT = 2;
/** At most this many pixels are sampled for the color of the page around the drawing. */
const MAX_COLOR_SAMPLES = 20000;

/**
 * `image` is the render of `region` (page space, y up) at any scale. Returns `image` itself when no text block touches the region or every one of them
 * lies over the drawing.
 */
export function eraseTextAroundFigure(image: DecodedImage, region: Rect, shapeBoxes: readonly Rect[], textBoxes: readonly Rect[]): DecodedImage {
  const regionWidth = region.maxX - region.minX;
  const regionHeight = region.maxY - region.minY;
  if (regionWidth <= 0 || regionHeight <= 0 || image.width <= 0 || image.height <= 0) return image;
  const scaleX = image.width / regionWidth;
  const scaleY = image.height / regionHeight;
  const { width, height } = image;

  const pixelBox = (box: Rect, pad: number): { x0: number; y0: number; x1: number; y1: number } => ({
    x0: Math.max(0, Math.floor((box.minX - pad - region.minX) * scaleX)),
    x1: Math.min(width, Math.ceil((box.maxX + pad - region.minX) * scaleX)),
    y0: Math.max(0, Math.floor((region.maxY - (box.maxY + pad)) * scaleY)),
    y1: Math.min(height, Math.ceil((region.maxY - (box.minY - pad)) * scaleY)),
  });

  // 1 = under text, 2 = under a shape of the drawing, 0 = neither.
  const mask = new Uint8Array(width * height);
  let anyText = false;
  for (const box of textBoxes) {
    const { x0, x1, y0, y1 } = pixelBox(box, 0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
    if (x1 > x0 && y1 > y0) anyText = true;
  }
  if (!anyText) return image;
  for (const box of shapeBoxes) {
    const { x0, x1, y0, y1 } = pixelBox(box, SHAPE_PAD_PT);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * width + x] = 2;
  }
  let erased = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) erased++;
  if (erased === 0) return image;

  // The page around the drawing: the median color of the pixels that are neither under text nor under a shape.
  const channels: [number[], number[], number[]] = [[], [], []];
  const stride = Math.max(1, Math.floor(mask.length / MAX_COLOR_SAMPLES));
  for (let i = 0; i < mask.length; i += stride) {
    if (mask[i] !== 0) continue;
    channels[0].push(image.rgba[i * 4]!);
    channels[1].push(image.rgba[i * 4 + 1]!);
    channels[2].push(image.rgba[i * 4 + 2]!);
  }
  const median = (values: number[]): number => (values.length === 0 ? 255 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
  const [r, g, b] = [median(channels[0]), median(channels[1]), median(channels[2])];

  const rgba = new Uint8ClampedArray(image.rgba);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
