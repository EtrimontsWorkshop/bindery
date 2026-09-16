/**
 * [KROK-23, zamknięcie luki MDD] `Bindery-MDD-v2.2.md` §5.4 opisuje rejestr
 * kluczy kanonicznych z podpowiedziami — nigdy niezaimplementowany w kodzie
 * (zweryfikowane przy budowie edytora profilu: `packages/core/src/canon/`
 * nie istniało, `canonicalKey` w `patterns.ts` był dowolnym stringiem bez
 * żadnej pomocy przy wpisywaniu). Ten plik to DOSŁOWNIE tabela z MDD §5.4,
 * przeniesiona do kodu.
 *
 * [MDD §5.4, zasada] "hints to podpowiedzi dla kreatora profili, nie
 * automatyczne mapowanie". Ten rejestr NIE jest używany do walidacji ani
 * do żadnej decyzji w potoku parsowania (`patterns.ts`/`assembleStatblocks.ts`
 * NIE go importują) — wyłącznie jako źródło podpowiedzi w formularzu edytora
 * profilu (`packages/module`), żeby autor profilu miał listę znanych kluczy
 * pod ręką zamiast wymyślać własne nazewnictwo dla tych samych pojęć w każdym
 * profilu z osobna. Etykieta nierozpoznana nadal jest w pełni poprawna —
 * `canonicalKey` w `LabelledPairsPattern.labels` to zwykły `z.string()`
 * (`schema.ts`), świadomie bez ograniczenia do tego rejestru.
 */

export interface CanonicalStatDefinition {
  /** Podpowiedzi — jak ta cecha bywa nazwana w różnych podręcznikach/językach. WYŁĄCZNIE do wyświetlenia w UI (np. "też bywa: STR, Siła"), nigdy do dopasowania automatycznego. */
  hints: readonly string[];
}

export const CANONICAL_STATS = {
  strength: { hints: ['STR', 'S', 'Siła', 'Stärke', 'Force', 'Fuerza'] },
  dexterity: { hints: ['DEX', 'Ag', 'Zręczność', 'Geschick'] },
  constitution: { hints: ['CON', 'T', 'Wytrzymałość', 'Zähigkeit'] },
  intelligence: { hints: ['INT', 'Int', 'Inteligencja'] },
  willpower: { hints: ['POW', 'WP', 'SW', 'Siła Woli', 'Willenskraft'] },
  charisma: { hints: ['APP', 'Fel', 'Ogłada', 'Charisma'] },
  perception: { hints: ['Per', 'Spostrzegawczość'] },
  size: { hints: ['SIZ', 'Size', 'Rozmiar'] },
  education: { hints: ['EDU', 'Wykształcenie'] },
  luck: { hints: ['Luck', 'Szczęście', 'Fortuna'] },
  sanity: { hints: ['SAN', 'Poczytalność'] },
  hitPoints: { hints: ['HP', 'W', 'Żywotność', 'Punkty Wytrzymałości'] },
  movement: { hints: ['MOV', 'M', 'Ruch', 'Bewegung'] },
  initiative: { hints: ['Init', 'I', 'Inicjatywa'] },
  armour: { hints: ['AP', 'Armour', 'Armor', 'PZ', 'Pancerz'] },
} as const satisfies Record<string, CanonicalStatDefinition>;

export type CanonicalStatKey = keyof typeof CANONICAL_STATS;

/** Lista kluczy w stałej, czytelnej kolejności (kolejność deklaracji obiektu) — do wypełnienia listy podpowiedzi w UI. */
export const CANONICAL_STAT_KEYS: readonly CanonicalStatKey[] = Object.keys(CANONICAL_STATS) as CanonicalStatKey[];
