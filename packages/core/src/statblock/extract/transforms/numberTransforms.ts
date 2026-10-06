import type { TransformStepResult } from './types.js';

/** Unicode vulgar fractions this project bothers to recognize — the common ones a statblock might use for a mixed number like "1½" (movement speed, etc.). Not exhaustive (there is no U+00BD-style glyph for every possible fraction). */
const FRACTION_VALUES: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
};
const FRACTION_CHARS = Object.keys(FRACTION_VALUES).join('');

// Group 1: sign (+, U+2212 MINUS SIGN, U+2013 EN DASH used as minus by some
// fonts/typesetting, or plain hyphen-minus — all four seen in real PDFs).
// Groups 2+3: an optional whole-number part immediately followed by a
// Unicode vulgar fraction character (a mixed number like "1½") — tried
// FIRST, deliberately, so "1½" doesn't match just the plain-number
// alternative on its leading "1" and silently drop the fraction (regex
// alternation doesn't backtrack into a later, also-viable branch once an
// earlier one succeeds). Group 4: a plain decimal number, tried only when
// no fraction character follows. Exactly one of (3) or (4) is present in
// any match, never both.
const NUMBER_TOKEN_RE = new RegExp(`([+−–-])?\\s*(?:(\\d*)([${FRACTION_CHARS}])|(\\d+(?:\\.\\d+)?))`);

/**
 * [Task 2] Parses the FIRST number found anywhere in the string —
 * "int/float, signs +/−/–/-, fractions" per the brief. Always produces a
 * plain JS `number` (int vs. float is a `castAndValidate` concern via the
 * target field's `integer` constraint, not a parsing mode here). A
 * standalone dash with no digits at all (a common "N/A" convention in
 * statblocks) deliberately does NOT parse as a number — there's nothing to
 * parse; a profile author who wants to treat that as e.g. `0` uses
 * `defaultValue` after this step.
 */
export function parseNumber(input: unknown): TransformStepResult {
  if (typeof input !== 'string') return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_PARSE_NUMBER_NOT_STRING', params: {} }] };
  const match = NUMBER_TOKEN_RE.exec(input);
  if (!match) return { value: undefined, diagnostics: [{ severity: 'warning', code: 'STATBLOCK_PARSE_NUMBER_NOT_FOUND', params: { input } }] };
  const [, signChar, wholePart, fractionChar, plain] = match;
  const negative = signChar === '-' || signChar === '−' || signChar === '–';
  const magnitude = fractionChar !== undefined ? (wholePart ? Number.parseInt(wholePart, 10) : 0) + FRACTION_VALUES[fractionChar]! : Number.parseFloat(plain!);
  return { value: negative ? -magnitude : magnitude, diagnostics: [] };
}

const SIMPLE_NUMBER_RE = /[+−–-]?\d+(?:\.\d+)?/g;

/** Extracts the Nth (1-indexed) number found in the text, as a STRING — compose with `parseNumber` afterward to get an actual number (e.g. "current/max" values like "12/12": `nthNumber(2)` then `parseNumber` gets the max). */
export function nthNumber(input: unknown, n: number): TransformStepResult {
  if (typeof input !== 'string') return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_NTH_NUMBER_NOT_STRING', params: {} }] };
  const matches = [...input.matchAll(SIMPLE_NUMBER_RE)];
  const match = matches[n - 1];
  if (!match) return { value: undefined, diagnostics: [{ severity: 'warning', code: 'STATBLOCK_NTH_NUMBER_NOT_FOUND', params: { input, n } }] };
  return { value: match[0], diagnostics: [] };
}
