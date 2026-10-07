import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * A replica of a geometry measured on a real page: two columns with regular rows (establishing a
 * certain gutter for `detectColumns`), plus ONE caption/title in the right column in a LARGER font
 * (mimics a sidebar title), whose size/position relative to its neighbor in the left column meets
 * the "superscript/subscript" condition in `sameLine` (`SUBSCRIPT_SIZE_RATIO`) and links it
 * transitively to a line from the OTHER column, despite the empty gutter between them.
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

  // A replica of the exact geometry of that page: a left line ending with "po" (y=744 relative to the
  // local startY), the right TITLE in a larger font (y=736, mimics a sidebar title), the left
  // continuation (y=720), the right body (y=714).
  const baseY = startY - rowCount * rowSpacing - 60;
  // The same pattern (a larger-font label at the edge of a merged line, shorter than the rest) is
  // NOW additionally caught much earlier by `lineEdgeSplit.ts` (it runs BEFORE `gutterRepair.ts` on
  // raw lines) — see `groupEFixtures.test.ts`, which documents directly which mechanism actually
  // splits this fixture after that change.
  const anomaly = [
    { text: 'Short left end here', x: 45, y: baseY + 30 },
    { text: 'Sidebar Title', x: 313, y: baseY + 22, size: 14 },
    { text: 'Another short left line', x: 45, y: baseY + 6 },
    { text: 'Sidebar body continues past title here now', x: 313, y: baseY },
  ];

  // Additional clean lines of the left column BELOW the anomaly — without them the left "column"
  // covers too small a slice of the block height (because its only content in this band went into
  // the spanning line) and `mergeSparseColumns` (columns.ts) removes it as an alleged sidebar, before
  // the repair pass gets a chance to see TWO columns to cut between.
  const belowAnomaly = Array.from({ length: 4 }, (_, i) => ({
    text: `Left column continues line ${i} here now`,
    x: 45,
    y: baseY - 20 - i * rowSpacing,
  }));

  return buildLayoutPage({ lines: [...left, ...right, ...anomaly, ...belowAnomaly] });
}
