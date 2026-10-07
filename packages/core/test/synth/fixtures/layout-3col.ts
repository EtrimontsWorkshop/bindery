import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A three-column layout: x=72..~190, x=230..~350, x=390..~500, two gutters (190-230, 350-390)
 * empty over the whole height. Tests the detection of MORE than two columns.
 */
export function build(): Buffer {
  const col = (prefix: string, x: number) =>
    Array.from({ length: 6 }, (_, i) => ({ text: `${prefix} row ${i}`, x, y: 700 - i * 20 }));
  const lines = [...col('Col1', 72), ...col('Col2', 230), ...col('Col3', 390)];
  return buildLayoutPage({ lines });
}
