import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Two columns + a FULL-WIDTH header in the MIDDLE of the page (not at the top/bottom) — it splits
 * the page into an upper and a lower band, each with its own pair of columns. Tests spanning vs
 * columnar lines (without it the header destroys the gutter valley) and the bands in reading
 * order (the upper band left->right, the header, the lower band left->right).
 */
export function build(): Buffer {
  const col = (prefix: string, x: number, yStart: number) =>
    Array.from({ length: 4 }, (_, i) => ({ text: `${prefix} line ${i} of body text here`, x, y: yStart - i * 20 }));

  const topLeft = col('TopLeft', 72, 700);
  const topRight = col('TopRight', 310, 700);
  const heading = [{ text: 'Full Width Section Heading Spans Both Columns Below', x: 72, y: 560, size: 14 }];
  const bottomLeft = col('BottomLeft', 72, 500);
  const bottomRight = col('BottomRight', 310, 500);

  return buildLayoutPage({ lines: [...topLeft, ...topRight, ...heading, ...bottomLeft, ...bottomRight] });
}
