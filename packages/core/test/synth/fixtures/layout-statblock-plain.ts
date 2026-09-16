import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * TEN SAM uklad tekstu co layout-statblock-framed, ale BEZ ramki wektorowej —
 * testuje ze granica bloku nadal powstaje z INNYCH sygnalow (zmiana rozmiaru
 * fontu, interlinia), gdy brak sygnalu wizualnego (regionu wektorowego).
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
  return buildLayoutPage({ lines: [...bodyBefore, ...block, ...bodyAfter] });
}
