import type { ValueMap } from '../../profile/schema.js';
import type { TransformStepResult } from './types.js';

function normalizeForFuzzyMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Classic edit-distance DP — small inputs only (statblock field values, not paragraphs), so the O(n*m) table is never a concern. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + substitutionCost);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

/**
 * "Mapping through valueMaps (fuzzy, case-insensitive)" — the
 * main `ValueMap.kind`. Three tiers, each only tried if the previous
 * found nothing: (1) exact match, case-insensitive by default
 * (`params.caseInsensitive`, default `true`); (2) if `params.fuzzy`, an exact match after
 * stripping everything but letters/digits (handles punctuation/whitespace
 * differences, e.g. a stray footnote asterisk); (3) if still nothing and
 * `params.fuzzy`, the closest key by Levenshtein distance within a
 * length-proportional threshold (handles a genuine OCR-grade typo without
 * matching two truly unrelated keys).
 */
function applyLookupTable(input: string, params: Record<string, unknown>): TransformStepResult {
  const entries = (params['entries'] as Record<string, string> | undefined) ?? {};
  const caseInsensitive = params['caseInsensitive'] !== false;
  const fuzzy = params['fuzzy'] === true;
  const keys = Object.entries(entries);
  const trimmedInput = input.trim();

  const target = caseInsensitive ? trimmedInput.toLowerCase() : trimmedInput;
  for (const [key, value] of keys) {
    if ((caseInsensitive ? key.toLowerCase() : key) === target) return { value, diagnostics: [] };
  }

  if (fuzzy) {
    const normalizedTarget = normalizeForFuzzyMatch(trimmedInput);
    for (const [key, value] of keys) {
      if (normalizeForFuzzyMatch(key) === normalizedTarget) {
        return { value, diagnostics: [{ severity: 'info', code: 'STATBLOCK_VALUE_MAP_NORMALIZED_MATCH', params: { input: trimmedInput, matchedKey: key } }] };
      }
    }
    let bestKey: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [key] of keys) {
      const distance = levenshteinDistance(normalizedTarget, normalizeForFuzzyMatch(key));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = key;
      }
    }
    const threshold = Math.max(1, Math.floor(normalizedTarget.length * 0.25));
    if (bestKey !== null && bestDistance <= threshold) {
      return { value: entries[bestKey], diagnostics: [{ severity: 'info', code: 'STATBLOCK_VALUE_MAP_FUZZY_MATCH', params: { input: trimmedInput, matchedKey: bestKey, distance: bestDistance } }] };
    }
  }

  return { value: undefined, diagnostics: [{ severity: 'warning', code: 'STATBLOCK_VALUE_MAP_NO_MATCH', params: { input: trimmedInput } }] };
}

function applyStripUnits(input: string, params: Record<string, unknown>): TransformStepResult {
  const unit = params['unit'];
  if (typeof unit !== 'string' || unit.length === 0) return { value: input, diagnostics: [] };
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { value: input.replace(new RegExp(`\\s*${escapedUnit}\\s*`, 'gi'), '').trim(), diagnostics: [] };
}

function applyRegexReplace(input: string, params: Record<string, unknown>): TransformStepResult {
  const pattern = params['pattern'];
  const replacement = params['replacement'];
  if (typeof pattern !== 'string' || typeof replacement !== 'string') {
    return { value: input, diagnostics: [{ severity: 'error', code: 'STATBLOCK_VALUE_MAP_INVALID_PARAMS', params: { kind: 'regexReplace' } }] };
  }
  const flags = typeof params['flags'] === 'string' ? (params['flags'] as string) : 'g';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return { value: input, diagnostics: [{ severity: 'error', code: 'STATBLOCK_INVALID_REGEX', params: { pattern, field: 'regexReplace' } }] };
  }
  return { value: input.replace(regex, replacement), diagnostics: [] };
}

/** Best-effort COSMETIC normalization only — NOT a dice-notation parser/evaluator (out of scope for this task): lowercases the die-size marker and puts single spaces around +/- so different books' spacing conventions compare equal after this step. */
function applyDiceNotation(input: string): TransformStepResult {
  const normalized = input
    .replace(/\s+/g, '')
    .replace(/D/g, 'd')
    .replace(/([+-])/g, ' $1 ')
    .trim();
  return { value: normalized, diagnostics: [] };
}

export function applyValueMap(input: unknown, valueMap: ValueMap): TransformStepResult {
  if (typeof input !== 'string') return { value: input, diagnostics: [] };
  switch (valueMap.kind) {
    case 'stripUnits':
      return applyStripUnits(input, valueMap.params);
    case 'regexReplace':
      return applyRegexReplace(input, valueMap.params);
    case 'diceNotation':
      return applyDiceNotation(input);
    case 'lookupTable':
      return applyLookupTable(input, valueMap.params);
  }
}
