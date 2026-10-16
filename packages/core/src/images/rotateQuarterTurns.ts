import type { DecodedImage } from './normalizeDecodedImage.js';

/** Turns an image by whole quarter turns clockwise (1 = 90°, 2 = 180°, 3 = 270°). Pure; the input is not changed. */
export function rotateQuarterTurns(image: DecodedImage, turns: 1 | 2 | 3): DecodedImage {
  const { width, height, rgba } = image;
  const swap = turns !== 2;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Where the pixel (x, y) of the source lands in the turned image.
      const [nx, ny] = turns === 1 ? [height - 1 - y, x] : turns === 2 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x];
      const from = (y * width + x) * 4;
      const to = (ny * outWidth + nx) * 4;
      out[to] = rgba[from]!;
      out[to + 1] = rgba[from + 1]!;
      out[to + 2] = rgba[from + 2]!;
      out[to + 3] = rgba[from + 3]!;
    }
  }
  return { width: outWidth, height: outHeight, rgba: out };
}
