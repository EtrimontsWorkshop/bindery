import { describe, expect, it } from 'vitest';
import { findTilt, straightenTiltedPicture } from '../../src/images/tiltedRectangle.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/** A transparent canvas with the pixels for which `inside(x, y)` holds painted opaque grey. */
function shape(width: number, height: number, inside: (x: number, y: number) => boolean): DecodedImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x + 0.5, y + 0.5)) rgba.set([120, 110, 100, 255], (y * width + x) * 4);
  return { width, height, rgba };
}

/** A 300 x 180 rectangle centred on (200, 150), turned by `deg` (image space, y down). */
function tiltedPrint(deg: number, width = 400, height = 300): DecodedImage {
  const rad = (deg * Math.PI) / 180;
  return shape(width, height, (x, y) => {
    const dx = x - 200;
    const dy = y - 150;
    const u = dx * Math.cos(rad) + dy * Math.sin(rad);
    const v = -dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(u) <= 150 && Math.abs(v) <= 90;
  });
}

const opaqueShare = (image: DecodedImage): number => {
  let n = 0;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i]! >= 128) n++;
  return n / (image.width * image.height);
};

describe('findTilt and straightenTiltedPicture', () => {
  it('finds the tilt of a print lying askew and straightens it to an opaque rectangle of about its size', () => {
    const print = tiltedPrint(10);
    expect(findTilt(print)).toBeCloseTo(10, 0);
    const straight = straightenTiltedPicture(print)!;
    expect(straight).not.toBeNull();
    expect(opaqueShare(straight)).toBeGreaterThan(0.99);
    expect(straight.width).toBeGreaterThan(270);
    expect(straight.height).toBeGreaterThan(150);
  });

  it('straightens a print that the raster cuts on its sides too', () => {
    // The raster is narrower than the turned print: its left and right edges cut it.
    const cut = tiltedPrint(-10, 360, 300);
    expect(findTilt(cut)).not.toBeNull();
    expect(straightenTiltedPicture(cut)).not.toBeNull();
  });

  it('leaves an upright picture with one edge cut on a slant by the page as it is, but straightens a print showing one side at a clear tilt', () => {
    // The raster's bottom edge cut on a slant of 2 degrees: one side only, a small angle.
    const slant = Math.tan((2 * Math.PI) / 180);
    expect(findTilt(shape(400, 200, (x, y) => y <= 170 + (x - 200) * slant))).toBeNull();
    // A print turned by 8 degrees that the raster cuts everywhere but along its top side.
    const steep = Math.tan((8 * Math.PI) / 180);
    expect(findTilt(shape(400, 200, (x, y) => y >= 40 - (x - 200) * steep))).not.toBeNull();
  });

  it('leaves an upright picture, a nearly upright one and a cut-out of another shape as they are', () => {
    expect(straightenTiltedPicture(shape(300, 200, () => true))).toBeNull();
    expect(straightenTiltedPicture(tiltedPrint(1))).toBeNull();
    expect(straightenTiltedPicture(shape(300, 300, (x, y) => (x - 150) ** 2 + (y - 150) ** 2 <= 140 ** 2))).toBeNull();
  });
});
