import type { Rect } from '../../geometry.js';
import { extractRawValue } from '../extract/sources/extractRawValue.js';
import type { ExtractionBlock, PageTextElement } from '../extract/types.js';
import type { FieldSource, ProfileField, RequiredLabel } from '../profile/schema.js';

export interface ConfidenceResult {
  confidence: number;
  foundRequiredLabels: readonly string[];
  missingRequiredLabels: readonly string[];
}

/**
 * [Task 3] "How many required labels and fields did we actually
 * extract — use Task 2's engine." Uses `extractRawValue` (the SOURCE-
 * matching layer of Task 2's engine, not the full `extractField` chain +
 * cast) deliberately: `ProfileField` (Task 1) carries a `source` (Task 3)
 * but no transform chain of its own yet — there's nowhere in the schema
 * today to configure the `trim`/`parseNumber`/etc. steps a full
 * `extractField` call would need to reliably cast to the field's
 * `dataType`. Measuring "was this field's value LOCATABLE at all" (raw
 * source match) is honest about what's actually wired end to end right
 * now; see PLAN.md's Task 3 open questions for the missing
 * `transforms`-in-profile piece.
 *
 * Every `ProfileField` (top-level `fields`, NOT `collections[].itemFields`
 * — a collection's entry count varies per instance, so it isn't a
 * fixed-arity confidence signal the way a scalar field is) with a
 * `source` counts as one signal, alongside every `requiredLabels` entry.
 * A profile with NEITHER configured yet (a fresh, in-progress profile)
 * can't be scored against anything — confidence defaults to `1` in that
 * case (trust the anchor match itself) rather than `0` (which would read
 * as "definitely not a match" for a signal that was never actually
 * checked).
 */
export function computeCandidateConfidence(elements: readonly PageTextElement[], bbox: Rect, requiredLabels: readonly RequiredLabel[], fields: readonly ProfileField[]): ConfidenceResult {
  const block: ExtractionBlock = { bbox, elements };

  const foundRequiredLabels: string[] = [];
  const missingRequiredLabels: string[] = [];
  for (const label of requiredLabels) {
    const result = extractRawValue(block, { kind: 'label', labelPattern: label.pattern, labelIsRegex: label.isRegex, stopAt: 'endOfLine' });
    (result.found ? foundRequiredLabels : missingRequiredLabels).push(label.pattern);
  }

  // A fixed (literal) value is always "found" — it says nothing about whether this block is a statblock, so it is not a signal.
  const fieldsWithSource = fields.filter((field): field is ProfileField & { source: FieldSource } => field.source !== undefined && field.source.kind !== 'literal');
  const fieldsFound = fieldsWithSource.filter((field) => extractRawValue(block, field.source).found).length;

  const totalSignals = requiredLabels.length + fieldsWithSource.length;
  const foundSignals = foundRequiredLabels.length + fieldsFound;
  const confidence = totalSignals === 0 ? 1 : foundSignals / totalSignals;

  return { confidence, foundRequiredLabels, missingRequiredLabels };
}
