import { DEFAULT_WEBP_QUALITY } from '@bindery/core';

/**
 * Puts a white background behind an image that has transparent pixels (a sketch or a line drawing exported without
 * a background is hard to read on a dark scene or journal page). An image without any transparency is returned as it
 * is, with no re-encoding; so is one that cannot be decoded. Pure browser APIs (no Foundry globals), used when the "white
 * background" setting is on and an image is saved: the analysis has already put the background on every image (in core,
 * before encoding), and this covers later edits (rotation, token preparation) that bring transparency back.
 */

/** Alpha below this counts as transparent: anti-aliased edges of an opaque picture are not a reason to re-encode it. */
const TRANSPARENT_ALPHA_MAX = 250;

export interface ImageBytes {
  bytes: Uint8Array;
  format: 'webp' | 'png';
}

/**
 * Byte arrays already known to have no transparent pixels: returned by `withWhiteBackground` (or found opaque by it).
 * With the setting on, every picture passes through it twice — before the review and again on upload — and the second
 * pass would decode and scan every image again for nothing. An edit replaces the bytes with a NEW array, which is
 * checked again; a WeakSet lets dropped arrays go.
 */
const knownOpaque = new WeakSet<Uint8Array>();

export async function withWhiteBackground(input: ImageBytes): Promise<ImageBytes> {
  if (knownOpaque.has(input.bytes)) return input;
  try {
    const mime = input.format === 'png' ? 'image/png' : 'image/webp';
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(input.bytes)], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return input;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hasTransparency = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < TRANSPARENT_ALPHA_MAX) {
        hasTransparency = true;
        break;
      }
    }
    if (!hasTransparency) {
      knownOpaque.add(input.bytes);
      return input;
    }
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: mime, ...(input.format === 'webp' ? { quality: DEFAULT_WEBP_QUALITY } : {}) });
    const filled = new Uint8Array(await blob.arrayBuffer());
    knownOpaque.add(filled);
    return { bytes: filled, format: input.format };
  } catch (err) {
    console.warn('Bindery | adding a white background failed, the image is saved as it is:', err);
    return input;
  }
}

/**
 * Records the images of an analysis that already put the white background on (core does it on the decoded pixels,
 * before the one encoding — `whiteBackground` of `buildCIFFromDocument`), so that saving them does not decode every one
 * again only to find nothing transparent. An image edited later gets a new byte array and is checked when it is saved.
 */
export function markAllOpaque(imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>): void {
  for (const entry of imageBytesById.values()) knownOpaque.add(entry.bytes);
}
