import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * Dwie kolumny glownego tekstu + ramka z tlem (vector fill) po prawej stronie
 * zawierajaca krotki "dymek" (sidebar). Testuje klasyfikacje `BlockKind:
 * 'sidebar'` (region wektorowy 'fill' + na uboczu ukladu kolumnowego) i
 * poprawna kolejnosc czytania (sidebar NIE wplatany w tok kolumn glownych).
 */
export function build(): Buffer {
  const col = (prefix: string, x: number) =>
    Array.from({ length: 8 }, (_, i) => ({ text: `${prefix} line ${i} of main text here`, x, y: 700 - i * 20 }));

  const mainLeft = col('Left', 72);
  const mainRight = col('Right', 300);
  const sidebarLines = [
    { text: 'Sidebar Tip', x: 490, y: 660, size: 9 },
    { text: 'See page 12', x: 490, y: 640, size: 9 },
    { text: 'for details', x: 490, y: 620, size: 9 },
  ];
  const sidebarBox = { x: 480, y: 590, w: 120, h: 100, mode: 'fill' as const };

  return buildLayoutPage({ lines: [...mainLeft, ...mainRight, ...sidebarLines], rects: [sidebarBox] });
}
