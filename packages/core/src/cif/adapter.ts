import type { CIFActor, CIFJournal, CIFScene } from './types.js';
import type { LocalizableMessage } from '../localizableMessage.js';

/**
 * [KROK-19 Z1] Kontrakt adaptera systemowego — dokladnie z §5.6 MDD. Zyje w
 * `packages/core` (nie `packages/module`) bo to WYLACZNIE typy-kontrakt,
 * generyczne wzgledem systemu docelowego — implementacje konkretnych
 * adapterow (np. CoC7) sa Foundry/system-specyficzne i zyja w
 * `packages/module/src/adapters/` (MDD §7, struktura repozytorium).
 *
 * **Kontrakt adaptera (MDD §5.6):**
 * 1. Nigdy nie rzuca wyjatku — bledy przez `issues`.
 * 2. Nigdy nie gubi danych — nierozpoznane pola do `notes`, ktore laduja w opisie aktora.
 * 3. Nigdy nie przelicza wartosci miedzy liniami wydawniczymi (§6.6).
 * 4. Jest CZYSTA funkcja — brak efektow ubocznych, brak tworzenia dokumentow.
 *    Dokumenty tworzy warstwa modulu (`packages/module/documents/`), NIE adapter.
 */

export type ContentKind = 'actors' | 'items' | 'journals' | 'scenes' | 'images';

/** [KROK-27 Z1] `message: string` usuniete — patrz `LocalizableMessage`. */
export interface AdapterIssue extends LocalizableMessage {
  severity: 'info' | 'warning' | 'error';
}

export interface AdapterResult<T> {
  data: T;
  /** Co adapter zrobil z polami, ktorych nie umial zmapowac. */
  notes: LocalizableMessage[];
  issues: AdapterIssue[];
}

export interface ImportContext {
  folderId: string | null;
  imagePathResolver: (imageRef: string) => string | null;
  language: string | null;
  profileId: string | null;
  /**
   * [KROK-35 Z2] Id obrazu (`CIFImage.id`) wybranego przez uzytkownika w
   * ekranie przegladu jako token/portret TEGO KONKRETNEGO aktora — WYLACZNIE
   * ten id, nie sciezka (rozwiazywana dopiero przez `imagePathResolver`,
   * WPROST w adapterze, zeby `fromActor` zostal czysta funkcja — patrz
   * naglowek pliku). `null`/nieustawione = autor wybral "brak" albo nie
   * skonfigurowal jeszcze przypisania. Decyzja produktowa kroku 35: zero
   * automatycznego dopasowania (`images.associateWithEntity`, §5.5,
   * pozostaje NIEUZYTE) — WYLACZNIE jawny wybor z listy w ekranie przegladu.
   */
  tokenImageRef?: string | null;
  /** [KROK-35 Z2] Jak `tokenImageRef`, ale dla portretu — "Jedno wskazanie ustawia oba" (P1 decyzja produktowa): ekran przegladu domyslnie kopiuje tu TA SAMA wartosc co `tokenImageRef`, chyba ze autor jawnie rozdzielil je pod "Ustawieniami zaawansowanymi". */
  portraitImageRef?: string | null;
}

export interface SystemAdapter {
  readonly id: string;
  readonly systemId: string;
  /** Zakres semver, np. ">=7.0.0 <9". */
  readonly systemVersion: string;
  /** gameLine akceptowane przez ten adapter; `'*'` = uniwersalny fallback. */
  readonly accepts: readonly string[];
  readonly produces: readonly ContentKind[];
  readonly label: string;

  /** Nieobowiazkowa, plytka walidacja przed pelnym mapowaniem. */
  validate?(cif: CIFActor): AdapterIssue[];

  fromActor(cif: CIFActor, ctx: ImportContext): AdapterResult<object>;
  fromScene?(cif: CIFScene, ctx: ImportContext): AdapterResult<object>;
  fromJournal?(cif: CIFJournal, ctx: ImportContext): AdapterResult<object>;
}
