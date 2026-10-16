import { describe, expect, it } from 'vitest';
import { renderThroughRectangularClip } from '../../src/images/clipMask.js';
import type { Matrix } from '../../src/geometry.js';

/** 40x20 raster: the top-left pixel is red, everything else blue. */
function raster() {
  const width = 40;
  const height = 20;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([0, 0, 255, 255], i * 4);
  rgba.set([255, 0, 0, 255], 0);
  return { width, height, rgba };
}
const rect = (minX: number, minY: number, maxX: number, maxY: number) => [[[minX, minY, maxX, minY, maxX, maxY, minX, maxY]]] as const;
const pixel = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('renderThroughRectangularClip', () => {
  // Turned a quarter clockwise on the page: the raster's top edge runs down the right side of its box (e..e+20, f-40..f).
  const quarterClockwise: Matrix = [0, -40, 20, 0, 100, 300];

  it('shows the window as the page does: upright, the raster turned inside it', () => {
    const out = renderThroughRectangularClip(raster(), { paths: rect(100, 260, 120, 300), ctm: quarterClockwise });
    expect(out).not.toBeNull();
    expect([out!.width, out!.height]).toEqual([20, 40]);
    // The raster's top-left pixel is at the top-right of the window.
    expect(pixel(out!, 19, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(out!, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('cuts only the part of the picture the window shows', () => {
    const half = renderThroughRectangularClip(raster(), { paths: rect(100, 280, 120, 300), ctm: quarterClockwise });
    expect([half!.width, half!.height]).toEqual([20, 20]);
  });

  it('does not apply when the window reaches past the picture: the page then shows a turned picture on a page, and the upright raw picture is the better import', () => {
    expect(renderThroughRectangularClip(raster(), { paths: rect(90, 260, 120, 300), ctm: quarterClockwise })).toBeNull();
  });

  it('works for a slight tilt as well', () => {
    const angle = (10 * Math.PI) / 180;
    const ctm: Matrix = [40 * Math.cos(angle), 40 * Math.sin(angle), -20 * Math.sin(angle), 20 * Math.cos(angle), 100, 100];
    const out = renderThroughRectangularClip(raster(), { paths: rect(110, 105, 135, 115), ctm });
    expect(out).not.toBeNull();
    expect(pixel(out!, Math.floor(out!.width / 2), Math.floor(out!.height / 2))[3]).toBe(255);
  });

  it('does not apply to an upright picture, a clip that is not a rectangle, or a mirrored picture', () => {
    expect(renderThroughRectangularClip(raster(), { paths: rect(100, 300, 140, 320), ctm: [40, 0, 0, 20, 100, 300] })).toBeNull();
    const triangle = [[[100, 260, 120, 260, 110, 300]]] as const;
    expect(renderThroughRectangularClip(raster(), { paths: triangle, ctm: quarterClockwise })).toBeNull();
    expect(renderThroughRectangularClip(raster(), { paths: rect(100, 260, 120, 300), ctm: [0, 40, 20, 0, 100, 300] })).toBeNull();
  });
});
