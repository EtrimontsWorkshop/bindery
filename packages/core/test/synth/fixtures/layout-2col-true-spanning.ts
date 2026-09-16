import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * KROK-10 Z5 — nierozlaczny "bliźniak" `layout-2col-false-merge`: nagłówek
 * rozpinający NAD kolumnami, z tokenem faktycznie WEWNĄTRZ obszaru rynny
 * (jeden ciągły `Tj` przebiegający przez cała szerokosc, w tym rynne).
 * Dyskryminator MUSI zostawic taka linie bez zmian — fixture dowodzacy
 * rozcinania bez fixture'a dowodzacego NIErozcinania nie dowodzi niczego
 * (brief).
 */
export function build(): Buffer {
  const rowCount = 6;
  const rowSpacing = 12;
  const startY = 700;

  const left = Array.from({ length: rowCount }, (_, i) => ({
    text: `Left column line ${i} of body text here now`,
    x: 45,
    y: startY - i * rowSpacing,
  }));
  const right = Array.from({ length: rowCount }, (_, i) => ({
    text: `Right column line ${i} of body text here now`,
    x: 310,
    y: startY - i * rowSpacing,
  }));

  const belowSpacing = 12;
  const heading = [
    { text: 'Full Width Heading Spans The Gutter Right Through It Completely From Edge To Edge', x: 45, y: startY - rowCount * rowSpacing - 40 },
  ];
  const below = Array.from({ length: rowCount }, (_, i) => ({
    text: `Below left line ${i} here now text`,
    x: 45,
    y: startY - rowCount * rowSpacing - 60 - i * belowSpacing,
  }));
  const belowRight = Array.from({ length: rowCount }, (_, i) => ({
    text: `Below right line ${i} here now text`,
    x: 310,
    y: startY - rowCount * rowSpacing - 60 - i * belowSpacing,
  }));

  return buildLayoutPage({ lines: [...left, ...right, ...heading, ...below, ...belowRight] });
}
