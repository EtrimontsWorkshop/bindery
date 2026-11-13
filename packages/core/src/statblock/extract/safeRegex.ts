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

/**
 * How many nested "try every position" loops a search may have (see `hasOverlappingRepeats`). With the text cut at
 * `MAX_TEXT_LENGTH` characters, two loops are a few million steps; three were measured at four seconds for one line.
 */
const MAX_BACKTRACK_DEGREE = 2;

/** Characters an atom is tried on to learn what it can match: printable ASCII, the white space, and a few beyond ASCII. */
const SAMPLE_CHARS: readonly string[] = [...'\t\n\r', ...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)), ' ', 'é', 'ł', 'Ж', '中'];

const sampleMatchesByAtom = new Map<string, readonly boolean[]>();

/** For every sample character, whether the atom (`a`, `\d`, `.`, `[a-z]`) matches it. An atom that cannot be compiled alone counts as matching all. */
function sampleMatches(atom: string): readonly boolean[] {
  let matches = sampleMatchesByAtom.get(atom);
  if (!matches) {
    try {
      const regex = new RegExp(`^(?:${atom})$`, 's');
      matches = SAMPLE_CHARS.map((ch) => regex.test(ch));
    } catch {
      matches = SAMPLE_CHARS.map(() => true);
    }
    sampleMatchesByAtom.set(atom, matches);
  }
  return matches;
}

/**
 * Whether the pattern can make the engine try every way of dividing a stretch of text among several unbounded repeats
 * that match the same characters, such as `\w*\w*\w*!` or `.*\d+x`. Nothing is nested there, so `isRegexRisky`'s
 * other rules pass it, yet when the part after the repeats does not match, the time grows with the length of the text
 * to the power of the number of such repeats (plus one when the pattern does not start with `^`, because the search
 * is then tried from every position too). Past `MAX_BACKTRACK_DEGREE` a single line of a statblock hangs the page.
 *
 * The repeats are counted where something after them can fail: an atom that must match a character, or `$`. A run of
 * repeats that the pattern ends with always succeeds, so `(.+):\s*(.+)` is fine. A run ends at an alternative (`|`)
 * and at an atom that must match a character none of its repeats can (the `\s+` in `\d+\s+\d+`). Optional atoms
 * and group brackets do not end it: `(\w*)(\w*)(\w*)$` is one run.
 */
function hasOverlappingRepeats(source: string): boolean {
  const anchored = source.startsWith('^') && !source.includes('|');
  const allowed = MAX_BACKTRACK_DEGREE - (anchored ? 0 : 1);
  /** Per sample character: how many repeats of the current run match it. */
  let counts: number[] = SAMPLE_CHARS.map(() => 0);
  /** Too many repeats share a character that the atom `failing` (`null`: the end of the text) does not match. */
  const tooMany = (failing: readonly boolean[] | null): boolean => counts.some((count, k) => count > allowed && !(failing?.[k] ?? false));

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    let atom: string;
    if (c === '\\') {
      atom = source.slice(i, i + 2);
      i++;
      if (atom === '\\b' || atom === '\\B') continue;
    } else if (c === '[') {
      const start = i;
      i++;
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      atom = source.slice(start, i + 1);
    } else if (c === '(') {
      if (source[i + 1] === '?') i += source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!' ? Math.max(2, source.indexOf('>', i) - i) : 2;
      continue;
    } else if (c === ')') {
      const quantifier = readQuantifier(source, i + 1);
      if (quantifier) i += quantifier.length;
      continue;
    } else if (c === '|') {
      counts = SAMPLE_CHARS.map(() => 0);
      continue;
    } else if (c === '^') {
      continue;
    } else if (c === '$') {
      if (tooMany(null)) return true;
      continue;
    } else {
      atom = c;
    }

    const quantifier = readQuantifier(source, i + 1);
    let mandatory = true;
    if (quantifier) {
      const text = source.slice(i + 1, i + 1 + quantifier.length);
      mandatory = !(text === '*' || text === '?' || /^\{0[,}]/.test(text));
      i += quantifier.length;
      if (source[i + 1] === '?') i++; // a lazy repeat backtracks just the same
    }
    const matches = sampleMatches(atom);
    if (mandatory) {
      if (tooMany(matches)) return true;
      // It must match a character none of the run's repeats can match: where they end is fixed, a new run starts.
      if (!counts.some((count, k) => count > 0 && matches[k])) counts = SAMPLE_CHARS.map(() => 0);
    }
    if (quantifier?.unbounded) matches.forEach((hit, k) => hit && counts[k]!++);
  }
  return false;
}

/** Compiles a pattern from a profile; never throws. */
export function compileProfileRegex(pattern: string, flags?: string): CompiledRegex {
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, problem: 'tooLong' };
  if (isRegexRisky(pattern) || hasOverlappingRepeats(pattern)) return { ok: false, problem: 'tooComplex' };
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
