import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Two columns of main text + a frame with a background (vector fill) on the right containing a
 * short "callout" (a sidebar). Tests the classification `BlockKind: 'sidebar'` (a vector 'fill'
 * region + off to the side of the column layout) and the correct reading order (the sidebar is NOT
 * woven into the flow of the main columns).
 */
export function build(): Buffer {
  const col = (prefix: string, x: number) =>
    Array.from({ length: 8 }, (_, i) => ({ text: `${prefix} line ${i} of main text here`, x, y: 700 - i * 20 }));

  const mainLeft = col('Left', 72);
  const mainRight = col('Right', 300);
  const sidebarLines = [
    { text: 'Sidebar Tip', x: 490, y: 660, size: 9 },
    { text: 'See page 12', x: 490, y: 640, size: 9 },
    { text: 'for details', x: 490, y: 620, size: 9 },
  ];
  const sidebarBox = { x: 480, y: 590, w: 120, h: 100, mode: 'fill' as const };

  return buildLayoutPage({ lines: [...mainLeft, ...mainRight, ...sidebarLines], rects: [sidebarBox] });
}
