import { describe, expect, it } from 'vitest';
import { detectGrid } from '../../src/images/detectGrid.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * Luminance pixels = the sum of TWO independent "sawtooth" functions (one in X, one in Y), each
 * with its own period/offset. The HORIZONTAL gradient (d/dx) depends ONLY on the X component (the
 * Y component is constant along a row) and vice versa for the VERTICAL gradient — this gives a
 * CLEAN, unambiguous periodicity signal on each axis separately (one sharp jump per period, not
 * two edges as with a drawn line), easy to predict in tests.
 */
function sawtooth(pos: number, size: number, offset: number): number {
  return ((((pos - offset) % size) + size) % size) / size;
}

function makeGridImage(width: number, height: number, sizeX: number, offsetX: number, sizeY: number, offsetY: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(sawtooth(x, sizeX, offsetX) * 100 + sawtooth(y, sizeY, offsetY) * 100 + 20);
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function flatImage(width: number, height: number, value: number): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(value);
  return { width, height, rgba };
}

describe('detectGrid', () => {
  it('detects a square grid of a known size/offset (both axes agree)', () => {
    const img = makeGridImage(200, 200, 40, 5, 40, 12);
    const result = detectGrid(img, { minSize: 10, maxSize: 80 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe(40);
    expect(result!.offsetX).toBe(5);
    expect(result!.offsetY).toBe(12);
    expect(result!.confidence).toBeGreaterThan(0.3);
  });

  it('two axes with DIFFERENT periods -> the size is the mean, the confidence lowered by the disagreement', () => {
    const img = makeGridImage(300, 300, 40, 0, 60, 0);
    const agreeing = detectGrid(makeGridImage(300, 300, 40, 0, 40, 0), { minSize: 10, maxSize: 100 });
    const disagreeing = detectGrid(img, { minSize: 10, maxSize: 100 });
    expect(disagreeing).not.toBeNull();
    expect(disagreeing!.size).toBe(50); // (40+60)/2
    expect(disagreeing!.confidence).toBeLessThan(agreeing!.confidence);
  });

  it('only ONE axis has periodicity (the other constant) -> detects the size from it, the offset of the other axis = 0', () => {
    // The Y component constantly 0 -> rowProfile completely flat -> no signal on this axis.
    const img = makeGridImage(200, 200, 30, 7, 1, 0);
    const result = detectGrid(img, { minSize: 10, maxSize: 60 });
    expect(result).not.toBeNull();
    expect(result!.size).toBe(30);
    expect(result!.offsetX).toBe(7);
    expect(result!.offsetY).toBe(0);
  });

  it('a completely flat image (no edge at all) -> null, doesn\'t guess', () => {
    const img = flatImage(200, 200, 128);
    expect(detectGrid(img)).toBeNull();
  });

  it('an image below the minimum edge -> null', () => {
    const img = makeGridImage(20, 20, 5, 0, 5, 0);
    expect(detectGrid(img)).toBeNull();
  });

  it('maxSize <= minSize (e.g. a very small image relative to the options) -> null, doesn\'t throw', () => {
    const img = makeGridImage(50, 50, 10, 0, 10, 0);
    expect(detectGrid(img, { minSize: 100, maxSize: 50 })).toBeNull();
  });

  it('determinism: two calls on the same data give an identical result', () => {
    const img = makeGridImage(150, 150, 25, 3, 25, 8);
    const a = detectGrid(img);
    const b = detectGrid(img);
    expect(a).toEqual(b);
  });

  it('doesn\'t find a false multiple of the period (e.g. 2x the real size)', () => {
    const img = makeGridImage(240, 240, 30, 0, 30, 0);
    const result = detectGrid(img, { minSize: 10, maxSize: 100 });
    expect(result!.size).toBe(30);
    expect(result!.size).not.toBe(60);
    expect(result!.size).not.toBe(90);
  });
});
