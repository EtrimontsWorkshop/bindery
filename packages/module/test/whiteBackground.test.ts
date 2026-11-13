import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bindery/core', () => ({ DEFAULT_WEBP_QUALITY: 0.9 }));

const { withWhiteBackground } = await import('../src/documents/whiteBackground.js');

/** Stubs the browser image APIs with a 2×1 picture whose second pixel has the given alpha. */
function stubImageApis(alpha: number) {
  const createImageBitmap = vi.fn(async () => ({ width: 2, height: 1, close: () => undefined }));
  const ctx = {
    drawImage: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, alpha]) }),
    fillRect: () => undefined,
    globalCompositeOperation: '',
    fillStyle: '',
  };
  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return ctx;
    }
    async convertToBlob() {
      return new Blob([new Uint8Array([9, 9])]);
    }
  }
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return createImageBitmap;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('withWhiteBackground', () => {
  it('decodes an opaque picture once, then returns it untouched without decoding again', async () => {
    const decode = stubImageApis(255);
    const input = { bytes: new Uint8Array([1, 2, 3]), format: 'webp' as const };
    expect(await withWhiteBackground(input)).toBe(input);
    expect(await withWhiteBackground(input)).toBe(input);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('fills a transparent picture, and does not decode the filled result again', async () => {
    const decode = stubImageApis(0);
    const filled = await withWhiteBackground({ bytes: new Uint8Array([4, 5, 6]), format: 'png' });
    expect([...filled.bytes]).toEqual([9, 9]);
    expect(await withWhiteBackground(filled)).toBe(filled);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('checks new bytes again (an edit replaces the array)', async () => {
    const decode = stubImageApis(255);
    await withWhiteBackground({ bytes: new Uint8Array([1]), format: 'webp' });
    await withWhiteBackground({ bytes: new Uint8Array([1]), format: 'webp' });
    expect(decode).toHaveBeenCalledTimes(2);
  });
});
