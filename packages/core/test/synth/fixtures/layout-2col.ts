import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A simple two-column layout: the left column x=72..~260, the right x=310..~500, the gutter
 * x=260..310 (50pt) EMPTY over the whole block height (8 lines, the same height for both columns).
 * Tests: the density histogram + valley detection + vertical validation.
 */
export function build(): Buffer {
  const left = [
    'Left column line one text',
    'Left column line two text',
    'Left column line three text',
    'Left column line four text',
    'Left column line five text',
    'Left column line six text',
    'Left column line seven text',
    'Left column line eight text',
  ];
  const right = [
    'Right column line one text',
    'Right column line two text',
    'Right column line three text',
    'Right column line four text',
    'Right column line five text',
    'Right column line six text',
    'Right column line seven text',
    'Right column line eight text',
  ];
  const lines = [
    ...left.map((text, i) => ({ text, x: 72, y: 700 - i * 20 })),
    ...right.map((text, i) => ({ text, x: 310, y: 700 - i * 20 })),
  ];
  return buildLayoutPage({ lines });
}
