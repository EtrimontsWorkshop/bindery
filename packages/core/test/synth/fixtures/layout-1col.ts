import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A single-column layout: 10 lines in one column x~72..500, no gutter.
 * Tests: the density histogram finds no valley -> one column.
 */
export function build(): Buffer {
  const words = [
    'This is the first line of body text',
    'continuing here with more content now',
    'spanning most of the available width',
    'across the single column of this page',
    'with no gutter anywhere to be found',
    'since every line reaches toward the edge',
    'of the text block on this simple layout',
    'demonstrating single column detection well',
    'across nine or ten lines of running text',
    'ending the paragraph on this final line',
  ];
  const lines = words.map((text, i) => ({ text, x: 72, y: 700 - i * 20 }));
  return buildLayoutPage({ lines });
}
