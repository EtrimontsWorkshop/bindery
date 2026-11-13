import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Alpha below this counts as transparent. Anti-aliased edges of an otherwise opaque picture are not a reason to touch
 * it. The Foundry layer uses the same figure when it checks an image edited by hand (`whiteBackground.ts` there).
 */
export const TRANSPARENT_ALPHA_MAX = 250;

/**
 * The image over a white background, when it has transparent pixels; the same object when it has none. Done on the
 * decoded pixels BEFORE the one encoding, so that a picture is not decoded and encoded (with loss, for WebP) a second
 * time just to get its background.
 */
export function flattenOnWhite(image: DecodedImage): DecodedImage {
  const source = image.rgba;
  let transparentAt = -1;
  for (let i = 3; i < source.length; i += 4) {
    if (source[i]! < TRANSPARENT_ALPHA_MAX) {
      transparentAt = i;
      break;
    }
  }
  if (transparentAt < 0) return image;

  const rgba = new Uint8ClampedArray(source);
  for (let i = transparentAt - 3; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3]!;
    if (alpha === 255) continue;
    const white = 255 - alpha;
    rgba[i] = (rgba[i]! * alpha + 255 * white) / 255;
    rgba[i + 1] = (rgba[i + 1]! * alpha + 255 * white) / 255;
    rgba[i + 2] = (rgba[i + 2]! * alpha + 255 * white) / 255;
    rgba[i + 3] = 255;
  }
  return { width: image.width, height: image.height, rgba };
}
