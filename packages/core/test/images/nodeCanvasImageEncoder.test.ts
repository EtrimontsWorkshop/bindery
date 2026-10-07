import { describe, expect, it } from 'vitest';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

function solidImage(w: number, h: number): DecodedImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 30;
    rgba[i * 4 + 2] = 30;
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

describe('nodeCanvasImageEncoder', () => {
  it('encodes to WebP by default — the RIFF....WEBP signature', async () => {
    const result = await nodeCanvasImageEncoder.encode(solidImage(16, 16));
    expect(result.format).toBe('webp');
    expect(result.bytes.length).toBeGreaterThan(0);
    const header = Buffer.from(result.bytes.slice(0, 12)).toString('ascii');
    expect(header.slice(0, 4)).toBe('RIFF');
    expect(header.slice(8, 12)).toBe('WEBP');
  });

  it('encodes to PNG on request — the PNG magic bytes signature', async () => {
    const result = await nodeCanvasImageEncoder.encode(solidImage(16, 16), { format: 'png' });
    expect(result.format).toBe('png');
    const bytes = result.bytes;
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // 'P'
    expect(bytes[2]).toBe(0x4e); // 'N'
    expect(bytes[3]).toBe(0x47); // 'G'
  });

  it('respects quality (a lower quality -> a smaller size for the same content)', async () => {
    // An image with real noise (not a flat color) — WebP with a flat color compresses almost
    // identically regardless of quality.
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = Math.floor(Math.random() * 256);
      rgba[i * 4 + 1] = Math.floor(Math.random() * 256);
      rgba[i * 4 + 2] = Math.floor(Math.random() * 256);
      rgba[i * 4 + 3] = 255;
    }
    const noisy: DecodedImage = { width: w, height: h, rgba };
    const high = await nodeCanvasImageEncoder.encode(noisy, { quality: 0.95 });
    const low = await nodeCanvasImageEncoder.encode(noisy, { quality: 0.2 });
    expect(low.bytes.length).toBeLessThan(high.bytes.length);
  });
});
