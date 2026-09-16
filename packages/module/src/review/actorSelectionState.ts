import type { CIFActor, CIFDocument } from '@bindery/core';

/**
 * [KROK-20 Z2] Model zaznaczenia/edycji zakladki aktorow — mirror
 * `ReviewSelection` (obrazy, KROK-11 Z4): CZYSTA prezentacja nad juz-gotowym
 * `CIFActor[]`, zero logiki decyzyjnej o tym CO jest poprawne (A1) — jedynie
 * "co jest zaznaczone" i "jakie nadpisania user wprowadzil przed zapisem".
 *
 * Domyslne zaznaczenie: `nameConfident === true` -> ZAZNACZONE (nazwa juz
 * pewna, gotowa do importu bez interwencji); placeholder -> WIDOCZNY,
 * ODZNACZONY, dopoki uzytkownik nie rozstrzygnie nazwy (S4/A10 — ten sam
 * wzorzec co obrazy o niskiej pewnosci).
 */

/**
 * [KROK-20 Z2] Klucze uzywane do wskaznika kompletnosci — DOKLADNIE te same
 * kanoniczne klucze, ktore `coc7Adapter.fromActor` faktycznie czyta
 * (`CHARACTERISTIC_KEY_MAP` + pola `attribs`). Nie istnieje jeszcze ogolny,
 * system-neutralny rejestr kanonicznych kluczy (MDD §5.4/§7 zapowiada go w
 * strukturze repo, ale nikt go nie zbudowal) — ten ekran, tak jak sam
 * adapter, na razie zna je wprost. To PODSUMOWANIE juz obliczonych danych
 * (ile z oczekiwanych pol faktycznie jest), nie NOWA decyzja klasyfikacyjna.
 */
const COMPLETENESS_STAT_KEYS: readonly string[] = [
  'strength',
  'constitution',
  'size',
  'dexterity',
  'charisma',
  'intelligence',
  'education',
  'willpower',
  'sanity',
  'hitPoints',
  'movement',
  'magicPoints',
  'damageBonus',
  'build',
];

export interface ActorCompleteness {
  hasAttacks: boolean;
  presentStatCount: number;
  expectedStatCount: number;
  missingStatCount: number;
}

/** Pole liczy sie jako "obecne", gdy albo sparsowalo sie numerycznie, albo ma jakikolwiek surowy tekst (np. `db: "+1K4"` — string, nigdy `numeric`, ale WCIAZ prawdziwa wartosc, nie brak). */
function isStatPresent(stat: { raw: string; numeric?: number } | undefined): boolean {
  if (!stat) return false;
  return stat.numeric !== undefined || stat.raw.trim().length > 0;
}

export function computeActorCompleteness(actor: CIFActor): ActorCompleteness {
  let present = 0;
  for (const key of COMPLETENESS_STAT_KEYS) {
    if (isStatPresent(actor.statistics[key])) present++;
  }
  return {
    hasAttacks: actor.attacks.length > 0,
    presentStatCount: present,
    expectedStatCount: COMPLETENESS_STAT_KEYS.length,
    missingStatCount: COMPLETENESS_STAT_KEYS.length - present,
  };
}

export class ActorReviewSelection {
  #selected = new Map<string, boolean>();
  /** Nazwa PO rozstrzygnieciu przez uzytkownika — pusty string = jeszcze nierozstrzygnieta (placeholder bez wyboru). */
  #resolvedName = new Map<string, string>();
  /** `actorId -> (canonicalKey -> nadpisana wartosc surowa)`. */
  #statOverrides = new Map<string, Map<string, string>>();
  /** `actorId -> zbior INDEKSOW atakow usunietych przez uzytkownika (nie mutujemy `CIFActor.attacks` wprost — `undo` przez ponowne kliknieciecie). */
  #removedAttacks = new Map<string, Set<number>>();
  /** [KROK-35 Z1] `actorId -> CIFImage.id` wybranego tokenu — pusty string (domyslnie, brak wpisu) = "brak". WYLACZNIE obrazy z przeznaczeniem `token` (zakladka Obrazy) trafiaja na liste kandydatow — patrz `#buildActorImagePicker` w `ReviewScreen.ts`. */
  #tokenImageId = new Map<string, string>();
  /** [KROK-35 Z2] `actorId -> CIFImage.id` NADPISANIA portretu pod "Ustawieniami zaawansowanymi" — brak wpisu (odroznione od pustego stringa) = portret podaza za tokenem (P1 decyzja produktowa: "Jedno wskazanie ustawia oba"). Pusty string jawnie zapisany = autor SWIADOMIE wybral "brak" portretu mimo ustawionego tokenu. */
  #portraitImageIdOverride = new Map<string, string>();

  static fromDocument(document: CIFDocument): ActorReviewSelection {
    const selection = new ActorReviewSelection();
    for (const actor of document.actors ?? []) {
      selection.#selected.set(actor.id, actor.nameConfident);
      selection.#resolvedName.set(actor.id, actor.nameConfident ? actor.name : '');
    }
    return selection;
  }

  isSelected(id: string): boolean {
    return this.#selected.get(id) ?? false;
  }
  setSelected(id: string, selected: boolean): void {
    if (this.#selected.has(id)) this.#selected.set(id, selected);
  }

  /** Nazwa efektywna: nadpisanie uzytkownika (nawet puste, jesli jawnie wyczyszczone) albo nazwa pewna z CIF-u. */
  resolvedName(actor: CIFActor): string {
    const override = this.#resolvedName.get(actor.id);
    if (override !== undefined) return override;
    return actor.nameConfident ? actor.name : '';
  }
  setResolvedName(actorId: string, name: string): void {
    this.#resolvedName.set(actorId, name.trim());
  }
  isNameResolved(actor: CIFActor): boolean {
    return this.resolvedName(actor).length > 0;
  }

  statOverride(actorId: string, canonicalKey: string): string | undefined {
    return this.#statOverrides.get(actorId)?.get(canonicalKey);
  }
  setStatOverride(actorId: string, canonicalKey: string, value: string): void {
    const map = this.#statOverrides.get(actorId) ?? new Map<string, string>();
    map.set(canonicalKey, value);
    this.#statOverrides.set(actorId, map);
  }
  /** Wartosc surowa DO UZYCIA (nadpisana albo oryginalna z CIF-u) — jedyne miejsce, ktore reszta ekranu/importu powinno czytac. */
  effectiveStatRaw(actor: CIFActor, canonicalKey: string): string {
    return this.statOverride(actor.id, canonicalKey) ?? actor.statistics[canonicalKey]?.raw ?? '';
  }

  isAttackRemoved(actorId: string, attackIndex: number): boolean {
    return this.#removedAttacks.get(actorId)?.has(attackIndex) ?? false;
  }
  toggleAttackRemoved(actorId: string, attackIndex: number): void {
    const set = this.#removedAttacks.get(actorId) ?? new Set<number>();
    if (set.has(attackIndex)) set.delete(attackIndex);
    else set.add(attackIndex);
    this.#removedAttacks.set(actorId, set);
  }
  /** Ataki PO usunieciach uzytkownika — jedyna lista, ktora `#runImport` powinien przekazac adapterowi. */
  effectiveAttacks(actor: CIFActor): CIFActor['attacks'] {
    return actor.attacks.filter((_, i) => !this.isAttackRemoved(actor.id, i));
  }

  /** [KROK-35 Z1] Id obrazu wybranego jako token — pusty string = "brak" (jeszcze nie wybrano, albo jawnie wyczyszczone). */
  tokenImageId(actorId: string): string {
    return this.#tokenImageId.get(actorId) ?? '';
  }
  /** [zgloszenie uzytkownika, auto-podpowiedz tokenu] Odroznia "autor jeszcze nic nie wybral" od "autor jawnie wybral brak" (ten sam wzorzec co `hasCustomPortrait`) — bez tego auto-podpowiedz w `ReviewScreen.ts` nadpisywalaby ZA KAZDYM renderem swiadomy wybor "brak" z powrotem na zgadywana podpowiedz. */
  hasTokenImageSelection(actorId: string): boolean {
    return this.#tokenImageId.has(actorId);
  }
  setTokenImageId(actorId: string, imageId: string): void {
    this.#tokenImageId.set(actorId, imageId);
  }
  /** [KROK-35 Z2] Portret efektywny: nadpisanie "Zaawansowane" jesli autor je jawnie ustawil, inaczej DOKLADNIE ten sam obraz co token (P1: "Jedno wskazanie ustawia oba"). */
  portraitImageId(actorId: string): string {
    return this.#portraitImageIdOverride.get(actorId) ?? this.tokenImageId(actorId);
  }
  /** Czy portret ma WLASNE, od tokenu niezalezne przypisanie ("Zaawansowane" rozwiniete i uzyte) — steruje widocznoscia kontrolki nadpisania w UI. */
  hasCustomPortrait(actorId: string): boolean {
    return this.#portraitImageIdOverride.has(actorId);
  }
  setPortraitImageId(actorId: string, imageId: string): void {
    this.#portraitImageIdOverride.set(actorId, imageId);
  }
  /** Cofniecie nadpisania — portret znowu podaza za tokenem. */
  clearCustomPortrait(actorId: string): void {
    this.#portraitImageIdOverride.delete(actorId);
  }

  get selectedCount(): number {
    let n = 0;
    for (const v of this.#selected.values()) if (v) n++;
    return n;
  }
  selectAll(): void {
    for (const id of this.#selected.keys()) this.#selected.set(id, true);
  }
  selectNone(): void {
    for (const id of this.#selected.keys()) this.#selected.set(id, false);
  }
}

function parseNumericLike(raw: string): number | undefined {
  const trimmed = raw.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * [KROK-20 Z2] `CIFActor` PO nadpisaniach uzytkownika (nazwa/wartosci/usuniete
 * ataki) — jedyna wersja, ktora powinna trafic do `coc7Adapter.fromActor`,
 * czy to do PODGLADU notatek w tym ekranie, czy do FAKTYCZNEGO importu
 * (`#runImport`). Czysta funkcja — zero mutacji oryginalnego `CIFActor`
 * (nowy obiekt), zeby "Cofnij" (ponowne kliknieciecie usunietego ataku) i
 * nawigacja `provenance` (ktora czyta oryginalny `actor.provenance`) nadal
 * dzialaly na nietknietych danych zrodlowych.
 */
export function applyActorOverrides(actor: CIFActor, selection: ActorReviewSelection): CIFActor {
  const name = selection.resolvedName(actor) || actor.name;
  const statistics: CIFActor['statistics'] = {};
  for (const [key, stat] of Object.entries(actor.statistics)) {
    const override = selection.statOverride(actor.id, key);
    statistics[key] = override === undefined ? stat : { ...stat, raw: override, numeric: parseNumericLike(override) };
  }
  return { ...actor, name, statistics, attacks: [...selection.effectiveAttacks(actor)] };
}
