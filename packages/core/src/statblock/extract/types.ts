import type { Rect } from '../../geometry.js';
import type { Diagnostic } from '../../text/types.js';

/**
 * [Task 2] A single positioned piece of text within a statblock instance's
 * own region — the primitive this whole `extract/` module operates on.
 * Deliberately NOT `CleanItem`/`ReconstructedLine` from `text/`/`layout/` (those
 * carry a raw PDF transform matrix and are tied to whole-document
 * hygiene/gap-statistics/font-role machinery that's overkill for
 * extracting a handful of fields from an already-located block) — this is
 * a simpler, already-bbox'd, already-flagged shape a later task (finding
 * statblock instances across the whole document) will populate from the
 * real pipeline. Pure data, zero Foundry/DOM/pdf.js dependency, trivially
 * hand-buildable in a test.
 *
 * Coordinate convention (own decision, documented since the brief didn't
 * fix one): `x`/`y` are the MIN corner (left/bottom), matching this
 * project's `Rect.minX`/`minY` elsewhere — `y + h` is `maxY`. Same
 * PDF-space, Y-increases-upward convention as the rest of `packages/core`
 * (`geometry.ts`, `layout/readingOrder.ts`), since this module will
 * eventually be fed real bboxes from that same pipeline.
 */
export interface PageTextElement {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
}

export function elementBBox(el: PageTextElement): Rect {
  return { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
}

export function elementCenter(el: PageTextElement): { x: number; y: number } {
  return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
}

/**
 * One statblock instance's own text elements + its bounding box — the unit
 * `extract/` works within. Building this (finding where one instance
 * starts/ends across a whole document) is a SEPARATE, later task; this
 * module only ever sees one already-delimited block at a time.
 */
export interface ExtractionBlock {
  bbox: Rect;
  elements: readonly PageTextElement[];
}

/** One reconstructed line: its elements in left-to-right reading order, their bbox union, and their text space-joined. */
export interface ReconstructedLine {
  text: string;
  elements: readonly PageTextElement[];
  bbox: Rect;
}

/**
 * [Task 2] What a `FieldSource` produces BEFORE the transform chain runs —
 * "what was found, why it failed, the raw text" per the brief. `raw` and
 * `sourceBbox` are `null` together (never independently) exactly when
 * `found` is `false` and NOTHING at all matched; a source that matched
 * something but captured empty text (e.g. a label with nothing after it)
 * reports `found: true, raw: ''` — a real, if unhelpful, result, not a
 * failure to locate the field at all. `diagnostics` may be non-empty even
 * when `found` is `true` (e.g. an informational note that the captured
 * text was empty).
 */
export interface RawExtractionResult {
  found: boolean;
  raw: string | null;
  matchedElements: readonly PageTextElement[];
  sourceBbox: Rect | null;
  diagnostics: Diagnostic[];
}
