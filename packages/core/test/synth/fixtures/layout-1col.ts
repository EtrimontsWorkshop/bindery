import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Uklad jednokolumnowy: 10 linii w jednej kolumnie x~72..500, brak rynny.
 * Testuje: histogram gestosci nie znajduje zadnej doliny -> jedna kolumna
 * (KROK-6 Z3: "brak wyraznych dolin -> jedna kolumna, to poprawna odpowiedz").
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
