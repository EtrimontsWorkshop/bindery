import { describe, expect, it } from 'vitest';
import { dominantTextAngle, turnUpright } from '../../src/images/readingTurn.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

const REGION = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const text = (angle: number, chars = 10, at = 50) => ({ minX: at - 5, minY: at - 5, maxX: at + 5, maxY: at + 5, angle, chars });

/** A 4x2 image whose top-left pixel is red and the rest black. */
function marked(): DecodedImage {
  const rgba = new Uint8ClampedArray(4 * 2 * 4);
  for (let i = 0; i < 8; i++) rgba.set([0, 0, 0, 255], i * 4);
  rgba.set([255, 0, 0, 255], 0);
  return { width: 4, height: 2, rgba };
}
const redAt = (img: DecodedImage): [number, number] => {
  for (let i = 0; i < img.width * img.height; i++) if (img.rgba[i * 4] === 255) return [i % img.width, Math.floor(i / img.width)];
  return [-1, -1];
};

describe('dominantTextAngle', () => {
  it('is the direction most of the text on the region runs in', () => {
    expect(dominantTextAngle(REGION, [text(90), text(90), text(91), text(0, 5)])).toBeCloseTo(90.3, 0);
  });

  it('is null for too little text, for text outside the region, or for text without a direction', () => {
    expect(dominantTextAngle(REGION, [text(90, 5)])).toBeNull();
    expect(dominantTextAngle(REGION, [text(90, 30, 500)])).toBeNull();
    expect(dominantTextAngle(REGION, [{ minX: 40, minY: 40, maxX: 60, maxY: 60, chars: 30 }])).toBeNull();
  });

  it('is null when no direction holds most of the text', () => {
    expect(dominantTextAngle(REGION, [text(0, 15), text(90, 15)])).toBeNull();
  });

  it('averages directions across the turn of the circle', () => {
    expect(Math.abs(dominantTextAngle(REGION, [text(179, 15), text(-179, 15)])!)).toBeCloseTo(180, 0);
  });
});

describe('turnUpright', () => {
  it('leaves upright text, and text within a degree and a half of it, as it is', () => {
    expect(turnUpright(marked(), 0)).toBeNull();
    expect(turnUpright(marked(), 1)).toBeNull();
  });

  it('turns text running up the page a quarter clockwise, and text running down a quarter counterclockwise', () => {
    // Text running up: what was the image's left edge (where lines start) becomes its top.
    const up = turnUpright(marked(), 90)!;
    expect([up.width, up.height]).toEqual([2, 4]);
    expect(redAt(up)).toEqual([1, 0]);
    const down = turnUpright(marked(), -90)!;
    expect(redAt(down)).toEqual([0, 3]);
    const upsideDown = turnUpright(marked(), 180)!;
    expect(redAt(upsideDown)).toEqual([3, 1]);
  });

  it('straightens a tilted card onto a canvas that holds all of it', () => {
    const image: DecodedImage = { width: 100, height: 50, rgba: new Uint8ClampedArray(100 * 50 * 4).fill(255) };
    const turned = turnUpright(image, 10)!;
    const rad = (10 * Math.PI) / 180;
    expect(turned.width).toBe(Math.round(100 * Math.cos(rad) + 50 * Math.sin(rad)));
    expect(turned.height).toBe(Math.round(100 * Math.sin(rad) + 50 * Math.cos(rad)));
    // The corners are outside the card: transparent.
    expect(turned.rgba[3]).toBe(0);
  });
});
