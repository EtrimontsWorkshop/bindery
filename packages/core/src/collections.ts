/**
 * Grouping by quantized position — one shared mechanism instead of three
 * independently implemented: `collectGapSamples`, `mergeWords`,
 * `correlateImagesByBBox`.
 *
 * There is no single universal quantization STEP — text tolerance (derived
 * from font size, see `baselineTolerance`) and image tolerance (a constant
 * 0.5pt) are inherently different domains. Only the grouping mechanics are
 * shared; each call site supplies its OWN, explicit quantization function
 * (`keyOf`) — an explicit quantization parameter,
 * visible at the call site, not hidden inside the shared function.
 */
export function groupByQuantizedPosition<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const arr = groups.get(key);
    if (arr) arr.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
