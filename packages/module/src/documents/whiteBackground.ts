import { DEFAULT_WEBP_QUALITY } from '@bindery/core';

/**
 * Puts a white background behind an image that has transparent pixels (a sketch or a line drawing exported without
 * a background is hard to read on a dark scene or journal page). An image without any transparency is returned as it
 * is, with no re-encoding; so is one that cannot be decoded. Pure browser APIs (no Foundry globals), used when the "white
 * background" setting is on: on the analysis result before the review (`addWhiteBackgroundToAll`) and again when an
 * image is saved, which covers later edits (rotation, token preparation) that bring transparency back.
 */

/** Alpha below this counts as transparent: anti-aliased edges of an opaque picture are not a reason to re-encode it. */
const TRANSPARENT_ALPHA_MAX = 250;

export interface ImageBytes {
  bytes: Uint8Array;
  format: 'webp' | 'png';
}

export async function withWhiteBackground(input: ImageBytes): Promise<ImageBytes> {
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
    if (!hasTransparency) return input;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: mime, ...(input.format === 'webp' ? { quality: DEFAULT_WEBP_QUALITY } : {}) });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), format: input.format };
  } catch (err) {
    console.warn('Bindery | adding a white background failed, the image is saved as it is:', err);
    return input;
  }
}

/**
 * Applies `withWhiteBackground` to every image of an analysis result, in place: the review screen (thumbnails, editor,
 * rotation of the original) then works on pictures that already have the background.
 */
export async function addWhiteBackgroundToAll(imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>): Promise<void> {
  const target = imageBytesById as Map<string, { bytes: Uint8Array; format: string }>;
  for (const [id, entry] of [...target]) {
    if (entry.format !== 'webp' && entry.format !== 'png') continue;
    const filled = await withWhiteBackground({ bytes: entry.bytes, format: entry.format });
    if (filled.bytes !== entry.bytes) target.set(id, { bytes: filled.bytes, format: filled.format });
  }
}
