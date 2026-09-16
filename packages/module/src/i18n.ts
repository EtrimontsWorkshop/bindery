import type { LocalizableMessage } from '@bindery/core';

/**
 * [KROK-27 Z1] Jedyne miejsce, ktore doklada namespace `BINDERY.<ns>.` do
 * `LocalizableMessage.code` z `@bindery/core` przed wywolaniem
 * `game.i18n.format`. `code` sam w sobie jest krotkim, plaskim
 * identyfikatorem (np. `UNICODE_LOW_CONFIDENCE`) — rdzen nie wie nic o tym,
 * ze konsumuje go akurat modul Foundry o nazwie "Bindery" (A1: `packages/core`
 * nie odwoluje sie do niczego specyficznego dla Foundry, nawet posrednio przez
 * wlasna nazwe w stringu). Doklejanie namespace'u to WYLACZNIE zadanie tej
 * jednej funkcji w warstwie modulu.
 */
export function localizeMessage(namespace: string, message: LocalizableMessage): string {
  return game.i18n!.format(`BINDERY.${namespace}.${message.code}` as never, (message.params ?? {}) as never);
}
