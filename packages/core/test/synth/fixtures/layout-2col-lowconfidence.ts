import { buildLayoutPage } from '../layoutHelpers.js';

/**
 * The confidence-threshold safeguard: a columnar layout with AMBIGUOUS columns (one ISOLATED, larger
 * element partly enters the gutter area over a fragment of the block height), lowering `confidence`
 * (`detectColumns`) below the repair threshold (0.85), but still ABOVE the column detection
 * threshold itself (0.7 in `columns.ts`) — the columns ARE detected, only with low confidence.
 * Plus exactly the same false-merge pattern as `layout-2col-false-merge`. With uncertain column
 * detection the repair pass MUST NOT cut — "we don't know where the columns ARE" — better to leave
 * an existing bug than introduce a new one.
 *
 * [technique] A larger-font element ISOLATED vertically (far from every other row — out of reach of
 * the "superscript/subscript" path in `sameLine`, to avoid a cascading merge with neighbors) gives a
 * LARGER bbox HEIGHT (proportional to the font size) at density=1 (one line) — it easily survives
 * `detectColumns`'s density filter (5% of the maximum at ~25 "normal" background rows), and its
 * HEIGHT significantly lowers `coveredHeight`/`emptyRatio` for a gutter candidate that it partly crosses.
 */
export function build(): Buffer {
  const rowCount = 25;
  const rowSpacing = 3.6;
  const startY = 700;

  const left = Array.from({ length: rowCount }, (_, i) => ({
    text: `Left col ${i}`,
    x: 45,
    y: startY - i * rowSpacing,
  }));
  const right = Array.from({ length: rowCount }, (_, i) => ({
    text: `Right col ${i}`,
    x: 310,
    y: startY - i * rowSpacing,
  }));

  // An isolated large element — Y far from every normal row (in a dedicated gap), so it can't merge
  // with any of them (it exceeds every `sameLine` threshold, including the superscript/subscript
  // path). X reaches into the gutter. Stays within [0,792] (the default MediaBox) — a Y outside that
  // range would falsely land in the header/footer band (`spanning.ts`).
  const mainRowsBottom = startY - (rowCount - 1) * rowSpacing;
  const bigIntrusion = [{ text: 'INTRUDES HERE', x: 150, y: mainRowsBottom - 90, size: 51 }];

  const baseY = mainRowsBottom - 210;
  // The same pattern is NOW additionally caught much earlier by `lineEdgeSplit.ts` (it runs BEFORE
  // `gutterRepair.ts` and doesn't depend on column confidence at all) — see `groupEFixtures.test.ts`.
  const anomaly = [
    { text: 'Short left end here', x: 45, y: baseY + 30 },
    { text: 'Sidebar Title', x: 313, y: baseY + 22, size: 14 },
    { text: 'Another short left line', x: 45, y: baseY + 6 },
    { text: 'Sidebar body continues past title here now', x: 313, y: baseY },
  ];
  const belowAnomaly = Array.from({ length: 4 }, (_, i) => ({
    text: `Left column continues line ${i} here now`,
    x: 45,
    y: baseY - 20 - i * rowSpacing,
  }));

  return buildLayoutPage({ lines: [...left, ...right, ...bigIntrusion, ...anomaly, ...belowAnomaly] });
}
