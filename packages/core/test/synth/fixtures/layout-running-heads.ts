import { buildMultiPageDocument } from '../layoutHelpers.js';

/**
 * 6 stron: naglowek biegnacy o STALEJ pozycji/foncie/szerokosci-w-przyblizeniu,
 * ale ZMIENNYM numerze strony wewnatrz tekstu. Testuje Z5: dopasowanie po
 * koniunkcji (pozycja+font+szerokosc+obecnosc na >=60% stron), NIGDY po
 * dokladnym tekscie (numer strony jest inny na kazdej stronie).
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
