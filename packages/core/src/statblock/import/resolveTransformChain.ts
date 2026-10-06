import type { Diagnostic } from '../../text/types.js';
import type { TransformStep } from '../extract/transforms/types.js';
import type { ProfileField, StatblockProfile } from '../profile/schema.js';

/**
 * [Task 4] Builds the full `TransformStep[]` `extractField` (Task 2) needs
 * from a `ProfileField`'s own `transforms` (Task 4, the generic steps) plus
 * its `valueMapId` (Task 1, dead until now — see `profile/schema.ts`'s
 * comment on `transforms` for why value-mapping stays a separate,
 * shareable-by-reference mechanism instead of one more inline transform
 * kind). The resolved value-map step is always appended LAST — a documented
 * simplification: there is no way, yet, for a profile to ask for a
 * value-map lookup in the MIDDLE of a chain (e.g. before a later
 * `regexExtract`). Every field written against today's schema only ever
 * needs one lookup, at the end, after everything else has normalized the
 * text — if that stops being true, `valueMapId` may need to become another
 * `transforms` step kind instead of a separate field.
 */
export function resolveTransformChain(field: Pick<ProfileField, 'transforms' | 'valueMapId'>, profile: Pick<StatblockProfile, 'valueMaps'>): { chain: TransformStep[]; diagnostics: Diagnostic[] } {
  // `field.transforms`' zod-inferred type marks `defaultValue.value` as an optional
  // key (a `z.unknown()` quirk: any schema that ACCEPTS `undefined` is treated as an
  // optional object key by zod's inference, even though the value is always actually
  // present here) — structurally identical to `TransformStep` at runtime, hence the cast.
  const chain: TransformStep[] = [...field.transforms] as TransformStep[];
  const diagnostics: Diagnostic[] = [];

  if (field.valueMapId !== undefined) {
    const valueMap = profile.valueMaps.find((vm) => vm.id === field.valueMapId);
    if (valueMap) {
      chain.push({ kind: 'valueMap', valueMap });
    } else {
      diagnostics.push({ severity: 'warning', code: 'STATBLOCK_VALUE_MAP_NOT_FOUND', params: { valueMapId: field.valueMapId } });
    }
  }

  return { chain, diagnostics };
}
