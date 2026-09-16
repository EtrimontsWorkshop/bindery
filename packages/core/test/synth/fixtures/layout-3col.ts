import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Uklad trzykolumnowy: x=72..~190, x=230..~350, x=390..~500, dwie rynny
 * (190-230, 350-390) puste na calej wysokosci. Testuje detekcje WIECEJ niz
 * dwoch kolumn (KROK-6 Z3).
 */
export function build(): Buffer {
  const col = (prefix: string, x: number) =>
    Array.from({ length: 6 }, (_, i) => ({ text: `${prefix} row ${i}`, x, y: 700 - i * 20 }));
  const lines = [...col('Col1', 72), ...col('Col2', 230), ...col('Col3', 390)];
  return buildLayoutPage({ lines });
}
