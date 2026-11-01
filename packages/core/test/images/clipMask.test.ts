import { describe, expect, it } from 'vitest';
import { applyClipToImage, clipShowsWholePicture, renderThroughRectangularClip } from '../../src/images/clipMask.js';
import { flattenPath } from '../../src/inventory/clipPaths.js';

const M = 0;
const L = 1;
const Z = 4;
const rect = (x0: number, y0: number, x1: number, y1: number) => [M, x0, y0, L, x1, y0, L, x1, y1, L, x0, y1, Z];
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/** A w x h image whose pixel (x, y) has red = x and green = y, fully opaque. */
function gradient(w: number, h: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x, y, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

// The image is painted so that its 100x100 pixels cover the page square [0,100]x[0,100] (y up): the top row of
// pixels lies at page y = 100.
const CTM = [100, 0, 0, 100, 0, 0] as const;

describe('applyClipToImage', () => {
  it('leaves out what pictures painted over it cover, and keeps only the largest piece that is left', () => {
    // the whole page square, with the top 40 rows covered by one hole and a sliver at the bottom right left cut off from the rest by a second hole
    const clip = { paths: [flattenPath(rect(0, 0, 100, 100), IDENTITY)], ctm: CTM };
    const top = { paths: [flattenPath(rect(0, 60, 100, 100), IDENTITY)], ctm: CTM };
    const gap = { paths: [flattenPath(rect(0, 10, 100, 12), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip, { holes: [top, gap] });
    expect(out.height).toBe(48);
    expect(out.width).toBe(100);
  });

  it('crops to the visible part and keeps its pixels', () => {
    // the left half of the page square = the left 50 columns of the image
    const clip = { paths: [flattenPath(rect(0, 0, 50, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.width).toBe(50);
    expect(out.height).toBe(100);
    expect(out.rgba[0]).toBe(0);
    expect(out.rgba[(0 * 50 + 49) * 4]).toBe(49);
    expect(out.rgba[3]).toBe(255);
  });

  it('maps page y (up) to image rows (down)', () => {
    // the top quarter of the page square = the first 25 rows of the image
    const clip = { paths: [flattenPath(rect(0, 75, 100, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.height).toBe(25);
    expect(out.rgba[1]).toBe(0);
    expect(out.rgba[((24 * 100) + 0) * 4 + 1]).toBe(24);
  });

  it('makes what the clip hides inside the crop transparent (a diagonal clip)', () => {
    const triangle = flattenPath([M, 0, 0, L, 100, 0, L, 0, 100, Z], IDENTITY);
    const out = applyClipToImage(gradient(100, 100), { paths: [triangle], ctm: CTM });
    expect(out.width).toBe(100);
    // the upper-right corner pixel of the image lies outside the triangle
    expect(out.rgba[(0 * 100 + 99) * 4 + 3]).toBe(0);
    // the lower-left corner lies inside
    expect(out.rgba[(99 * 100 + 0) * 4 + 3]).toBe(255);
  });

  it('intersects several clips', () => {
    const clip = { paths: [flattenPath(rect(0, 0, 60, 100), IDENTITY), flattenPath(rect(40, 0, 100, 100), IDENTITY)], ctm: CTM };
    const out = applyClipToImage(gradient(100, 100), clip);
    expect(out.width).toBe(20);
    expect(out.rgba[0]).toBe(40);
  });

  it('returns the image itself when the clip leaves nothing or the CTM is singular', () => {
    const img = gradient(10, 10);
    expect(applyClipToImage(img, { paths: [flattenPath(rect(500, 500, 600, 600), IDENTITY)], ctm: CTM })).toBe(img);
    expect(applyClipToImage(img, { paths: [flattenPath(rect(0, 0, 50, 50), IDENTITY)], ctm: [0, 0, 0, 0, 0, 0] })).toBe(img);
    expect(applyClipToImage(img, { paths: [], ctm: CTM })).toBe(img);
  });

  it('keeps a pixel that was already transparent transparent', () => {
    const img = gradient(10, 10);
    img.rgba[3] = 0;
    const out = applyClipToImage(img, { paths: [flattenPath(rect(0, 0, 100, 100), IDENTITY)], ctm: [10, 0, 0, 10, 0, 0] });
    expect(out.rgba[3]).toBe(0);
  });
});

describe('applyClipToImage — a drawing on white paper under a blended clip', () => {
  const white = (w: number, h: number, ink: (x: number, y: number) => boolean) => {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(ink(x, y) ? [120, 60, 40, 255] : [255, 255, 255, 255], (y * w + x) * 4);
    return { width: w, height: h, rgba };
  };
  const triangle = [M, 0, 0, L, 100, 0, L, 0, 100, Z];
  const clip = { paths: [flattenPath(triangle, IDENTITY)], ctm: CTM };

  it('fills what the clip hides with white paper instead of leaving it transparent', () => {
    const out = applyClipToImage(white(100, 100, (x, y) => x < 20 && y > 80), clip, { hiddenBecomesPaper: true });
    // The top right corner of the image lies outside the clip.
    const corner = (0 * out.width + (out.width - 1)) * 4;
    expect(Array.from(out.rgba.slice(corner, corner + 4))).toEqual([255, 255, 255, 255]);
    expect(applyClipToImage(white(100, 100, () => false), clip).rgba[(out.width - 1) * 4 + 3]).toBe(0);
  });

  it('keeps the cut transparent when the picture is not mostly white', () => {
    const out = applyClipToImage(white(100, 100, () => true), clip, { hiddenBecomesPaper: true });
    expect(out.rgba[(out.width - 1) * 4 + 3]).toBe(0);
  });
});

describe('renderThroughRectangularClip — a window that is a rectangle tilted by a degree or so', () => {
  // The picture is turned by 30 degrees and shown through a window that is nearly, but not exactly, axis aligned.
  const angle = Math.PI / 6;
  const ctm = [100 * Math.cos(angle), 100 * Math.sin(angle), -100 * Math.sin(angle), 100 * Math.cos(angle), 40, 0] as const;
  const solid = (w: number, h: number) => ({ width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4).fill(200) });
  const window = (tilt: number) => [M, 48, 58 + tilt, L, 68, 58, L, 68.5, 78, L, 48.5, 78 + tilt, Z];

  it('cuts the window out upright when the window is a slightly tilted rectangle', () => {
    const out = renderThroughRectangularClip(solid(100, 100), { paths: [flattenPath(window(0.2), IDENTITY)], ctm });
    expect(out).not.toBeNull();
    expect(out!.width).toBeGreaterThan(15);
  });

  it('leaves a window that is not nearly a rectangle to the polygon cut', () => {
    const triangle = [M, 48, 58, L, 68, 58, L, 58, 78, Z];
    expect(renderThroughRectangularClip(solid(100, 100), { paths: [flattenPath(triangle, IDENTITY)], ctm })).toBeNull();
  });
});

describe('applyClipToImage — a tilted quadrilateral cut', () => {
  it('cuts to the largest upright rectangle inside a quadrilateral turned by a couple of degrees, without transparent corners', () => {
    // The page square is [0,100]^2; the clip is a square turned by about 2 degrees around its center.
    const c = 50;
    const a = (2 * Math.PI) / 180;
    const corner = (dx: number, dy: number) => [c + dx * Math.cos(a) - dy * Math.sin(a), c + dx * Math.sin(a) + dy * Math.cos(a)];
    const quad = [M, ...corner(-45, -45), L, ...corner(45, -45), L, ...corner(45, 45), L, ...corner(-45, 45), Z];
    const out = applyClipToImage(gradient(100, 100), { paths: [flattenPath(quad, IDENTITY)], ctm: CTM });
    expect(out.width).toBeLessThan(90);
    expect(out.width).toBeGreaterThan(60);
    const alphas = Array.from({ length: out.width * out.height }, (_, i) => out.rgba[i * 4 + 3]);
    expect(alphas.every((v) => v === 255)).toBe(true);
  });

  it('keeps the cut of a silhouette that has no large rectangle inside it', () => {
    const triangle = [M, 10, 10, L, 90, 10, L, 50, 90, Z];
    const out = applyClipToImage(gradient(100, 100), { paths: [flattenPath(triangle, IDENTITY)], ctm: CTM });
    const transparent = Array.from({ length: out.width * out.height }, (_, i) => out.rgba[i * 4 + 3]).filter((v) => v === 0).length;
    expect(transparent).toBeGreaterThan(0.2 * out.width * out.height);
  });
});

describe('clipShowsWholePicture', () => {
  const angle = (3 * Math.PI) / 180;
  // A picture turned by 3 degrees that covers about the whole page.
  const turned = [104 * Math.cos(angle), -104 * Math.sin(angle), 104 * Math.sin(angle), 104 * Math.cos(angle), -3, 5] as const;
  const pageClip = { paths: [flattenPath(rect(0, 0, 100, 100), IDENTITY)], ctm: turned };

  it('is true for a turned picture under a clip that covers its footprint (the page rectangle or its own outline)', () => {
    expect(clipShowsWholePicture(pageClip)).toBe(true);
    // The window sampler leaves such a picture to its raw pixels.
    expect(renderThroughRectangularClip({ width: 50, height: 50, rgba: new Uint8ClampedArray(50 * 50 * 4).fill(200) }, pageClip)).toBeNull();
  });

  it('is false for a frame cut out of a picture and for an upright picture', () => {
    expect(clipShowsWholePicture({ paths: [flattenPath(rect(20, 20, 80, 80), IDENTITY)], ctm: turned })).toBe(false);
    expect(clipShowsWholePicture({ paths: pageClip.paths, ctm: [100, 0, 0, 100, 0, 0] })).toBe(false);
  });
});

describe('applyClipToImage — a figure cut out on a transparent ground', () => {
  it('keeps the whole frame (and the parts of the figure in its slanted corners) instead of trimming it to an upright rectangle', () => {
    // A parallelogram frame; the figure (opaque) reaches into the slanted left corner, the ground around it is transparent.
    const w = 100;
    const h = 100;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - 20, y - 20) < 12 || (x > 40 && x < 90 && y > 30 && y < 70)) rgba.set([200, 50, 50, 255], (y * w + x) * 4);
    const frame = [M, 0, 0, L, 100, 0, L, 80, 100, L, -20, 100, Z];
    const out = applyClipToImage({ width: w, height: h, rgba }, { paths: [flattenPath(frame, IDENTITY)], ctm: CTM });
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
  });
});

