import type { Rect } from '../../geometry.js';
import type { Diagnostic } from '../../text/types.js';
import { castAndValidate, type FieldTypeConstraints } from './castAndValidate.js';
import { extractRawValue } from './sources/extractRawValue.js';
import type { FieldSource } from './sources/types.js';
import { runTransformChain } from './transforms/runChain.js';
import type { TransformStep } from './transforms/types.js';
import type { ExtractionBlock } from './types.js';

/**
 * "Value + diagnostics (what was found, why it failed, the raw
 * text)". `found`
 * reflects the FINAL outcome after the whole pipeline (source ->
 * transforms -> cast/validate): a source that matched something, which a
 * later transform then failed to parse, is still `found: false` — nothing
 * USABLE came out the other end, even though `raw` shows exactly what was
 * captured before that happened (essential for debugging a profile).
 */
export interface FieldExtractionResult {
  found: boolean;
  raw: string | null;
  value: unknown;
  sourceBbox: Rect | null;
  diagnostics: Diagnostic[];
}

/** Runs the full pipeline for one field: locate its raw text (`extractRawValue`), run it through the transform chain, then cast/validate against the target field's type. Pure — no Foundry, no DOM, no I/O; every step degrades to a diagnostic instead of throwing. */
export function extractField(block: ExtractionBlock, source: FieldSource, transformChain: readonly TransformStep[], constraints: FieldTypeConstraints): FieldExtractionResult {
  const rawResult = extractRawValue(block, source);
  const diagnostics: Diagnostic[] = [...rawResult.diagnostics];

  if (!rawResult.found) {
    return { found: false, raw: null, value: undefined, sourceBbox: null, diagnostics };
  }

  const chainResult = runTransformChain(transformChain, rawResult.raw, { elements: rawResult.matchedElements });
  diagnostics.push(...chainResult.diagnostics);

  const castResult = castAndValidate(chainResult.value, constraints);
  diagnostics.push(...castResult.diagnostics);

  return {
    found: castResult.value !== undefined,
    raw: rawResult.raw,
    value: castResult.value,
    sourceBbox: rawResult.sourceBbox,
    diagnostics,
  };
}
