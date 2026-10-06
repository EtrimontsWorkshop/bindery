import type { Diagnostic } from '../../../text/types.js';
import type { ValueMap } from '../../profile/schema.js';
import type { PageTextElement } from '../types.js';

/**
 * The transform chain: trim, whitespace
 * normalization, wrapped-line joining + dehyphenation, ligature/odd-char
 * stripping, a regex with a capture group, int/float parsing (signs
 * `+`/`−`/`–`/`-`, Unicode vulgar fractions), the Nth number in the text,
 * split/join, mapping through a profile `ValueMap` (fuzzy, case-
 * insensitive lookup being the main one), text-to-HTML (paragraphs,
 * bold), and a default value. Each step's input is the PREVIOUS step's
 * output (`unknown` — the value's actual type shifts through the chain:
 * string -> string -> number -> ..., a profile author's own responsibility
 * to order correctly).
 */
export type TransformStep =
  | { kind: 'trim' }
  | { kind: 'normalizeWhitespace' }
  | { kind: 'joinWrappedLines' }
  | { kind: 'stripLigaturesAndOddChars' }
  | { kind: 'regexExtract'; pattern: string; group?: number }
  | { kind: 'parseNumber' }
  | { kind: 'nthNumber'; n: number }
  | { kind: 'split'; separator: string; separatorIsRegex?: boolean }
  | { kind: 'join'; separator: string }
  | { kind: 'valueMap'; valueMap: ValueMap }
  | { kind: 'textToHtml' }
  | { kind: 'defaultValue'; value: unknown };

/** Read-only context every step receives alongside the evolving chain value — most steps ignore it; `textToHtml` uses it for bold-run detection, which a plain string has already lost. */
export interface TransformContext {
  elements: readonly PageTextElement[];
}

export interface TransformStepResult {
  value: unknown;
  diagnostics: Diagnostic[];
}
