/**
 * [KROK-27 Z1] Wspolny ksztalt dla KAZDEGO tekstu, ktory `packages/core`
 * produkuje z mysla o pokazaniu czlowiekowi (diagnostyki layoutu/obrazow,
 * notatki i ostrzezenia adapterow systemowych). Zamiast gotowego zdania —
 * ktore siedzialoby w rdzeniu bez zadnego mechanizmu i18n (A1: rdzen nie zna
 * Foundry, wiec nie moze wywolac `game.i18n`) i nie dalo sie przetlumaczyc
 * bez zmiany kodu — `code` jest STABILNYM identyfikatorem (bez namespace'u
 * modulu, ktory dokleja dopiero warstwa `packages/module` przy renderze), a
 * `params` niesie surowe wartosci do wstawienia w szablon lokalizacji.
 *
 * Odkryte w KROK-26 (`AdapterResult.notes: string[]`, ok. 15 zdan po polsku,
 * generowanych dynamicznie per-ksiazka) i nazwane wprost w brifie KROK-27:
 * ten sam problem juz istnial w `Diagnostic` (MDD §5.3) jako POLOWA
 * rozwiazania — pole `code` bylo, `message` obok niego je dublowalo.
 */
export interface LocalizableMessage {
  /** Identyfikator komunikatu — sam w sobie NIE jest sciezka i18n; warstwa modulu dokleja wlasny namespace (patrz `packages/module/src/i18n.ts`). */
  code: string;
  /** Wartosci do wstawienia w szablon lokalizacji (np. `{raw}`, `{attackName}`). */
  params?: Record<string, string | number>;
}
