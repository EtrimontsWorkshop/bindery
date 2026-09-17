import type { EntityAnalysis } from './studioAnalysis.js';

/**
 * [Step 24 Z3, "the only function that catches silent mapping corruption" per the brief] In
 * step 19 the key `P` was mapped to `hitPoints`, but it turned out to be
 * `sanity` — no test caught this, because the values
 * looked plausible (numbers within a sensible range). It was only caught by
 * the relation `HP ≈ (CON+SIZ)/10` checked manually across 27 statblocks. This file
 * automates EXACTLY that idea: a profile author who knows their system's
 * formulas by heart enters relations between canonical keys, the engine
 * checks them across ALL found entities and shows mismatches WITH
 * CONCRETE VALUES, not just a match percentage.
 *
 * [Brief, verbatim] "Don't build an expression language — two operators, four
 * operations, references to canonical keys." Relation syntax: `key ≈
 * expression` or `key = expression`, where an expression is `+ - * /` and parentheses over
 * canonical keys and numbers. No other operator/function.
 */

export interface EntityCanonicalValues {
  /** Label to display in a mismatch (entity name or placeholder) — HUMAN-READABLE, not a raw `ordinal`. */
  label: string;
  values: Readonly<Record<string, number>>;
}

/** The first number (integer or decimal, optionally negative) found in a value's text from the PDF — "12/12" -> 12, a dice-notation damage modifier like "+1D4" -> 1, "–" -> none (null). Dice notation (e.g. D4/D6) is DELIBERATELY out of scope (the same brief as selection-based inference — "don't try to be clever"). */
function parseNumericValue(raw: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(raw);
  return m ? Number(m[0]) : null;
}

/** [Step 24 Z3] Extracts numeric values of canonical keys from an ALREADY COMPUTED entity analysis (`grid.pairs` + `derived.match.pairs`, the attribute grid and the derived-stats block — the only two `labelledPairs` locations where `canonicalKey` exists at all). Non-numeric values (dashes, dice notation) are SKIPPED — a relation referencing such a key simply can't be evaluated for that entity (see `totalChecked` in the result), and doesn't count as "0" or as an error. */
export function extractCanonicalValues(entity: EntityAnalysis): EntityCanonicalValues {
  const values: Record<string, number> = {};
  for (const p of entity.grid.pairs) {
    const n = parseNumericValue(p.value);
    if (n !== null) values[p.canonicalKey] = n;
  }
  if (entity.derived.match) {
    for (const p of entity.derived.match.pairs) {
      const n = parseNumericValue(p.value);
      if (n !== null) values[p.canonicalKey] = n;
    }
  }
  const label = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
  return { label, values };
}

export type RelationOperator = '≈' | '=';

export interface ParsedRelation {
  lhsKey: string;
  op: RelationOperator;
  rhsExpr: string;
}

const RELATION_RE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(≈|=)\s*(.+?)\s*$/u;

/** `null` when the text doesn't match the `key ≈ expression` / `key = expression` syntax at all (e.g. no operator). */
export function parseRelation(text: string): ParsedRelation | null {
  const m = RELATION_RE.exec(text);
  if (!m) return null;
  return { lhsKey: m[1]!, op: m[2] as RelationOperator, rhsExpr: m[3]! };
}

const EXPR_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?|[()+\-*/]/g;

/**
 * Evaluates an arithmetic expression (`+ - * /`, parentheses, canonical keys,
 * numbers) over `values`. Returns `null` on a syntax error OR an unknown/missing
 * key (distinguished from "0" — a missing value is NOT zero) OR
 * division by zero.
 */
export function evaluateExpression(expr: string, values: Readonly<Record<string, number>>): number | null {
  const tokens = expr.match(EXPR_TOKEN_RE);
  if (!tokens || tokens.join('').length !== expr.replace(/\s+/g, '').length) return null; // a character outside the allowed alphabet somewhere in the expression
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const consume = (): string => tokens[pos++]!;

  function parseFactor(): number | null {
    const t = peek();
    if (t === undefined) return null;
    if (t === '(') {
      consume();
      const v = parseExpr();
      if (v === null || peek() !== ')') return null;
      consume();
      return v;
    }
    if (t === '-') {
      consume();
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (/^\d/.test(t)) {
      consume();
      return Number(t);
    }
    if (/^[A-Za-z]/.test(t)) {
      consume();
      return t in values ? values[t]! : null;
    }
    return null;
  }

  function parseTerm(): number | null {
    let v = parseFactor();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const rhs = parseFactor();
      if (rhs === null) return null;
      if (op === '*') v = v * rhs;
      else {
        if (rhs === 0) return null;
        v = v / rhs;
      }
    }
    return v;
  }

  function parseExpr(): number | null {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseExpr();
  if (pos !== tokens.length) return null; // tokens remaining after parsing the whole expression = a syntax error (e.g. two expressions next to each other)
  return result;
}

/** Rounding tolerance for `≈` — the LARGER of {1, 5% of the expected value}, to absorb rounding from division (e.g. an averaging formula like `(CON+SIZ)/10`) without hiding genuine mismatches at large values. Not calibrated against any specific system (none was available to measure at this step) — documented and easy to change, not hardcoded without explanation (the same standard as `AMBIGUITY_RATIO_THRESHOLD` in `entityAssembly.ts`). */
function withinApproxTolerance(actual: number, expected: number): boolean {
  const tolerance = Math.max(1, Math.abs(expected) * 0.05);
  return Math.abs(actual - expected) <= tolerance;
}

export interface RelationMismatch {
  label: string;
  actual: number;
  expected: number;
}

export interface RelationCheckOk {
  text: string;
  ok: true;
  lhsKey: string;
  op: RelationOperator;
  /** Number of entities for which BOTH sides (lhsKey and the expression) could be evaluated — the denominator of the match rate. */
  totalChecked: number;
  matchCount: number;
  /** Mismatches WITH CONCRETE VALUES (brief: "not just a percentage") — ALL of them, not just an example. */
  mismatches: readonly RelationMismatch[];
  /** [Brief] "a warning when the match rate is very low (probably a bad mapping) or perfect for an equality relation (probably the same field mapped twice)". */
  warning: 'low-match-rate' | 'suspiciously-perfect-equality' | null;
}

export interface RelationCheckError {
  text: string;
  ok: false;
  /** An error code, not ready-made text — localization happens on the UI side (`packages/module`), this package has no i18n (A1). */
  errorCode: 'unparseable';
}

export type RelationCheckResult = RelationCheckOk | RelationCheckError;

// [Step 24 Z3, calibrated on a real book] The correct relation
// (`hitPoints ≈ (constitution+size)/10` with the ORIGINAL, correct mapping)
// gave 13/14 = 93% match rate on `coc7-niczas-pl`. Simulating bug A11 ("P"
// mapped to `hitPoints` instead of `sanity`) gave 8/14 = 57%. A threshold of 0.5 (half)
// was TOO LOW -- 57% would have counted as "good enough" and the bug would have
// gone through SILENTLY, exactly as in the real incident from step 19.
// 0.7 correctly separates both measured cases.
const LOW_MATCH_RATE_THRESHOLD = 0.7;
const LOW_MATCH_MIN_SAMPLE = 2;
const PERFECT_EQUALITY_MIN_SAMPLE = 2;

/** Checks ONE relation across ALL supplied entities. Never throws — bad syntax/an unknown key gives a readable `ok: false`, not an exception (the same standard as `validateProfile`). */
export function checkRelation(text: string, entities: readonly EntityCanonicalValues[]): RelationCheckResult {
  const parsed = parseRelation(text);
  if (!parsed) return { text, ok: false, errorCode: 'unparseable' };

  const mismatches: RelationMismatch[] = [];
  let totalChecked = 0;
  let matchCount = 0;

  for (const entity of entities) {
    const actual = parsed.lhsKey in entity.values ? entity.values[parsed.lhsKey]! : null;
    const expected = evaluateExpression(parsed.rhsExpr, entity.values);
    if (actual === null || expected === null) continue;
    totalChecked++;
    const matches = parsed.op === '≈' ? withinApproxTolerance(actual, expected) : actual === expected;
    if (matches) matchCount++;
    else mismatches.push({ label: entity.label, actual, expected });
  }

  let warning: RelationCheckOk['warning'] = null;
  if (totalChecked >= LOW_MATCH_MIN_SAMPLE && matchCount / totalChecked < LOW_MATCH_RATE_THRESHOLD) {
    warning = 'low-match-rate';
  } else if (parsed.op === '=' && totalChecked >= PERFECT_EQUALITY_MIN_SAMPLE && matchCount === totalChecked) {
    warning = 'suspiciously-perfect-equality';
  }

  return { text, ok: true, lhsKey: parsed.lhsKey, op: parsed.op, totalChecked, matchCount, mismatches, warning };
}

/** Checks MULTIPLE relations at once (one form row per relation) — a pure call-site convenience, `checkRelation` per row. */
export function checkRelations(texts: readonly string[], entities: readonly EntityCanonicalValues[]): RelationCheckResult[] {
  return texts.map((text) => checkRelation(text, entities));
}
