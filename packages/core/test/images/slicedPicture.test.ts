import { describe, expect, it } from 'vitest';
import { shownBoxOfSlices } from '../../src/images/buildImageExtraction.js';
import { isShapedClip, type ClipInfo } from '../../src/inventory/clipPaths.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { OpaqueMask } from '../../src/images/opaqueOverlap.js';
import type { Matrix, Rect } from '../../src/geometry.js';

const clip = (paths: number[][][], ctm: Matrix = [1, 0, 0, 1, 0, 0]): ClipInfo => ({ paths, ctm, coverage: 0.5 });

describe('isShapedClip', () => {
  it('takes an upright rectangle (a frame) for no shape, and a polygon or several subpaths for one', () => {
    expect(isShapedClip(undefined)).toBe(false);
    expect(isShapedClip(clip([[[0, 0, 100, 0, 100, 50, 0, 50]]]))).toBe(false);
    expect(isShapedClip(clip([[[0, 0, 100, 0, 100, 50, 0, 50, 0, 0]]]))).toBe(false); // closed again at its first corner
    expect(isShapedClip(clip([[[0, 0, 80, 60, 50, 100, -30, 40]]]))).toBe(false); // a snapshot laid aslant
    expect(isShapedClip(clip([[[25, 593, 143, 576, 147, 586, 30, 626]]]))).toBe(true); // a slanted slice of a blade
    expect(isShapedClip(clip([[[0, 0, 100, 0, 50, 80]]]))).toBe(true);
    expect(isShapedClip(clip([[[0, 0, 10, 0, 10, 10, 0, 10], [20, 0, 30, 0, 30, 10, 20, 10]]]))).toBe(true);
  });
});

describe('shownBoxOfSlices', () => {
  const box = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });
  /** A 4×4 mask inked in its top half only. */
  const topHalf: OpaqueMask = { width: 4, height: 4, opaque: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]) };
  const slice = (objId: string, bbox: Rect, c: ClipInfo): ImageEntry => ({ objId, occurrences: [{ page: 1, bbox, index: 0, clip: c }] }) as unknown as ImageEntry;

  it('is the box of what the slices show: inked in their raster and inside their clip', () => {
    // A raster painted over 0-100 × 0-100, clipped to its left 60 pt: its top half is inked.
    const a = slice('a', box(0, 0, 100, 100), clip([[[0, 0, 60, 0, 60, 100, 0, 100, 0, 0]]], [100, 0, 0, 100, 0, 0]));
    const shown = shownBoxOfSlices([a], 1, new Map([['a', topHalf]]));
    expect(shown).toEqual(box(0, 50, 60, 100));
  });

  it('maps the raster through its matrix, so a turned slice shows where the page paints it', () => {
    // The raster turned a quarter: its top row lies along the right edge of the box.
    const turned = slice('t', box(0, 0, 100, 100), clip([[[0, 0, 100, 0, 100, 100, 0, 100, 0, 0]]], [0, -100, 100, 0, 0, 100]));
    const shown = shownBoxOfSlices([turned], 1, new Map([['t', topHalf]]));
    expect(shown).toEqual(box(50, 0, 100, 100));
  });

  it('reads a turned raster without a clip through the matrix it is painted with, and an upright one through its box', () => {
    const occurrence = (objId: string, bbox: Rect, extra: object): ImageEntry => ({ objId, occurrences: [{ page: 1, bbox, index: 0, ...extra }] }) as unknown as ImageEntry;
    const turned = occurrence('t', box(0, 0, 100, 100), { ctm: [0, -100, 100, 0, 0, 100], placement: { rotated: true } });
    expect(shownBoxOfSlices([turned], 1, new Map([['t', topHalf]]))).toEqual(box(50, 0, 100, 100));
    const upright = occurrence('u', box(10, 10, 50, 30), {});
    expect(shownBoxOfSlices([upright], 1, new Map([['u', topHalf]]))).toEqual(box(10, 20, 50, 30));
    const mirrored = occurrence('m', box(10, 10, 50, 30), { placement: { flipY: true } });
    expect(shownBoxOfSlices([mirrored], 1, new Map([['m', topHalf]]))).toEqual(box(10, 10, 50, 20));
  });

  it('is null when the slices show nothing (a slice cut along a line of text, its raster blank there)', () => {
    const blank: OpaqueMask = { width: 1, height: 1, opaque: Uint8Array.from([0]) };
    expect(shownBoxOfSlices([slice('b', box(0, 0, 10, 10), clip([[[0, 0, 10, 0, 5, 10]]], [10, 0, 0, 10, 0, 0]))], 1, new Map([['b', blank]]))).toBeNull();
  });
});
