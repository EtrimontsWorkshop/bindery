import type { ExtractionBlock, RawExtractionResult } from '../types.js';
import { extractFromLabelSource, type LabelContext } from './labelSource.js';
import { extractFromRegionSource } from './regionSource.js';
import { extractFromStyleFilterSource } from './styleFilterSource.js';
import type { FieldSource } from './types.js';

/** Dispatches to the right source implementation by `FieldSource.kind`. */
export function extractRawValue(block: ExtractionBlock, source: FieldSource, context: LabelContext = {}): RawExtractionResult {
  switch (source.kind) {
    case 'label':
      return extractFromLabelSource(block, source, context);
    case 'region':
      return extractFromRegionSource(block, source);
    case 'styleFilter':
      return extractFromStyleFilterSource(block, source);
    case 'literal':
      return { found: true, raw: String(source.value), matchedElements: [], sourceBbox: null, diagnostics: [] };
  }
}
