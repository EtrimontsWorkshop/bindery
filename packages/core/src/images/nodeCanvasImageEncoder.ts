import { createCanvas, ImageData as NapiImageData } from '@napi-rs/canvas';
import { DEFAULT_OUTPUT_FORMAT, DEFAULT_WEBP_QUALITY, type EncodeOptions, type EncodedImage, type ImageEncoder } from './encodeImage.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Implementacja Node (`@napi-rs/canvas`) — WYLACZNIE do testow i
 * `tools/calibrate-images.ts`. Ten sam powod nieeksportowania z `index.ts` co
 * `nodeCanvasRenderer.ts` (natywny dodatek, bundler przegladarki nie potrafi
 * go zbundlowac) — patrz komentarz tam.
 */
export const nodeCanvasImageEncoder: ImageEncoder = {
  async encode(image: DecodedImage, opts: EncodeOptions = {}): Promise<EncodedImage> {
    const format = opts.format ?? DEFAULT_OUTPUT_FORMAT;
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new NapiImageData(image.rgba, image.width, image.height), 0, 0);
    const bytes =
      format === 'png'
        ? await canvas.encode('png')
        : await canvas.encode('webp', Math.round((opts.quality ?? DEFAULT_WEBP_QUALITY) * 100));
    return { format, bytes: new Uint8Array(bytes) };
  },
};
