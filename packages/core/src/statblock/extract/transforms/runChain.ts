import type { Diagnostic } from '../../../text/types.js';
import { joinText, joinWrappedLines, normalizeWhitespace, regexExtract, splitText, stripLigaturesAndOddChars, textToHtml, trim } from './textTransforms.js';
import { nthNumber, parseNumber } from './numberTransforms.js';
import { applyValueMap } from './valueMapTransform.js';
import type { TransformContext, TransformStep, TransformStepResult } from './types.js';

/**
 * `defaultValue` treats `undefined`/`null`/`''` as "nothing was
 * really found" and substitutes the configured value — every earlier
 * transform that fails passes `undefined` through rather than throwing
 * (see `textTransforms.ts`'s passthrough convention), so a `defaultValue`
 * step at the end of a chain reliably catches ANY earlier failure, not
 * just a missing source match.
 */
function applyDefaultValue(input: unknown, defaultValue: unknown): TransformStepResult {
  const isEmpty = input === undefined || input === null || input === '';
  return { value: isEmpty ? defaultValue : input, diagnostics: [] };
}

export function runTransformStep(step: TransformStep, value: unknown, context: TransformContext): TransformStepResult {
  switch (step.kind) {
    case 'trim':
      return trim(value);
    case 'normalizeWhitespace':
      return normalizeWhitespace(value);
    case 'joinWrappedLines':
      return joinWrappedLines(value);
    case 'stripLigaturesAndOddChars':
      return stripLigaturesAndOddChars(value);
    case 'regexExtract':
      return regexExtract(value, step.pattern, step.group);
    case 'parseNumber':
      return parseNumber(value);
    case 'nthNumber':
      return nthNumber(value, step.n);
    case 'split':
      return splitText(value, step.separator, step.separatorIsRegex);
    case 'join':
      return joinText(value, step.separator);
    case 'valueMap':
      return applyValueMap(value, step.valueMap);
    case 'textToHtml':
      return textToHtml(context);
    case 'defaultValue':
      return applyDefaultValue(value, step.value);
  }
}

/** Runs every step in order, threading each step's output into the next — see `TransformStep` for the full list. Never throws: every individual transform degrades to `undefined`/a no-op on unexpected input rather than raising. */
export function runTransformChain(steps: readonly TransformStep[], initialValue: unknown, context: TransformContext): { value: unknown; diagnostics: Diagnostic[] } {
  let value = initialValue;
  const diagnostics: Diagnostic[] = [];
  for (const step of steps) {
    const result = runTransformStep(step, value, context);
    value = result.value;
    diagnostics.push(...result.diagnostics);
  }
  return { value, diagnostics };
}
