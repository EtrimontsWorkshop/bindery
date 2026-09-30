import type { FieldTypeConstraints } from '../extract/castAndValidate.js';
import type { SchemaFieldDescriptor } from '../schema/types.js';

/**
 * [Task 4] `SchemaFieldDescriptor.type` (`schema/types.ts`) and
 * `ProfileFieldDataType` (`profile/schema.ts`) are the SAME taxonomy by
 * design (the latter's own doc comment: "mirrors SchemaFieldKind minus
 * 'unsupported'") — a descriptor found via `findDescriptor` (reused from
 * `profile/validateAgainstSchema.ts`, same tree-walk Task 1 already needed)
 * carries everything `castAndValidate` (Task 2) needs, so this is a
 * relabeling, not a conversion. A descriptor of type `'unsupported'` never
 * reaches here — `validateProfileAgainstSchema`/`checkField` already flags
 * that as a hard type mismatch before an import ever runs.
 */
export function descriptorToConstraints(descriptor: SchemaFieldDescriptor): FieldTypeConstraints {
  return {
    dataType: descriptor.type as FieldTypeConstraints['dataType'],
    min: descriptor.min,
    max: descriptor.max,
    integer: descriptor.integer,
    choices: descriptor.choices?.map((c) => c.value),
  };
}

/**
 * Every SCALAR leaf in a descriptor tree (no `children`) — the set
 * `inheritUnmappedFromTemplate` walks to copy a template's own current
 * values onto paths the profile doesn't otherwise map. An `'object'`- or
 * `'array'`-shaped descriptor with children is never itself a leaf (its own
 * children are, or it has none and is skipped entirely — nothing sane to
 * inherit for an empty array/object shape).
 */
export function flattenLeafDescriptors(tree: readonly SchemaFieldDescriptor[]): SchemaFieldDescriptor[] {
  const leaves: SchemaFieldDescriptor[] = [];
  const walk = (list: readonly SchemaFieldDescriptor[]): void => {
    for (const descriptor of list) {
      if (descriptor.children && descriptor.children.length > 0) {
        walk(descriptor.children);
      } else {
        leaves.push(descriptor);
      }
    }
  };
  walk(tree);
  return leaves;
}
