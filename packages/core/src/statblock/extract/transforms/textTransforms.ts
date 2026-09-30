import { reconstructLines } from '../reconstructLines.js';
import type { TransformContext, TransformStepResult } from './types.js';

/** Every text transform below is a no-op passthrough on non-string input, rather than throwing — a chain step that ran into an earlier failure (input already `undefined`) should let a LATER `defaultValue` step catch it, not crash the whole chain. */
function passthroughIfNotString(input: unknown): input is string {
  return typeof input === 'string';
}

export function trim(input: unknown): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: input, diagnostics: [] };
  return { value: input.trim(), diagnostics: [] };
}

/** Collapses runs of horizontal whitespace (space/tab) to one space and trims each line, WITHOUT touching line breaks — multi-line joining is `joinWrappedLines`' job, run separately so it can make its own dehyphenation decision from intact line boundaries. */
export function normalizeWhitespace(input: unknown): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: input, diagnostics: [] };
  const normalized = input
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  return { value: normalized, diagnostics: [] };
}

// Hyphen-minus, Unicode HYPHEN, non-breaking hyphen — the characters a line-wrapped word is typically split with.
const TRAILING_HYPHEN_RE = /[-‐‑]$/;

/**
 * Joins a multi-line raw capture (from `endOfBlock`/`nextLabel` label
 * sources, or any multi-line region) into one flowing line. A line ending
 * in a hyphen immediately followed by a line starting with a lowercase
 * letter is treated as a wrapped word and rejoined WITHOUT the hyphen or a
 * space (the common signal for line-wrap hyphenation); every other line
 * boundary joins with a single space. Blank lines are dropped rather than
 * becoming a stray double space.
 */
export function joinWrappedLines(input: unknown): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: input, diagnostics: [] };
  const lines = input.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return { value: '', diagnostics: [] };
  let result = lines[0]!;
  for (let i = 1; i < lines.length; i++) {
    const nextLine = lines[i]!;
    if (TRAILING_HYPHEN_RE.test(result) && /^[a-z]/.test(nextLine)) {
      result = result.slice(0, -1) + nextLine;
    } else {
      result = `${result} ${nextLine}`;
    }
  }
  return { value: result, diagnostics: [] };
}

const LIGATURE_MAP: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};

/** Common ligature glyphs pdf.js sometimes surfaces as their own character (ﬁ, ﬂ, ...) replaced with plain letters, plus Unicode control characters and Private-Use-Area codepoints (a frequent source of "garbage glyph" artifacts from embedded font subsets) stripped outright. `\n` is deliberately preserved. */
export function stripLigaturesAndOddChars(input: unknown): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: input, diagnostics: [] };
  let result = input;
  for (const [ligature, plain] of Object.entries(LIGATURE_MAP)) result = result.split(ligature).join(plain);
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters to strip them
  result = result.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  result = result.replace(/[-]/g, '');
  return { value: result, diagnostics: [] };
}

export function regexExtract(input: unknown, pattern: string, group = 0): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: undefined, diagnostics: [] };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_INVALID_REGEX', params: { pattern, field: 'regexExtract' } }] };
  }
  const match = regex.exec(input);
  if (!match) return { value: undefined, diagnostics: [{ severity: 'warning', code: 'STATBLOCK_REGEX_NO_MATCH', params: { pattern, input } }] };
  const captured = match[group];
  if (captured === undefined) return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_REGEX_GROUP_MISSING', params: { pattern, group } }] };
  return { value: captured, diagnostics: [] };
}

export function splitText(input: unknown, separator: string, separatorIsRegex = false): TransformStepResult {
  if (!passthroughIfNotString(input)) return { value: undefined, diagnostics: [] };
  if (!separatorIsRegex) return { value: input.split(separator), diagnostics: [] };
  let regex: RegExp;
  try {
    regex = new RegExp(separator);
  } catch {
    return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_INVALID_REGEX', params: { pattern: separator, field: 'split' } }] };
  }
  return { value: input.split(regex), diagnostics: [] };
}

export function joinText(input: unknown, separator: string): TransformStepResult {
  if (input === undefined) return { value: undefined, diagnostics: [] };
  if (!Array.isArray(input)) return { value: input, diagnostics: [{ severity: 'error', code: 'STATBLOCK_JOIN_NOT_ARRAY', params: {} }] };
  return { value: (input as unknown[]).map((v) => String(v)).join(separator), diagnostics: [] };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders `context.elements` (NOT the chain's string value — a plain
 * string has already lost per-word bold/italic information) as HTML: one
 * `<p>` per reconstructed line, with consecutive bold elements wrapped in
 * `<strong>`. Deliberately line-grained (paragraphs of MULTIPLE original
 * lines aren't merged here) — a profile author who wants flowing prose
 * runs `joinWrappedLines` on the plain-text value in a separate field/step
 * instead; this transform is for "show it formatted", not "clean the
 * text".
 */
export function textToHtml(context: TransformContext): TransformStepResult {
  const lines = reconstructLines(context.elements);
  if (lines.length === 0) return { value: '', diagnostics: [{ severity: 'info', code: 'STATBLOCK_TEXT_TO_HTML_EMPTY', params: {} }] };
  const paragraphs = lines.map((line) => {
    const runs: string[] = [];
    let i = 0;
    while (i < line.elements.length) {
      const isBold = line.elements[i]!.bold;
      let j = i;
      const words: string[] = [];
      while (j < line.elements.length && line.elements[j]!.bold === isBold) {
        words.push(escapeHtml(line.elements[j]!.text));
        j++;
      }
      const text = words.join(' ');
      runs.push(isBold ? `<strong>${text}</strong>` : text);
      i = j;
    }
    return `<p>${runs.join(' ')}</p>`;
  });
  return { value: paragraphs.join(''), diagnostics: [] };
}
