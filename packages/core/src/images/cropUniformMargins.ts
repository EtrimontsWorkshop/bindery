import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [at the user's request, after the "Wrak" fix] Some publications export
 * EVERY page as ONE flat raster (background + illustration + everything),
 * with no separate PDF resource for the illustration itself — confirmed
 * directly on Wrak.pdf (`buildInventory`: exactly ONE `ImageEntry` per such
 * page, bbox ~the whole MediaBox). `treatFullBleedAsContent` (classify.ts)
 * correctly reveals such an image as `content`, but the "whole canvas"
 * itself can be mostly empty margin/paper around a small illustration (e.g.
 * an NPC portrait in a corner) — this can't be separated from the PDF's
 * STRUCTURE (it's one resource, not two), so the only way is to analyze the
 * PIXELS of the already-decoded image.
 *
 * Deliberately EXPERIMENTAL and opt-in (`images.autoCropUniformMargins`, see
 * `schema.ts`) — this is a heuristic, not structure parsing: pages where the
 * illustration fills nearly the whole canvas (e.g. a ship cross-section
 * spread, Wrak.pdf p. 11) are meant to deliberately NOT be cropped, because
 * their edges are already part of the content themselves (texture, frame),
 * not empty margin — the algorithm below is deliberately CONSERVATIVE
 * (prefers NOT cropping when uncertain) for exactly this reason.
 *
 * Algorithm: each row/column gets its own "boringness" coefficient (the
 * share of pixels within `COLOR_TOLERANCE` of its OWN average color — NOT of
 * a single global background color; this book's real frame is
 * MULTI-COLORED: a dark "leather" strip on the left, light "paper" in the
 * middle, a rounded "folded corner" — a single reference color from the
 * corner wouldn't match the paper elsewhere on the same edge). From each
 * edge we crop while the MOVING AVERAGE (`WINDOW_PX` neighboring
 * rows/columns) of this coefficient stays >= `WINDOW_COVERAGE_THRESHOLD`.
 *
 * [Calibrated on real Wrak.pdf, p. 25 — a key discovery] A single sharp
 * threshold (the earlier version, WITHOUT a window) failed on real data:
 * thin decorative strips touching the edge (a top ribbon with the title, a
 * bottom one with the page number, a folded corner) have their OWN, though
 * "boring", coloring, but with visible text/texture — their OWN coverage can
 * momentarily drop below the threshold (e.g. 0.23 exactly on a row with
 * letters), even though it's STILL decoration, not a genuine illustration.
 * A sharp threshold stopped cropping at the FIRST such dip, a dozen-odd
 * pixels from the edge — in practice almost nothing got cropped. A portrait
 * (genuine content), by contrast, produces hundreds of CONSECUTIVE
 * rows/columns with coverage close to zero — the window-averaged value tells
 * "a momentary dip in decoration" apart from "a long, moderately-low stretch
 * of genuine content" far more reliably than a single row/column on its own.
 */

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Max deviation of an RGB channel from the row/column average for a pixel to
 * count as "the same boring color" — tolerates paper/texture noise, doesn't
 * tolerate an illustration edge. [Calibrated on real Wrak.pdf, p. 25] The
 * first attempt (18) was drastically too sharp for real "aged paper" with
 * visible grain/texture — measured directly: even purely decorative rows
 * (leather strip, blank paper) only reached 22-66% coverage at a tolerance
 * of 18-30, and only consistently reached >=92% at 45. Rows INSIDE the
 * portrait (genuine content) nonetheless stay CLEARLY lower (<=23% even at a
 * tolerance of 45) — the resolution margin is still large.
 */
const COLOR_TOLERANCE = 45;
/**
 * Window size (in rows/columns) averaging the "boringness" coefficient —
 * see the rationale in the file header. [Calibrated on Wrak.pdf p. 27/28,
 * second iteration] The first attempt (80px) turned out to be TOO LARGE:
 * when genuine content (a portrait) starts soon after the end of a ribbon
 * (~140px of decoration), an 80px window starts "seeing" the upcoming
 * content far BEFORE the actual boundary — even a small (~15%) share of
 * content pixels (coverage ~0.03, near zero) in the window is enough to drag
 * the average below the threshold, stopping the crop several dozen pixels
 * too early (measured directly: p. 27/28 stopped at row 108 of 1759,
 * instead of reaching ~150-172, leaving readable ribbon text in frame). A
 * smaller window (30px) is TIGHTER around the current position — it needs
 * far less "buffer" of good rows to survive a momentary dip (letter glyphs),
 * BUT is also much less prone to being prematurely dragged down by a
 * distant, not-yet-dominant fragment of genuine content — it allows cropping
 * to within ~10-25px of the actual boundary instead of ~65-70px too early.
 */
const WINDOW_PX = 30;
/** Moving-average threshold — see the calibration at `WINDOW_PX`. Deliberately lower than the single-row `ROW_UNIFORM_COVERAGE` of the first (failed) version: averaging itself already filters out noise, no extra buffer is needed here. */
const WINDOW_COVERAGE_THRESHOLD = 0.75;
/**
 * Safety margin added back around the detected content, so as not to cut
 * off the illustration's edge flush.
 *
 * [Measured directly on a real report, Wrak.pdf p. 20 (`img_p19_1`)] The
 * original value (12) was UNCALIBRATED against real data (unlike
 * `COLOR_TOLERANCE`/`WINDOW_PX` above) — on this image `topTrim` (before
 * adding the margin) came out at y=134, and per-row coverage shows that the
 * actual edge of the "CALL OF CTHULHU" title ribbon (together with the
 * double line and text) ends around y=125 (the last row below the 0.75
 * threshold). A 12px margin pulled the boundary back to y=122 — STILL
 * INSIDE the ribbon — leaving a visible sliver of text in the exported
 * image (report: "I see text on the image"). Reduced to 4px: still guards
 * against cutting flush (the purpose of the comment above), but doesn't
 * pull the boundary back far enough to re-enter the already-correctly-
 * detected decoration.
 */
const PADDING_PX = 4;
/**
 * [discovered during implementation] MUST match `MIN_ABSOLUTE_PX` in
 * `finalize.ts` (deliberately NOT imported from there — `finalize.ts`
 * imports from `classify.ts`/`extract.ts`, not the other way around, to
 * avoid a cycle). Without this lower bound, a legitimately small (but
 * genuine) illustration after cropping (e.g. a small NPC portrait) could
 * fall below the threshold that `finalizeImages` uses to reject
 * ACCIDENTALLY small fragments as 'decoration' — exactly the mechanism
 * meant to guard against junk icons would accidentally reject the very
 * thing this flag was meant to reveal. Measured directly: a ~70x78px
 * portrait, after `PADDING_PX` alone, fell below 100px in width and reverted
 * to 'decoration'.
 */
const MIN_OUTPUT_SIZE_PX = 100;
/** If the detected content is less than this share of the total area, the whole image is probably "boring" (a detection bug or a genuinely blank page) — safer to crop NOTHING than to return a nonsensically small snippet. */
const MIN_KEPT_FRACTION = 0.02;
/** If the crop removed less than this share of the area, it's not worth it — the page is probably filled with content almost to the edge (e.g. a spread), NOT margin to remove. */
const MIN_TRIMMED_FRACTION = 0.01;

/**
 * Share of pixels along a line (row OR column — `indexOf(i)` supplies the
 * RGBA byte offset of the i-th pixel on this line, `count` is its length)
 * within `COLOR_TOLERANCE` of THAT line's OWN average color (0..1). Shared
 * implementation for `rowCoverage`/`colCoverage` — the only difference
 * between a row and a column is how the pixels are traversed.
 */
function coverageAlongLine(rgba: Uint8ClampedArray, count: number, indexOf: (i: number) => number): number {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count; i++) {
    const idx = indexOf(i);
    r += rgba[idx]!;
    g += rgba[idx + 1]!;
    b += rgba[idx + 2]!;
  }
  const mr = r / count;
  const mg = g / count;
  const mb = b / count;
  let matches = 0;
  for (let i = 0; i < count; i++) {
    const idx = indexOf(i);
    if (Math.abs(rgba[idx]! - mr) <= COLOR_TOLERANCE && Math.abs(rgba[idx + 1]! - mg) <= COLOR_TOLERANCE && Math.abs(rgba[idx + 2]! - mb) <= COLOR_TOLERANCE) {
      matches++;
    }
  }
  return matches / count;
}

/** Share of pixels in row `y` within `COLOR_TOLERANCE` of that row's OWN average color (0..1). */
function rowCoverage(rgba: Uint8ClampedArray, width: number, y: number): number {
  return coverageAlongLine(rgba, width, (x) => (y * width + x) * 4);
}

/** Share of pixels in column `x` within `COLOR_TOLERANCE` of that column's OWN average color (0..1). */
function colCoverage(rgba: Uint8ClampedArray, width: number, height: number, x: number): number {
  return coverageAlongLine(rgba, height, (y) => (y * width + x) * 4);
}

/**
 * Number of leading elements of `coverages` that can be trimmed — steps
 * forward until the MOVING AVERAGE of a `windowSize` window starting at the
 * current position drops below `threshold` (see the file header). Called
 * ONCE normally (trimming from the start) and ONCE on the REVERSED array
 * (trimming from the end) — one mechanism instead of two symmetric copies.
 */
function countTrimmableFromStart(coverages: Float64Array, windowSize: number, threshold: number): number {
  const n = coverages.length;
  const w = Math.min(windowSize, n);
  if (w === 0) return 0;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += coverages[i]!;
  let trimmed = 0;
  for (let i = 0; i + w <= n; i++) {
    if (sum / w < threshold) break;
    trimmed = i + 1;
    if (i + w < n) sum += coverages[i + w]! - coverages[i]!;
  }
  return trimmed;
}

function reverseArray(arr: Float64Array): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i]!;
  return out;
}

/** Expands [lo,hi] symmetrically to at least `minSize` length, clamped to [0,totalSize-1]. */
function expandToMinSize(lo: number, hi: number, totalSize: number, minSize: number): [number, number] {
  const len = hi - lo + 1;
  if (len >= minSize) return [lo, hi];
  const growEach = Math.ceil((minSize - len) / 2);
  let newLo = lo - growEach;
  let newHi = hi + growEach;
  if (newLo < 0) {
    newHi += -newLo;
    newLo = 0;
  }
  if (newHi > totalSize - 1) {
    newLo -= newHi - (totalSize - 1);
    newHi = totalSize - 1;
  }
  return [Math.max(0, newLo), Math.min(totalSize - 1, newHi)];
}

/**
 * Detects the rectangle of "actual content" inside `image`, trimming boring
 * (uniform) margins from each edge. Returns `null` when cropping is NOT
 * warranted (see `MIN_KEPT_FRACTION`/`MIN_TRIMMED_FRACTION` above) — the
 * caller then uses the original image unchanged.
 */
export function detectContentBounds(image: DecodedImage): PixelBounds | null {
  const { width, height, rgba } = image;
  if (width < 8 || height < 8) return null;

  const rowCoverages = new Float64Array(height);
  for (let y = 0; y < height; y++) rowCoverages[y] = rowCoverage(rgba, width, y);
  const colCoverages = new Float64Array(width);
  for (let x = 0; x < width; x++) colCoverages[x] = colCoverage(rgba, width, height, x);

  const topTrim = countTrimmableFromStart(rowCoverages, WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const bottomTrim = countTrimmableFromStart(reverseArray(rowCoverages), WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const leftTrim = countTrimmableFromStart(colCoverages, WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const rightTrim = countTrimmableFromStart(reverseArray(colCoverages), WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);

  let top = topTrim;
  let bottom = height - 1 - bottomTrim;
  let left = leftTrim;
  let right = width - 1 - rightTrim;

  // [safeguard] If trimming "ate" the entire dimension (nothing survived as
  // distinct content — the whole canvas uniform), do NOT apply
  // `expandToMinSize` below: stretching a degenerate point to
  // `MIN_OUTPUT_SIZE_PX` would "find" content where there REALLY is none.
  // Return `null` right away, before padding/expansion can mask this.
  if (top >= bottom || left >= right) return null;

  top = Math.max(0, top - PADDING_PX);
  left = Math.max(0, left - PADDING_PX);
  bottom = Math.min(height - 1, bottom + PADDING_PX);
  right = Math.min(width - 1, right + PADDING_PX);

  [top, bottom] = expandToMinSize(top, bottom, height, MIN_OUTPUT_SIZE_PX);
  [left, right] = expandToMinSize(left, right, width, MIN_OUTPUT_SIZE_PX);

  const w = right - left + 1;
  const h = bottom - top + 1;
  const totalArea = width * height;
  const keptFraction = (w * h) / totalArea;
  if (keptFraction < MIN_KEPT_FRACTION) return null;
  if (1 - keptFraction < MIN_TRIMMED_FRACTION) return null;

  return { x: left, y: top, width: w, height: h };
}

/** Cuts `bounds` out of `image` into a NEW RGBA buffer (does not modify `image` in place). */
export function cropDecodedImage(image: DecodedImage, bounds: PixelBounds): DecodedImage {
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let row = 0; row < bounds.height; row++) {
    const srcStart = ((bounds.y + row) * image.width + bounds.x) * 4;
    const destStart = row * bounds.width * 4;
    out.set(image.rgba.subarray(srcStart, srcStart + bounds.width * 4), destStart);
  }
  return { width: bounds.width, height: bounds.height, rgba: out };
}
