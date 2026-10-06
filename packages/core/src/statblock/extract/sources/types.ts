/**
 * The three ways a field's raw value can be located within one
 * `ExtractionBlock` — `label`, `region`, `styleFilter`. See
 * `labelSource.ts`/`regionSource.ts`/`styleFilterSource.ts` for what each
 * one actually does.
 *
 * These types moved to `../../profile/schema.js` (they're now
 * validated profile DATA — a `ProfileField.source` carries one — not just
 * a plain TS interface that only tests built by hand). Re-exported here
 * so existing `extract/` imports keep working unchanged.
 */
export type { FieldSource, LabelSource, NormalizedRect, RegionSource, StyleFilter, StyleFilterSource } from '../../profile/schema.js';
