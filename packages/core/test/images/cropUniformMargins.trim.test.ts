import { describe, expect, it } from 'vitest';
import { trimTransparentMargins } from '../../src/images/cropUniformMargins.js';

/** A `width` x `height` canvas, transparent but for an opaque rectangle. */
function canvas(width: number, height: number, opaque: { x: number; y: number; w: number; h: number } | null) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (opaque) for (let y = opaque.y; y < opaque.y + opaque.h; y++) for (let x = opaque.x; x < opaque.x + opaque.w; x++) rgba.set([200, 100, 50, 255], (y * width + x) * 4);
  return { width, height, rgba };
}

describe('trimTransparentMargins', () => {
  it('cuts off the transparent rows and columns round a cut-out', () => {
    const trimmed = trimTransparentMargins(canvas(100, 200, { x: 5, y: 20, w: 80, h: 160 }));
    expect(trimmed && [trimmed.width, trimmed.height]).toEqual([80, 160]);
    expect([...trimmed!.rgba.slice(0, 4)]).toEqual([200, 100, 50, 255]);
  });

  it('keeps transparency inside the picture (a cut-out touching every edge)', () => {
    const image = canvas(100, 100, null);
    for (const [x, y] of [[0, 50], [99, 50], [50, 0], [50, 99]] as const) image.rgba.set([0, 0, 0, 255], (y * 100 + x) * 4);
    expect(trimTransparentMargins(image)).toBeNull();
  });

  it('leaves a picture with hardly any margin, and one with nothing opaque', () => {
    expect(trimTransparentMargins(canvas(100, 100, { x: 0, y: 1, w: 100, h: 99 }))).toBeNull();
    expect(trimTransparentMargins(canvas(50, 50, null))).toBeNull();
  });
});
