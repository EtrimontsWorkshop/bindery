/**
 * A pure, Foundry-free equivalent of `foundry.utils.setProperty` —
 * core cannot import that (`check:boundary`), and `buildActorData` needs
 * to assign values at dot paths discovered by schema introspection into a plain `system` object it is building from scratch. Creates
 * intermediate objects as needed; never throws (a path that tries to descend
 * through a non-object value is simply overwritten, since the caller only
 * ever passes paths that came from a real schema, but garbage input should
 * still degrade rather than crash the whole import run for one statblock).
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/** Reads the value at a dot path from a plain object, `undefined` when any step is missing. */
export function getPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
