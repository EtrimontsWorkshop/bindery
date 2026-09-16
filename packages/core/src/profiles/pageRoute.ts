import type { ProfileToken } from './types.js';

/**
 * [KROK-18 Z1, przemianowane w KROK-39] Klasyfikator strony na trase importu.
 * Odkrycie z Z0 (nieprzewidziane w `Bindery-MDD-v2.1.md` Faza 4): 12 z 27
 * "siatek" wykrytych w kroku 12/13 to pelne karty postaci gracza (10+
 * umiejetnosci, historia, ekwipunek, punkty do rozdysponowania w chargenie),
 * nie statbloki NPC/potworow. Silnik wzorcow lapie je TEZ, bo strukturalnie
 * maja identyczna siatke S/WYG/KON/... — ten klasyfikator dziala PRZED
 * dalszym parsowaniem, zeby zdecydowac, KTORYM zestawem wzorcow strone
 * przetworzyc.
 *
 * [KROK-39 Z1, zmiana kierunku wobec kroku 38] Krok 38 zaproponowal
 * przelacznik per profil ("ten profil obejmuje tez gotowych Badaczy, pomin
 * filtr"). Krok 39 robi inaczej: ten sam sygnal ("karta gracza kontra karta
 * potwora") ROUTUJE, zamiast byc wylaczany — strona trafiajaca slowa kluczowe
 * nie jest juz "pomijana", tylko kierowana do INNEGO, oddzielnego zestawu
 * wzorcow (`ProfileV2.playerCharacter`, `schema.ts`). Dawne `isPregenPage`/
 * `countPregenKeywordHits` przestaly pasowac nazwa — zawsze znaczyly "strona z
 * karta postaci gracza", tylko uzycie bylo jednostronne (zawsze "pomin"). Bez
 * wstecznej zgodnosci — funkcje wewnetrzne, nieeksportowane w publicznym API.
 *
 * [Zmierzone na `Zew_Cthulhu_Nie_czas_na_krzyk_v1_0.pdf`, `spike/statblocks2/`,
 * 27/27 siatek sklasyfikowanych poprawnie przeciwko znanej klasyfikacji z Z0]
 * Kandydat "dlugosc listy umiejetnosci" (pregeny 14-19 wystapien `NN%`, NPC/
 * potwory 9-27) ODRZUCONY — zakresy sie nakladaja, zaden prog nie rozdziela
 * czysto. Kandydat "slowa kluczowe chargenu gdziekolwiek na stronie" —
 * IDEALNY rozdzial: wszystkie 12 stron pregenow trafiaja >=3 z 5 slow
 * kluczowych, wszystkie 15 celow NPC/potwor (strony 30/31/55/56/57/84)
 * trafiaja 0. Prog `>=1` zostawia duzy margines bezpieczenstwa (0 vs 3-5) na
 * inne ksiazki, gdzie moze wystapic tylko jedno z tych slow.
 *
 * [KROK-38, potwierdzone na `ZewCthulhu-WRAK.pdf`, str. 23-30] Ten sam prog
 * dziala rowniez na drugiej, niezaleznej ksiazce: 6/6 stron gotowych Badaczy
 * (25-30) trafionych, 0 falszywych trafien na stronach NPC/potworow (23-24).
 *
 * Niezweryfikowane na angielskim `CHA23131 Call of Cthulhu 7th Edition
 * Quick-Start Rules.pdf` (inny jezyk, inne slowa kluczowe) — patrz Z7 briefu
 * KROK-18 ("pomiar na calej ksiazce"), zanim ten klasyfikator zostanie uznany
 * za przenosny miedzy jezykami.
 */
export const DEFAULT_PLAYER_CHARACTER_KEYWORDS: readonly string[] = ['Rozdysponuj', 'Historia Badacza', 'Przymioty', 'Ideologia', 'Znaczące miejsca'];

export const PLAYER_CHARACTER_KEYWORD_HIT_THRESHOLD = 1;

/** Trasa importu strony — ktorym zestawem wzorcow profilu (`ProfileV2`) ma byc przetworzona. */
export type PageRoute = 'npc' | 'playerCharacter';

export interface PageRouteOptions {
  keywords?: readonly string[];
  /** Ile z `keywords` musi wystapic na stronie, zeby uznac ja za trase `playerCharacter`. */
  hitThreshold?: number;
}

/** Ile skonfigurowanych slow kluczowych gotowego Badacza wystepuje wsrod tekstow tokenow tej strony. */
export function countPlayerCharacterKeywordHits(pageTokens: readonly ProfileToken[], opts: PageRouteOptions = {}): number {
  const keywords = opts.keywords ?? DEFAULT_PLAYER_CHARACTER_KEYWORDS;
  const joined = pageTokens.map((t) => t.text).join(' ');
  return keywords.filter((k) => joined.includes(k)).length;
}

/** Klasyfikuje strone na trase importu — `'playerCharacter'`, gdy trafia slowa kluczowe gotowego Badacza, w przeciwnym razie `'npc'` (zachowanie sprzed kroku 39: kazda strona bez tych slow jest statblokiem NPC/potwora). */
export function classifyPageRoute(pageTokens: readonly ProfileToken[], opts: PageRouteOptions = {}): PageRoute {
  const threshold = opts.hitThreshold ?? PLAYER_CHARACTER_KEYWORD_HIT_THRESHOLD;
  return countPlayerCharacterKeywordHits(pageTokens, opts) >= threshold ? 'playerCharacter' : 'npc';
}
