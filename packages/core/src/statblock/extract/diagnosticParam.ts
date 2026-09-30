/**
 * [Task 2] `Diagnostic.params` (see `../../localizableMessage.ts`) is typed
 * `Record<string, string | number>` — it feeds a localization TEMPLATE
 * (interpolated into a sentence), so it can't hold arbitrary objects/
 * arrays/booleans/undefined. This module's diagnostics sometimes want to
 * report a non-primitive (a filter object, a rect, a choices list) for
 * debugging — `toParamValue` gives a readable string representation
 * instead of silently dropping the information or fighting the type.
 */
export function toParamValue(value: unknown): string | number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
