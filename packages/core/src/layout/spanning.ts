import { unionRect, type Rect } from '../geometry.js';
import type { TextLine } from './lineCluster.js';

/**
 * Separating spanning lines from columnar lines (Step 6 Z2) — MUST precede
 * column detection (Z3): a full-width header over two columns fills in the
 * gutter between them and destroys the valley in the density histogram.
 * Operates SOLELY on the primary stream (0°) — streams ≠ 0° are marginalia,
 * outside the scope of column detection by definition (MDD §5.1).
 */

export interface SpanningSplit {
  spanning: TextLine[];
  columnar: TextLine[];
  /** Text block width used for the threshold — for diagnostics/calibration. */
  textBlockWidth: number;
}

/**
 * The "spanning" threshold as a fraction of text block width. Starting value
 * from the brief (~70%) — a two-column layout has columns ~45-48% of the
 * block wide (with a gap between them), so 70% unambiguously rejects a single
 * column but catches any header wider than a single column could be.
 * Calibrated on files from `samples/` (RAPORT-KROK-6.md).
 */
const DEFAULT_SPANNING_WIDTH_RATIO = 0.7;
/** Same thresholds as the defaults in runningElements.ts (Z5) — the vertical band considered page margin. */
const DEFAULT_HEADER_BAND_FRACTION = 0.93;
const DEFAULT_FOOTER_BAND_FRACTION = 0.07;

function computeTextBlockBBox(lines: readonly TextLine[]): Rect | null {
  return lines.reduce<Rect | null>((acc, line) => (acc ? unionRect(acc, line.bbox) : line.bbox), null);
}

function lineWidth(line: TextLine): number {
  return line.bbox.maxX - line.bbox.minX;
}

/**
 * [Step 6, discovery] A line in the header/footer band (see Z5) can sit FAR
 * out in the margin (e.g. a footer number at x=5, while the real content
 * starts at x=51) — included in the column histogram (Z3) it shifts the text
 * block boundary and creates a FICTITIOUS "valley" right next to the margin
 * instead of the true inter-column gutter. Measured on
 * Cienie_posrod_mgie.pdf p. 20: the footer "Maciej Pasierbek..." (x=5) +
 * page number "20" (x=30) broke 2-column detection (they produced a false
 * 1-element "column" around x=5-51, which the "sparse merge" fix [see
 * columns.ts] then swallowed together with the TRUE gutter). Headers/footers
 * belong to no column by definition — they must be excluded from the
 * histogram regardless of width. We don't remove them from the model (per the
 * Z5 brief) — they go into `spanning`, which comes back in Z4 as its own band
 * anyway (header/footer at the end/start of reading order, as it should be).
 */
function isInMarginBand(line: TextLine, pageHeight: number): boolean {
  if (pageHeight <= 0) return false;
  const relativeY = (line.bbox.minY + line.bbox.maxY) / 2 / pageHeight;
  return relativeY > DEFAULT_HEADER_BAND_FRACTION || relativeY < DEFAULT_FOOTER_BAND_FRACTION;
}

/**
 * Splits the primary stream's lines into spanning (width >= threshold *
 * text block width, or in the header/footer band — see `isInMarginBand`)
 * and columnar (the rest). The column histogram (Z3) is computed SOLELY from
 * `columnar`; `spanning` comes back when building reading order (Z4).
 * `pageHeight=0` (the default) disables the margin-band check — it requires
 * whole-page geometry, which unit fixtures often don't need.
 */
export function splitSpanningLines(
  lines: readonly TextLine[],
  widthRatio: number = DEFAULT_SPANNING_WIDTH_RATIO,
  pageHeight = 0,
): SpanningSplit {
  const marginLines: TextLine[] = [];
  const bodyLines: TextLine[] = [];
  for (const line of lines) {
    if (isInMarginBand(line, pageHeight)) marginLines.push(line);
    else bodyLines.push(line);
  }

  const textBlock = computeTextBlockBBox(bodyLines);
  const textBlockWidth = textBlock ? textBlock.maxX - textBlock.minX : 0;
  if (textBlockWidth <= 0) {
    return { spanning: [...marginLines], columnar: [...bodyLines], textBlockWidth: 0 };
  }

  const threshold = textBlockWidth * widthRatio;
  const candidates = bodyLines.filter((line) => lineWidth(line) >= threshold);

  // [Step 6, discovery] The "70% of block width" threshold silently assumes the
  // TYPICAL case: a spanning header is a MINORITY of the page's lines,
  // surrounded by noticeably narrower columnar lines. On a TRULY single-column
  // page, every line by definition fills nearly the entire width of its OWN
  // text block — the block is computed from ALL lines on that page, so "block
  // width" is in practice "typical line width", and nearly every line (>50%)
  // exceeds the threshold. Without this fix, an entire single-column page
  // would end up in `spanning`, leaving Z3 (detectColumns) with no columnar
  // lines at all — verified empirically on fixture layout-1col (10/10 lines,
  // no valleys to find, zero columns instead of the correct answer "1 column").
  if (candidates.length > bodyLines.length / 2) {
    return { spanning: [...marginLines], columnar: [...bodyLines], textBlockWidth };
  }

  const spanning: TextLine[] = [...marginLines];
  const columnar: TextLine[] = [];
  for (const line of bodyLines) {
    if (lineWidth(line) >= threshold) spanning.push(line);
    else columnar.push(line);
  }
  return { spanning, columnar, textBlockWidth };
}
