import { unionRect } from '../../../geometry.js';
import type { Diagnostic } from '../../../text/types.js';
import { reconstructLines } from '../reconstructLines.js';
import { elementBBox, type ExtractionBlock, type PageTextElement, type RawExtractionResult } from '../types.js';
import type { LabelSource } from './types.js';

function compileRegex(pattern: string, fieldName: string): { regex: RegExp | null; error: Diagnostic | null } {
  try {
    return { regex: new RegExp(pattern), error: null };
  } catch {
    return { regex: null, error: { severity: 'error', code: 'STATBLOCK_INVALID_REGEX', params: { pattern, field: fieldName } } };
  }
}

function notFound(labelPattern: string, diagnostics: Diagnostic[] = []): RawExtractionResult {
  return {
    found: false,
    raw: null,
    matchedElements: [],
    sourceBbox: null,
    diagnostics: diagnostics.length > 0 ? diagnostics : [{ severity: 'warning', code: 'STATBLOCK_LABEL_NOT_FOUND', params: { labelPattern } }],
  };
}

/**
 * [Task 2] "Text after a label (plain text or regex) until the next
 * label, the end of the current line, or the end of the block." Matching
 * happens at the LINE level (via `reconstructLines`, so column-adjacent
 * unrelated text on the same row is already separated out) and at the
 * ELEMENT level for the label itself (a label is assumed to be ONE
 * element's whole trimmed text — no multi-element label matching in this
 * task, e.g. "Hit" + "Points:" as two separate elements would need
 * word-merging upstream first).
 */
export function extractFromLabelSource(block: ExtractionBlock, source: LabelSource): RawExtractionResult {
  const labelMatch = source.labelIsRegex ? compileRegex(source.labelPattern, 'labelPattern') : { regex: null, error: null };
  if (labelMatch.error) return notFound(source.labelPattern, [labelMatch.error]);

  let nextLabelRegex: RegExp | null = null;
  if (source.stopAt === 'nextLabel') {
    if (!source.nextLabelPattern) {
      return notFound(source.labelPattern, [{ severity: 'error', code: 'STATBLOCK_MISSING_NEXT_LABEL_PATTERN', params: {} }]);
    }
    if (source.nextLabelIsRegex) {
      const nextMatch = compileRegex(source.nextLabelPattern, 'nextLabelPattern');
      if (nextMatch.error) return notFound(source.labelPattern, [nextMatch.error]);
      nextLabelRegex = nextMatch.regex;
    }
  }

  const lines = reconstructLines(block.elements);
  if (lines.length === 0) return notFound(source.labelPattern);

  const matchesLabel = (text: string): boolean => (labelMatch.regex ? labelMatch.regex.test(text.trim()) : text.trim() === source.labelPattern);
  const matchesNextLabel = (text: string): boolean => (nextLabelRegex ? nextLabelRegex.test(text.trim()) : text.trim() === source.nextLabelPattern);

  let labelLineIndex = -1;
  let labelElementIndex = -1;
  for (let li = 0; li < lines.length && labelLineIndex === -1; li++) {
    const elements = lines[li]!.elements;
    for (let ei = 0; ei < elements.length; ei++) {
      if (matchesLabel(elements[ei]!.text)) {
        labelLineIndex = li;
        labelElementIndex = ei;
        break;
      }
    }
  }
  if (labelLineIndex === -1) return notFound(source.labelPattern);

  const labelLine = lines[labelLineIndex]!;
  const labelElement = labelLine.elements[labelElementIndex]!;
  const remainderOnLabelLine = labelLine.elements.slice(labelElementIndex + 1);
  // `matchedElements` includes the label element itself — it's part of the
  // EVIDENCE for where this value came from (used for `sourceBbox`), even
  // though the label's own text is excluded from `raw`.
  const matchedElements: PageTextElement[] = [labelElement, ...remainderOnLabelLine];
  const textParts: string[] = [remainderOnLabelLine.map((e) => e.text).join(' ')];

  if (source.stopAt !== 'endOfLine') {
    for (let li = labelLineIndex + 1; li < lines.length; li++) {
      const line = lines[li]!;
      if (source.stopAt === 'nextLabel' && matchesNextLabel(line.text)) break;
      textParts.push(line.text);
      matchedElements.push(...line.elements);
    }
  }

  const raw = textParts.filter((part) => part.length > 0).join('\n');
  const diagnostics: Diagnostic[] = [];
  if (raw.length === 0) diagnostics.push({ severity: 'info', code: 'STATBLOCK_LABEL_VALUE_EMPTY', params: { labelPattern: source.labelPattern } });

  const sourceBbox = matchedElements.slice(1).reduce((acc, e) => unionRect(acc, elementBBox(e)), elementBBox(matchedElements[0]!));
  return { found: true, raw, matchedElements, sourceBbox, diagnostics };
}
