import type { SchemaFieldDescriptor } from './types.js';

/**
 * Stable hash of a schema tree's STRUCTURE — paths, types and constraints,
 * in path order. Deliberately ignores everything that can change without
 * the schema itself changing: localized labels (language-dependent) and
 * `currentValue`/`initial` (come from whichever Actor was used as the
 * template). Used for `StatblockProfile.templateSchemaFingerprint`, so a
 * later system update that adds/removes/retypes a field can be noticed.
 *
 * Not cryptographic — a 53-bit string hash (cyrb53) is plenty for drift
 * detection and keeps this free of any platform crypto dependency.
 */
function collect(nodes: readonly SchemaFieldDescriptor[], out: string[]): void {
  for (const node of nodes) {
    const choices = node.choices?.map((c) => String(c.value)).join(',') ?? '';
    out.push(`${node.path}|${node.type}|${node.integer ? 'i' : ''}|${node.min ?? ''}|${node.max ?? ''}|${choices}`);
    if (node.children) collect(node.children, out);
  }
}

function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function computeSchemaFingerprint(descriptors: readonly SchemaFieldDescriptor[]): string {
  const lines: string[] = [];
  collect(descriptors, lines);
  return cyrb53(lines.sort().join('\n'));
}
