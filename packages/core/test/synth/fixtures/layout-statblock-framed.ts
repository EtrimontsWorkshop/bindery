import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A block of short lines in a smaller font (imitating a statblock — the 'statblock'
 * CLASSIFICATION is not a goal of this fixture), SURROUNDED by a vector frame (fill). Tests the
 * edge of a vector region as a block boundary — the first real use of vector regions.
 */
export function build(): Buffer {
  const bodyBefore = Array.from({ length: 4 }, (_, i) => ({ text: `Body text before the box line ${i}`, x: 72, y: 700 - i * 20 }));
  const block = [
    { text: 'Goblin Scout', x: 72, y: 600, size: 8 },
    { text: 'HP 7 AC 13', x: 72, y: 585, size: 8 },
    { text: 'Attack Scimitar plus 4', x: 72, y: 570, size: 8 },
    { text: 'Damage 1d6 plus 2', x: 72, y: 555, size: 8 },
  ];
  const bodyAfter = Array.from({ length: 4 }, (_, i) => ({ text: `Body text after the box line ${i}`, x: 72, y: 500 - i * 20 }));
  const frame = { x: 65, y: 548, w: 250, h: 62, mode: 'fill' as const };
  return buildLayoutPage({ lines: [...bodyBefore, ...block, ...bodyAfter], rects: [frame] });
}
