/**
 * [Task 2] The three ways a field's raw value can be located within one
 * `ExtractionBlock`, per the brief:
 * - `label` — text after a label (plain text or regex) until the next
 *   label, the end of the current line, or the end of the block.
 * - `region` — a rectangle normalized (0..1 on each axis) relative to the
 *   block's own bounding box.
 * - `styleFilter` — every element matching a style predicate (font name,
 *   size, bold/italic), e.g. "the largest font in the block".
 */
export type FieldSource = LabelSource | RegionSource | StyleFilterSource;

export interface LabelSource {
  kind: 'label';
  /** Text (exact, trimmed match) or regex source, per `labelIsRegex`. */
  labelPattern: string;
  labelIsRegex: boolean;
  stopAt: 'nextLabel' | 'endOfLine' | 'endOfBlock';
  /** Required when `stopAt === 'nextLabel'` — what counts as "the next label" (matched the same way as `labelPattern`, usually a more general pattern since the next field's exact label isn't known in advance). */
  nextLabelPattern?: string;
  nextLabelIsRegex?: boolean;
}

export interface NormalizedRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RegionSource {
  kind: 'region';
  /** 0..1 on each axis, relative to the block's own bbox: (0,0) = (bbox.minX, bbox.minY), (1,1) = (bbox.maxX, bbox.maxY). */
  normalizedRect: NormalizedRect;
}

export interface StyleFilter {
  fontNamePattern?: string;
  minFontSize?: number;
  maxFontSize?: number;
  bold?: boolean;
  italic?: boolean;
  /**
   * When true, selects only elements whose `fontSize` equals the largest
   * `fontSize` found among the elements that already pass the OTHER
   * criteria above (or among every element in the block, when no other
   * criteria are given) — lets "largest bold font in block" compose
   * naturally with "largest font in block".
   */
  largestFontInBlock?: boolean;
}

export interface StyleFilterSource {
  kind: 'styleFilter';
  filter: StyleFilter;
}
