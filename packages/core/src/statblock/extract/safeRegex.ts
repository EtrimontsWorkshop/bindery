import type { Diagnostic } from '../../text/types.js';

/**
 * Regular expressions in a profile are untrusted input (a profile can be hand-written or exported from another
 * world), and they run on the main thread while a window is open. A pattern such as `^(a+)+$` takes exponential time on
 * a short non-matching text and would freeze the page. This module is the one place that compiles and runs them:
 *
 * - a pattern over `MAX_PATTERN_LENGTH` characters is refused;
 * - a pattern whose structure is known to backtrack catastrophically is refused (a group that is repeated without
 *   bound while it also repeats something without bound inside, or a repeated group of overlapping alternatives);
 * - the text a pattern is run against is cut to `MAX_TEXT_LENGTH` characters.
 *
 * The structure check is a heuristic: it catches the textbook shapes, not every possible pattern, so the length caps
 * stay in place as a second line of defence.
 */

export const MAX_PATTERN_LENGTH = 300;
export const MAX_TEXT_LENGTH = 2000;

export type RegexProblem = 'invalid' | 'tooLong' | 'tooComplex';

export type CompiledRegex = { ok: true; regex: RegExp } | { ok: false; problem: RegexProblem };

interface GroupFrame {
  /** An unbounded repetition (`*`, `+`, `{n,}`) occurs inside this group, at any depth. */
  hasUnbounded: boolean;
  alternatives: string[];
  /** First token of the alternative being read, `null` until one is seen. */
  currentFirst: string | null;
}

/** First-token classes that overlap with almost anything. */
const WIDE_TOKENS = new Set(['.', '\\w', '\\s', '\\S', '\\W', '\\D', '\\d', '[']);

function readQuantifier(source: string, index: number): { unbounded: boolean; length: number } | null {
  const c = source[index];
  if (c === '*' || c === '+') return { unbounded: true, length: 1 };
  if (c === '?') return { unbounded: false, length: 1 };
  if (c === '{') {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index));
    if (!match) return null;
    const open = match[2] !== undefined && match[3] === '';
    return { unbounded: open, length: match[0].length };
  }
  return null;
}

function alternativesOverlap(alternatives: readonly string[]): boolean {
  if (alternatives.length < 2) return false;
  const seen = new Set<string>();
  for (const first of alternatives) {
    if (WIDE_TOKENS.has(first) || seen.has(first)) return true;
    seen.add(first);
  }
  return false;
}

/** Whether the pattern has a structure known to backtrack catastrophically. */
export function isRegexRisky(source: string): boolean {
  const stack: GroupFrame[] = [];
  let top: GroupFrame = { hasUnbounded: false, alternatives: [], currentFirst: null };
  const noteToken = (token: string): void => {
    if (top.currentFirst === null) top.currentFirst = token;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      noteToken(source.slice(i, i + 2));
      i++;
      continue;
    }
    if (c === '[') {
      noteToken('[');
      i++;
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') {
      stack.push(top);
      top = { hasUnbounded: false, alternatives: [], currentFirst: null };
      if (source[i + 1] === '?') {
        // A group marker such as `(?:`, `(?=`, `(?<name>` — skip it so that its own characters are not read as a token.
        i += source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!' ? source.indexOf('>', i) - i : 2;
      }
      continue;
    }
    if (c === ')') {
      const frame = top;
      if (frame.currentFirst !== null) frame.alternatives.push(frame.currentFirst);
      top = stack.pop() ?? { hasUnbounded: false, alternatives: [], currentFirst: null };
      const quantifier = readQuantifier(source, i + 1);
      if (quantifier?.unbounded) {
        if (frame.hasUnbounded || alternativesOverlap(frame.alternatives)) return true;
        top.hasUnbounded = true;
      } else if (frame.hasUnbounded) {
        top.hasUnbounded = true;
      }
      if (quantifier) i += quantifier.length;
      top.currentFirst ??= '(';
      continue;
    }
    if (c === '|') {
      if (top.currentFirst !== null) top.alternatives.push(top.currentFirst);
      top.currentFirst = null;
      continue;
    }
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      if (quantifier.unbounded) top.hasUnbounded = true;
      i += quantifier.length - 1;
      continue;
    }
    noteToken(c);
  }
  return false;
}

/** Compiles a pattern from a profile; never throws. */
export function compileProfileRegex(pattern: string, flags?: string): CompiledRegex {
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, problem: 'tooLong' };
  if (isRegexRisky(pattern)) return { ok: false, problem: 'tooComplex' };
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch {
    return { ok: false, problem: 'invalid' };
  }
}

/** The text a profile pattern is run against: long enough for any printed line, short enough to bound the cost. */
export function boundedText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

/** Runs a compiled profile pattern against bounded text. */
export function testProfileRegex(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.test(boundedText(text));
}

/** The diagnostic for a pattern that was refused: a syntax error keeps its own code, a pattern that is too long or too complex gets another. */
export function regexProblemDiagnostic(problem: RegexProblem, pattern: string, field: string): Diagnostic {
  return problem === 'invalid'
    ? { severity: 'error', code: 'STATBLOCK_INVALID_REGEX', params: { pattern, field } }
    : { severity: 'error', code: 'STATBLOCK_REGEX_REFUSED', params: { pattern, field, problem } };
}
