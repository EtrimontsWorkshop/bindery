/**
 * [Step 27 Z1] Shared shape for EVERY piece of text that `packages/core`
 * produces intended for display to a human (layout/image diagnostics,
 * notes and warnings from system adapters). Instead of a ready-made
 * sentence — which would sit in the core with no i18n mechanism at all
 * (A1: the core doesn't know Foundry, so it can't call `game.i18n`) and
 * couldn't be translated without changing code — `code` is a STABLE
 * identifier (without the module namespace, which is appended only by the
 * `packages/module` layer at render time), and `params` carries the raw
 * values to insert into the localization template.
 *
 * Discovered in Step 26 (`AdapterResult.notes: string[]`, about 15
 * sentences in Polish, generated dynamically per-book) and named directly
 * in the Step 27 brief: the same problem already existed in `Diagnostic`
 * (MDD §5.3) as HALF a solution — the `code` field was there, but
 * `message` right next to it duplicated it.
 */
export interface LocalizableMessage {
  /** Message identifier — on its own it is NOT an i18n path; the module layer appends its own namespace (see `packages/module/src/i18n.ts`). */
  code: string;
  /** Values to insert into the localization template (e.g. `{raw}`, `{attackName}`). */
  params?: Record<string, string | number>;
}
