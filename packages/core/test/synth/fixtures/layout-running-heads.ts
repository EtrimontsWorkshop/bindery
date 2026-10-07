import { buildMultiPageDocument } from '../layoutHelpers.js';

/**
 * 6 pages: a running header with a CONSTANT position/font/approximate width, but a VARYING page
 * number inside the text. Tests running-element matching by a conjunction (position + font +
 * width + presence on >=60% of pages), NEVER by exact text (the page number is different on every
 * page).
 */
export function build(): Buffer {
  return buildMultiPageDocument(6, (pageNumber) => {
    const header = { text: `Chapter One - Page ${pageNumber}`, x: 72, y: 760, size: 9 };
    const body = Array.from({ length: 4 }, (_, i) => ({
      text: `Body paragraph line ${i} on page ${pageNumber}`,
      x: 72,
      y: 650 - i * 20,
    }));
    const footer = { text: `${pageNumber}`, x: 300, y: 30, size: 9 };
    return { lines: [header, ...body, footer] };
  });
}
