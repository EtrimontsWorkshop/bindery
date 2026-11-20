import { describe, expect, it } from 'vitest';
import { askewRectangleOf, askewRectangleOfPainting, askewRectangleOfPolygon } from '../../src/images/askewCard.js';

const turned = (w: number, h: number, deg: number, x: number, y: number, flipX = false): [number, number, number, number, number, number] => {
  const r = (deg * Math.PI) / 180;
  const sx = flipX ? -1 : 1;
  return [sx * w * Math.cos(r), sx * w * Math.sin(r), -h * Math.sin(r), h * Math.cos(r), x, y];
};

describe('askewRectangleOf', () => {
  it('gives the turned rectangle of a card laid a few degrees askew, its centre and its tilt', () => {
    const rect = askewRectangleOf(turned(400, 300, 3, 100, 200))!;
    expect(rect.rotationRad).toBeCloseTo((3 * Math.PI) / 180, 6);
    expect(rect.width).toBeCloseTo(400 * 0.96, 6);
    expect(rect.height).toBeCloseTo(300 * 0.96, 6);
    const r = (3 * Math.PI) / 180;
    expect(rect.centerX).toBeCloseTo(100 + (400 * Math.cos(r) - 300 * Math.sin(r)) / 2, 6);
  });

  it('gives the tilt of a mirrored card as the page shows it, and swaps the sides of one stored sideways', () => {
    expect(askewRectangleOf(turned(400, 300, -2, 500, 200, true))!.rotationRad).toBeCloseTo((-2 * Math.PI) / 180, 6);
    const sideways = askewRectangleOf(turned(400, 300, 92, 100, 200))!;
    expect(sideways.rotationRad).toBeCloseTo((2 * Math.PI) / 180, 6);
    expect(sideways.width).toBeCloseTo(300 * 0.96, 6);
  });

  it('takes no upright raster, no picture set on its corner and no sheared raster for a card askew', () => {
    expect(askewRectangleOf([400, 0, 0, 300, 0, 0])).toBeNull();
    expect(askewRectangleOf(turned(400, 300, 45, 0, 0))).toBeNull();
    expect(askewRectangleOf([400, 0, 100, 300, 0, 0])).toBeNull();
  });
});

describe('askewRectangleOfPolygon', () => {
  it('gives the turned rectangle of a clip of four corners, and none for another shape', () => {
    const r = (2 * Math.PI) / 180;
    const corners = [
      [100, 100],
      [100 + 400 * Math.cos(r), 100 + 400 * Math.sin(r)],
      [100 + 400 * Math.cos(r) - 300 * Math.sin(r), 100 + 400 * Math.sin(r) + 300 * Math.cos(r)],
      [100 - 300 * Math.sin(r), 100 + 300 * Math.cos(r)],
    ].flat();
    const rect = askewRectangleOfPolygon(corners)!;
    expect(rect.rotationRad).toBeCloseTo(r, 6);
    expect(rect.width).toBeCloseTo(400 * 0.96, 4);
    expect(askewRectangleOfPolygon([0, 0, 400, 10, 380, 300, 10, 290])).toBeNull();
    expect(askewRectangleOfPolygon([0, 0, 400, 10, 380, 300])).toBeNull();
  });
});

describe('askewRectangleOfPainting', () => {
  const raster = turned(515, 357, 3.75, 71, 9);
  it('takes a raster turned behind an upright rectangular window for upright, as the page shows it', () => {
    const window = [70, 43, 564, 42, 564, 365, 71, 366];
    expect(askewRectangleOfPainting({ clip: { paths: [[window]], ctm: raster } })).toBeNull();
  });
  it('takes the turn of a rectangular window cut into the raster', () => {
    const r = (1 * Math.PI) / 180;
    const window = [100, 100, 100 + 400 * Math.cos(r), 100 + 400 * Math.sin(r), 100 + 400 * Math.cos(r) - 300 * Math.sin(r), 100 + 400 * Math.sin(r) + 300 * Math.cos(r), 100 - 300 * Math.sin(r), 100 + 300 * Math.cos(r)];
    expect(askewRectangleOfPainting({ clip: { paths: [[window]], ctm: raster } })!.rotationRad).toBeCloseTo(r, 6);
  });
  it('takes the turn of the raster itself without a clip, or under a clip of another shape', () => {
    expect(askewRectangleOfPainting({ ctm: raster })!.rotationRad).toBeCloseTo((3.75 * Math.PI) / 180, 6);
    expect(askewRectangleOfPainting({ clip: { paths: [[[0, 0, 400, 10, 380, 300, 10, 290]]], ctm: raster } })!.rotationRad).toBeCloseTo((3.75 * Math.PI) / 180, 6);
  });
  it('takes the turn of a clip that is all but a rectangle (a print with a corner cut off), not that of the raster', () => {
    // A print turned by 2.5 degrees with its top-left corner cut, over a raster turned the other way.
    const print = [321.4, 741.0, 326.0, 636.9, 357.6, 633.6, 564.5, 642.6, 559.7, 751.3];
    const rect = askewRectangleOfPainting({ clip: { paths: [[print]], ctm: turned(256, 140, -6, 308, 639) } })!;
    expect((rect.rotationRad * 180) / Math.PI).toBeCloseTo(2.5, 0);
    expect(rect.width).toBeGreaterThan(220);
    // A shape far from a rectangle (a star) tells nothing: the raster's turn is taken.
    const star = [0, 50, 40, 40, 50, 0, 60, 40, 100, 50, 60, 60, 50, 100, 40, 60];
    expect((askewRectangleOfPainting({ clip: { paths: [[star]], ctm: turned(256, 140, -6, 308, 639) } })!.rotationRad * 180) / Math.PI).toBeCloseTo(-6, 4);
  });
});
