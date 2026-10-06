import type { SchemaFieldDescriptor } from './types.js';

/**
 * Minimal, dependency-free re-implementation of
 * `foundry.utils.getProperty` for a dot path — deliberately NOT imported
 * from Foundry (core has zero Foundry dependency, A1/`check:boundary`).
 * `''` (the synthetic root path) resolves to `data` itself.
 */
function getAtPath(data: unknown, path: string): unknown {
  if (path === '') return data;
  let current = data;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Fills in `currentValue` on every descriptor (and recursively,
 * every descendant) by reading `systemData` at the descriptor's own
 * (already-absolute, dot-path-into-`system`) `path` — mutates the tree
 * in place and returns it for convenient chaining. Pure: takes a plain
 * nested object, not a live Foundry document (the module layer is
 * responsible for calling `.toObject()`/reading `.system` first).
 *
 * The synthetic "shape of one array element" child (see
 * `describeSchemaField`) shares its parent's `path`, so it ends up with
 * the SAME `currentValue` (the whole array) as its parent — harmless
 * duplication, not a bug: there is no single "the" element to point at.
 */
export function attachCurrentValues(descriptors: readonly SchemaFieldDescriptor[], systemData: unknown): SchemaFieldDescriptor[] {
  for (const descriptor of descriptors) {
    descriptor.currentValue = getAtPath(systemData, descriptor.path);
    if (descriptor.children) attachCurrentValues(descriptor.children, systemData);
  }
  return descriptors as SchemaFieldDescriptor[];
}
