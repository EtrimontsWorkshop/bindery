import type { Diagnostic } from '@bindery/core';

/**
 * [Task 7] The piece `packages/core`'s `localizableMessage.ts`/`text/types.ts`
 * already documented but never built ("the module layer appends its own
 * namespace... formats `code`+`params` via `game.i18n.format`") — core has
 * no i18n mechanism of its own (A1), so every `Diagnostic` it produces is a
 * bare `code`+`params` waiting for exactly this. Discovered missing during a
 * Task 7 audit: `BINDERY.diagnostic.*` (lang files) had ~20 real message
 * templates that nothing in the codebase ever called.
 *
 * Falls back to the raw `code` when the current lang file has no template
 * for it yet (`game.i18n.has(key, false)` — the `false` means "don't also
 * accept a fallback-language match", so a genuinely missing key is detected
 * even if English happens to have it) — an honest degrade (A7: show
 * SOMETHING useful, never a broken-looking empty string), not a hard
 * requirement that every one of the ~60 `Diagnostic` codes in this codebase
 * has a template before this function can be used at all.
 *
 * Page/field/raw-value context is appended as a UNIFORM suffix, never
 * folded into the localized template itself — `buildActorData.ts` (core)
 * enriches some diagnostics with EXTRA `field`/`raw` params on top of a
 * code's own "bare" params (e.g. `STATBLOCK_CAST_NOT_NUMBER` carries only
 * `{value}` at its origin in `castAndValidate.ts`, but gains `field`/`raw`
 * when re-emitted from `buildActorData.ts`) — a template referencing
 * `{field}` would show a literal, unsubstituted `{field}` for every OTHER
 * call site that doesn't have it. Keeping the suffix separate means one
 * template works correctly everywhere the code can be emitted from.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const key = `BINDERY.diagnostic.${diagnostic.code}`;
  const hasTemplate = game.i18n!.has(key, false);
  const stringParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(diagnostic.params ?? {})) stringParams[k] = String(v);
  const message = hasTemplate ? game.i18n!.format(key, stringParams) : diagnostic.code;

  const context: string[] = [];
  if (diagnostic.pageNumber !== undefined) context.push(`p. ${diagnostic.pageNumber}`);
  const field = diagnostic.params?.['field'];
  if (field !== undefined) context.push(String(field));
  const raw = diagnostic.params?.['raw'];
  if (raw !== undefined && raw !== '') context.push(`"${raw}"`);
  const suffix = context.length > 0 ? ` (${context.join(', ')})` : '';

  return `[${diagnostic.severity}] ${message}${suffix}`;
}
