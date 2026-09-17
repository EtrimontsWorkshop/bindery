import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Encoding into the target format (Step 7 Z6, MDD phase 3). WebP by default
 * (brief: "maps go out to every player, size matters"), PNG for images with
 * alpha where WebP falls short — the caller (orchestrator) decides which to
 * use when, this module just executes.
 *
 * The same pattern as `regionRenderer.ts` — one interface, two
 * implementations (browser: `OffscreenCanvas`/`convertToBlob`, here;
 * Node/tests: `@napi-rs/canvas`, in `nodeCanvasImageEncoder.ts`, deliberately
 * NOT EXPORTED from `index.ts` for the same reasons as `nodeCanvasRenderer.ts`).
 */

export type OutputFormat = 'webp' | 'png';

export interface EncodeOptions {
  format?: OutputFormat;
  /** 0-1 (Web convention — `HTMLCanvasElement.toBlob`/`convertToBlob`), WebP only. Ignored for PNG (lossless). */
  quality?: number;
}

export interface EncodedImage {
  format: OutputFormat;
  bytes: Uint8Array;
}

export interface ImageEncoder {
  encode(image: DecodedImage, opts?: EncodeOptions): Promise<EncodedImage>;
}

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'webp';
/**
 * [Calibrated in Step 43 Z2, see `RAPORT-KROK-43.md` for the method]
 * Measured on two real images from `sample/ZewCthulhu-WRAK.pdf` with
 * DIFFERENT character (p. 20, a ship cross-section — large flat/textured
 * areas of sky and ice; p. 26, an "Isaac Klein" portrait — smooth skin
 * gradients, fine detail) at six quality levels
 * (0.70/0.75/0.82/0.88/0.92/0.95): file size and mean absolute per-pixel
 * error (RGB) relative to the original AFTER re-decoding the WebP.
 *
 * [discovery, surprising relative to the brief's assumption] A painted,
 * TEXTURED illustration (the ship cross-section) is MORE tolerant of
 * compression, not LESS — its own brush noise/texture masks blocking
 * artifacts so effectively that q=0.70 and q=0.95 are visually
 * INDISTINGUISHABLE even at 2x zoom. The opposite is true: SMOOTH skin
 * gradients on the portrait are the MOST sensitive case — at q=0.70 visible
 * "blockiness" appears at edges (ear/cheek), disappearing entirely at
 * q=0.82; q=0.95 looks IDENTICAL to q=0.82 (confirmed visually), but the
 * file is over 2x larger (79KB vs 37KB for this crop) — pure cost with no
 * benefit.
 *
 * `0.82` (the original value, "from the brief") sits RIGHT at the boundary
 * where artifacts on the most sensitive case (the portrait) disappear,
 * without wasting bytes on quality that's already imperceptible — confirmed
 * visually by the product owner (`AskUserQuestion`, Step 43). Splitting by
 * purpose (map vs. token) was CONSIDERED and REJECTED: if anything, the
 * relationship is the OPPOSITE of the brief's assumption (maps/textured
 * scenes need LESS, not more) — and a single value already works well for
 * BOTH extreme cases in this sample, so the added complexity isn't
 * justified without further evidence.
 */
export const DEFAULT_WEBP_QUALITY = 0.82;

export const browserImageEncoder: ImageEncoder = {
  async encode(image, opts = {}) {
    const format = opts.format ?? DEFAULT_OUTPUT_FORMAT;
    const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
      | (new (
          w: number,
          h: number,
        ) => {
          getContext(id: '2d'): { putImageData(data: ImageData, dx: number, dy: number): void } | null;
          convertToBlob(opts: { type: string; quality?: number }): Promise<Blob>;
        })
      | undefined;
    if (!OffscreenCanvasCtor) {
      throw new Error('browserImageEncoder: OffscreenCanvas is not available in this environment (probably Node) — use nodeCanvasImageEncoder in tests.');
    }
    const canvas = new OffscreenCanvasCtor(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('browserImageEncoder: failed to create a 2D context for OffscreenCanvas');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: opts.quality ?? DEFAULT_WEBP_QUALITY });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { format, bytes };
  },
};
