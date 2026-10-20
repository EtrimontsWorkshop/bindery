import { describe, expect, it } from 'vitest';
import { eraseTextAroundFigure } from '../../src/images/eraseFigureText.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';
import type { Rect } from '../../src/geometry.js';

const REGION: Rect = { minX: 100, minY: 200, maxX: 200, maxY: 300 }; // 100 x 100 pt, rendered at 2 px per pt
const PAPER: [number, number, number] = [230, 230, 225];

/** A 200 x 200 px render: paper, a blue block where the drawing is and dark specks where text is. */
function render(): DecodedImage {
  const width = 200;
  const height = 200;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([...PAPER, 255], i * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...c, 255], (y * width + x) * 4);
  };
  paint(60, 60, 140, 140, [20, 60, 160]); // the drawing (the middle of the region)
  paint(0, 10, 50, 20, [10, 10, 10]); // a line of text in the top left corner
  paint(70, 70, 90, 80, [10, 10, 10]); // text over the drawing
  return { width, height, rgba };
}
const pixel = (img: DecodedImage, x: number, y: number): number[] => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

describe('eraseTextAroundFigure', () => {
  // Page space (y up): the corner text sits at x 100-125, y 290-295 (pixels 0-50 x 10-20); the drawing's shape covers x 130-170, y 230-270.
  const shape: Rect = { minX: 130, minY: 230, maxX: 170, maxY: 270 };
  const textBlock: Rect = { minX: 100, minY: 285, maxX: 130, maxY: 300 };
  const textOverShape: Rect = { minX: 130, minY: 255, maxX: 160, maxY: 265 };

  it('paints over the text that lies where no shape of the drawing does, in the color of the page around it', () => {
    const result = eraseTextAroundFigure(render(), REGION, [shape], [textBlock]);
    expect(pixel(result, 10, 15)).toEqual(PAPER);
  });

  it('leaves the drawing, and the text that lies over its shapes, as they are', () => {
    const result = eraseTextAroundFigure(render(), REGION, [shape], [textBlock, textOverShape]);
    expect(pixel(result, 100, 100)).toEqual([20, 60, 160]);
    expect(pixel(result, 75, 75)).toEqual([10, 10, 10]);
  });

  it('returns the image itself when no text block touches the region', () => {
    const image = render();
    expect(eraseTextAroundFigure(image, REGION, [shape], [{ minX: 400, minY: 400, maxX: 420, maxY: 410 }])).toBe(image);
  });
});
