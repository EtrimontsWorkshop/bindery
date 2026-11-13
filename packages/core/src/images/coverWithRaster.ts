import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Paints, inside `region` (page space), the pixels of `source` over `target`: both images are placed upright on the page,
 * `target` over `targetBox` and `source` over `sourceBox` (PDF space, y up; row 0 of an image is its top). Nearest
 * pixel; parts of `region` outside either box are left as they are. Modifies `target` in place.
 *
 * Used to take a picture that the page paints over a card of text back off the card's render: the card's own raster,
 * its paper, goes where the picture was (see `buildImageExtraction.ts`).
 */
export function coverWithRaster(target: DecodedImage, targetBox: Rect, source: DecodedImage, sourceBox: Rect, region: Rect): void {
  const tw = targetBox.maxX - targetBox.minX;
  const th = targetBox.maxY - targetBox.minY;
  const sw = sourceBox.maxX - sourceBox.minX;
  const sh = sourceBox.maxY - sourceBox.minY;
  if (tw <= 0 || th <= 0 || sw <= 0 || sh <= 0 || target.width <= 0 || target.height <= 0) return;
  const minX = Math.max(region.minX, targetBox.minX, sourceBox.minX);
  const maxX = Math.min(region.maxX, targetBox.maxX, sourceBox.maxX);
  const minY = Math.max(region.minY, targetBox.minY, sourceBox.minY);
  const maxY = Math.min(region.maxY, targetBox.maxY, sourceBox.maxY);
  if (maxX <= minX || maxY <= minY) return;

  const x0 = Math.max(0, Math.floor(((minX - targetBox.minX) / tw) * target.width));
  const x1 = Math.min(target.width, Math.ceil(((maxX - targetBox.minX) / tw) * target.width));
  const y0 = Math.max(0, Math.floor(((targetBox.maxY - maxY) / th) * target.height));
  const y1 = Math.min(target.height, Math.ceil(((targetBox.maxY - minY) / th) * target.height));
  for (let y = y0; y < y1; y++) {
    const py = targetBox.maxY - ((y + 0.5) / target.height) * th;
    const v = Math.floor(((sourceBox.maxY - py) / sh) * source.height);
    if (v < 0 || v >= source.height) continue;
    for (let x = x0; x < x1; x++) {
      const px = targetBox.minX + ((x + 0.5) / target.width) * tw;
      const u = Math.floor(((px - sourceBox.minX) / sw) * source.width);
      if (u < 0 || u >= source.width) continue;
      const t = (y * target.width + x) * 4;
      const s = (v * source.width + u) * 4;
      target.rgba[t] = source.rgba[s]!;
      target.rgba[t + 1] = source.rgba[s + 1]!;
      target.rgba[t + 2] = source.rgba[s + 2]!;
      target.rgba[t + 3] = source.rgba[s + 3]!;
    }
  }
}
