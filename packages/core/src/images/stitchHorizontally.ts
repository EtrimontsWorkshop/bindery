import type { DecodedImage } from './normalizeDecodedImage.js';

/** `image` scaled to `height` pixels tall, keeping its proportions (nearest neighbor: it only absorbs a rounding difference between two renders). */
function scaleToHeight(image: DecodedImage, height: number): DecodedImage {
  if (image.height === height) return image;
  const width = Math.max(1, Math.round((image.width * height) / image.height));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      rgba.set(image.rgba.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

/** Two images side by side, the second one after the first (the halves of a picture that runs across two pages). The right one is scaled to the left one's height when they differ. */
export function stitchHorizontally(left: DecodedImage, right: DecodedImage): DecodedImage {
  const second = scaleToHeight(right, left.height);
  const width = left.width + second.width;
  const rgba = new Uint8ClampedArray(width * left.height * 4);
  for (let y = 0; y < left.height; y++) {
    rgba.set(left.rgba.subarray(y * left.width * 4, (y + 1) * left.width * 4), y * width * 4);
    rgba.set(second.rgba.subarray(y * second.width * 4, (y + 1) * second.width * 4), (y * width + left.width) * 4);
  }
  return { width, height: left.height, rgba };
}
