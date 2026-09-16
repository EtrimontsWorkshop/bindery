import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Uklad dwukolumnowy prosty: lewa kolumna x=72..~260, prawa x=310..~500,
 * rynna x=260..310 (50pt) PUSTA na calej wysokosci bloku (8 linii, ta sama
 * wysokosc obu kolumn). Testuje: histogram gestosci + detekcja doliny +
 * walidacja pionowa (KROK-6 Z3).
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
