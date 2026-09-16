import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Dwie kolumny + PELNOWYMIAROWY naglowek w SRODKU strony (nie na gorze/dole) —
 * dzieli strone na pasmo gorne i dolne, kazde ze swoja para kolumn. Testuje
 * Z2 (rozpinajace vs kolumnowe — bez tego naglowek niszczy dolina rynny) i
 * pasma w Z4 (kolejnosc czytania: gorne pasmo lewo->prawo, naglowek, dolne
 * pasmo lewo->prawo).
 */
export function build(): Buffer {
  const col = (prefix: string, x: number, yStart: number) =>
    Array.from({ length: 4 }, (_, i) => ({ text: `${prefix} line ${i} of body text here`, x, y: yStart - i * 20 }));

  const topLeft = col('TopLeft', 72, 700);
  const topRight = col('TopRight', 310, 700);
  const heading = [{ text: 'Full Width Section Heading Spans Both Columns Below', x: 72, y: 560, size: 14 }];
  const bottomLeft = col('BottomLeft', 72, 500);
  const bottomRight = col('BottomRight', 310, 500);

  return buildLayoutPage({ lines: [...topLeft, ...topRight, ...heading, ...bottomLeft, ...bottomRight] });
}
