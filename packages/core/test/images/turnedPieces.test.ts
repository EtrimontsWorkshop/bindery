import { describe, expect, it } from 'vitest';
import { turnedPiecesFrame } from '../../src/images/buildImageExtraction.js';
import type { Matrix } from '../../src/geometry.js';

/** The matrix that paints a `w`×`h` pt raster turned by `deg` degrees, its unit square's origin at (x, y). */
const turned = (deg: number, w: number, h: number, x: number, y: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  return [w * Math.cos(r), w * Math.sin(r), -h * Math.sin(r), h * Math.cos(r), x, y];
};

describe('turnedPiecesFrame', () => {
  // A photograph laid 8° aslant, stored as a left part of 544×573 px and a right part of 273×573 px, both at 3.8 px/pt.
  const left = { width: 544, height: 573, ctm: turned(8, 544 / 3.8, 573 / 3.8, 100, 100) };
  const r = (8 * Math.PI) / 180;
  const right = { width: 273, height: 573, ctm: turned(8, 273 / 3.8, 573 / 3.8, 100 + (544 / 3.8) * Math.cos(r), 100 + (544 / 3.8) * Math.sin(r)) };

  it('lays the pieces side by side, upright, in the pixels of the first', () => {
    const boxes = turnedPiecesFrame([left, right])!;
    expect(boxes).not.toBeNull();
    expect(boxes[0]!.minX).toBeCloseTo(0, 3);
    expect(boxes[0]!.maxX).toBeCloseTo(544, 3);
    expect(boxes[1]!.minX).toBeCloseTo(544, 3);
    expect(boxes[1]!.maxX).toBeCloseTo(817, 3);
    expect(boxes[1]!.minY).toBeCloseTo(0, 3);
    expect(boxes[1]!.maxY).toBeCloseTo(573, 3);
  });

  it('does not join pieces turned differently, or that leave a gap between them', () => {
    expect(turnedPiecesFrame([left, { ...right, ctm: turned(20, 273 / 3.8, 573 / 3.8, 300, 120) }])).toBeNull();
    const apart = { ...right, ctm: turned(8, 273 / 3.8, 573 / 3.8, 100 + (700 / 3.8) * Math.cos(r), 100 + (700 / 3.8) * Math.sin(r)) };
    expect(turnedPiecesFrame([left, apart])).toBeNull();
  });
});
