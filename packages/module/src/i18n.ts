import type { LocalizableMessage } from '@bindery/core';

/**
 * [Step 27 Z1] The only place that prepends the `BINDERY.<ns>.` namespace to
 * `LocalizableMessage.code` from `@bindery/core` before calling
 * `game.i18n.format`. `code` itself is a short, flat identifier (e.g.
 * `UNICODE_LOW_CONFIDENCE`) — the core knows nothing about the fact that it
 * happens to be consumed by a Foundry module named "Bindery" (A1:
 * `packages/core` doesn't reference anything Foundry-specific, not even
 * indirectly via its own name in a string). Prepending the namespace is
 * EXCLUSIVELY this one function's job, in the module layer.
 */
export function localizeMessage(namespace: string, message: LocalizableMessage): string {
  return game.i18n!.format(`BINDERY.${namespace}.${message.code}` as never, (message.params ?? {}) as never);
}
