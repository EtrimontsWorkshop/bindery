import type { CIFDocument, CIFImage } from '@bindery/core';

/**
 * [KROK-11 Z4] Model zaznaczenia ekranu przegladu. CZYSTA prezentacja nad
 * juz-zdecydowanym wynikiem `core` (`CIFDocument.images[].classification`/
 * `.confidence`) — ten plik NIE klasyfikuje niczego na nowo, tylko projektuje
 * juz gotowe pola na "czy checkbox startuje zaznaczony" (check:boundary,
 * DoD: "ekran przegladu nie zawiera logiki decyzyjnej").
 *
 * [zgloszenie uzytkownika, "ustaw aby wszystkie obrazy byly domyslnie
 * odznaczone"] Domyslne zaznaczenie: WSZYSTKIE obrazy (`content` i
 * `undecided` jednakowo) startuja ODZNACZONE — uzytkownik zaznacza jawnie to,
 * co faktycznie chce zaimportowac (poprzedni brief KROK-11 Z4 automatycznie
 * zaznaczal pewne `content`; porzucone na wprost zgloszony wniosek uzytkownika).
 * Domyslny porzadek: `content` w kolejnosci stron, potem `undecided`
 * malejaco po powierzchni (`width*height`) — realne ilustracje sa duze,
 * smieci male; uzytkownik przeglada pierwsze ~20 pozycji, nie ~180.
 */

/**
 * [KROK-14 Z4] Przeznaczenie POJEDYNCZEGO obrazu, wybierane przez uzytkownika
 * w ekranie przegladu (MDD v2.1 §1.2, P1: "przeznaczenie wybierane per obraz").
 * `scene` — tworzy Scene z tlem; `journal` — trafia do JEDNOSTRONICOWEGO
 * JournalEntry jako handout; `token` — zapisany na dysk (katalog obrazow),
 * bez tworzenia jakiegokolwiek dokumentu; `unassigned` — pomijany przy
 * imporcie, dopoki uzytkownik nie wybierze cos innego (patrz
 * `defaultImageDestination` nizej — byl to dawne `skip`, zastapione na
 * wprost zgloszony wniosek uzytkownika, patrz ponizej).
 */
export type ImageDestination = 'scene' | 'journal' | 'token' | 'unassigned';

/**
 * [zgloszenie uzytkownika, "znalezione obrazy nie beda automatycznie
 * przydzielane do scen/journali/tokenow — niech wszystkie trafiaja do
 * Nieprzydzielone, uzytkownik przydziela recznie"] Dawniej zgadywano
 * przeznaczenie z `CIFImage.targetKind` (scene->scene, portrait->token,
 * handout/unknown->journal) — ZAWSZE `unassigned` teraz, niezaleznie od
 * `targetKind`: automatyczne zgadywanie zbyt czesto bylo niepoprawne (np.
 * portret bez podpisu trafiajacy od razu jako token), a uzytkownik i tak
 * musial przegladac kazdy obraz recznie, wiec "domyslne zgadniecie" tylko
 * dodawalo szum do poprawienia zamiast oszczedzac prace.
 */
export function defaultImageDestination(): ImageDestination {
  return 'unassigned';
}

function imageArea(image: CIFImage): number {
  return image.width * image.height;
}

/**
 * Porzadek domyslny listy obrazow: `content` (w tym `content` o niskiej
 * pewnosci, patrz wyzej) w kolejnosci stron rosnaco, POTEM `undecided`
 * malejaco po powierzchni.
 */
export function sortImagesForReview(images: readonly CIFImage[]): CIFImage[] {
  const content = images.filter((i) => i.classification === 'content').sort((a, b) => a.provenance.pageNumber - b.provenance.pageNumber);
  const undecided = images.filter((i) => i.classification === 'undecided').sort((a, b) => imageArea(b) - imageArea(a));
  return [...content, ...undecided];
}

export interface ReviewSelectionSnapshot {
  imageIds: readonly string[];
  sceneIds: readonly string[];
  journalIds: readonly string[];
  journalPageIds: readonly string[];
  /** [KROK-14 Z4] Przeznaczenie KAZDEGO obrazu (nie tylko zaznaczonych) — `id -> destination`. */
  imageDestinations: ReadonlyMap<string, ImageDestination>;
}

/**
 * Stan zaznaczenia calego ekranu przegladu — obrazy, sceny, journale, strony
 * journali. Kazda domena to Map<id, boolean> (nie Set zaznaczonych) —
 * jawne `false` dla odznaczonych pozwala odroznic "odznaczone celowo" od
 * "jeszcze nieznane id" (np. z late-loaded strony), co upraszcza `has`/`get`
 * wywolania w UI (zawsze zdefiniowane po `initialize`).
 */
export class ReviewSelection {
  #images = new Map<string, boolean>();
  #scenes = new Map<string, boolean>();
  #journals = new Map<string, boolean>();
  #journalPages = new Map<string, boolean>();
  /** [KROK-14 Z4] Przeznaczenie per obraz — osobna mapa od zaznaczenia, bo niezaznaczony obraz TEZ ma (nieuzywane, ale zapamietane) przeznaczenie. */
  #imageDestinations = new Map<string, ImageDestination>();
  /**
   * [KROK-19, zgloszony na zywo brak "brakuje mi lepszej segregacji
   * journali"] Nazwa grupy journala per obraz, WYLACZNIE dla przeznaczenia
   * `journal` — pusty string (domyslnie) = dotychczasowe zachowanie, kazdy
   * obraz dostaje WLASNY, pojedynczy JournalEntry. Obrazy dzielace TAKA SAMA
   * niepusta nazwe grupy trafiaja razem do JEDNEGO JournalEntry (wiele stron)
   * — uzytkownik decyduje o segregacji (np. rozdzialami ksiazki), `#runImport`
   * w ReviewScreen wylacznie grupuje wedlug tej juz-podjetej decyzji.
   */
  #imageJournalGroups = new Map<string, string>();

  static fromDocument(document: CIFDocument): ReviewSelection {
    const selection = new ReviewSelection();
    for (const image of document.images) {
      // [zgloszenie uzytkownika, "ustaw aby wszystkie obrazy byly domyslnie
      // odznaczone"] Zawsze `false` — patrz doc-comment na gorze pliku.
      selection.#images.set(image.id, false);
      selection.#imageDestinations.set(image.id, defaultImageDestination());
      selection.#imageJournalGroups.set(image.id, '');
    }
    // [KROK-11] Sceny to juz zdecydowana, pewna klasyfikacja core'a (CIFScene
    // istnieje TYLKO gdy core juz uznal obraz za mape/scene) — brak wlasnego
    // pola confidence do progowania, wiec domyslnie ZAZNACZONE (mirror Z4
    // "content" bez sprzecznych sygnalow).
    for (const scene of document.scenes) selection.#scenes.set(scene.id, true);
    // [KROK-16 Z2, naprawa zgloszonego bledu] Ekstrakcja tekstu calej ksiazki do
    // journali jest od pivotu produktowego (KROK-11, Bindery-MDD-v2.1.md §0c)
    // funkcja DRUGORZEDNA/opcjonalna wobec obrazow — domyslne "wszystko
    // zaznaczone" tworzylo przy KAZDYM imporcie "mase journali z tekstem" bez
    // pytania, nawet gdy uzytkownik chcial WYLACZNIE pojedyncze obrazy z
    // zakladki Obrazy. Domyslnie ODZNACZONE — jawny opt-in w zakladce Journale.
    for (const journal of document.journals) {
      selection.#journals.set(journal.id, false);
      for (const page of journal.pages) selection.#journalPages.set(page.id, false);
    }
    return selection;
  }

  isImageSelected(id: string): boolean {
    return this.#images.get(id) ?? false;
  }
  isSceneSelected(id: string): boolean {
    return this.#scenes.get(id) ?? false;
  }
  isJournalSelected(id: string): boolean {
    return this.#journals.get(id) ?? false;
  }
  isJournalPageSelected(id: string): boolean {
    return this.#journalPages.get(id) ?? false;
  }

  setImage(id: string, selected: boolean): void {
    if (this.#images.has(id)) this.#images.set(id, selected);
  }

  /**
   * [KROK-18, "Zaznacz i wytnij"] Rejestruje obraz dodany PO `fromDocument()`
   * (reczne przyciecie z podgladu strony, nie z automatycznej ekstrakcji) —
   * `setImage`/`setImageDestination` powyzej celowo NIC nie robia dla
   * nieznanego `id` (patrz ich `if (this.#X.has(id))` — chroni przed literowkami
   * gdzie indziej), wiec reczny obraz potrzebuje wlasnego, jawnego wpisu.
   *
   * [zgloszenie uzytkownika, "wszystkie obrazy trafiaja do Nieprzydzielone,
   * uzytkownik przydziela recznie"] Zaznaczenie startowe = `destination !==
   * 'unassigned'` — TA SAMA regula, ktorej pilnuje zmiana dropdownu w
   * `ReviewScreen.ts` (`shouldBeSelected`), zeby checkbox i przeznaczenie NIE
   * rozjezdzaly sie w dwa niezalezne, ciche zrodla prawdy od SAMEGO poczatku,
   * nie dopiero po pierwszej recznej zmianie. `destination` tutaj to dzis
   * ZAWSZE `defaultImageDestination()` = `'unassigned'`, wiec w praktyce
   * reczny wykroj startuje ODZNACZONY, tak samo jak automatycznie wykryty —
   * dawniej (przed tym zgloszeniem) startowal zaznaczony, bo przeznaczenie
   * bylo od razu zgadywane z `targetKind`.
   */
  addManualImage(id: string, destination: ImageDestination): void {
    this.#images.set(id, destination !== 'unassigned');
    this.#imageDestinations.set(id, destination);
    this.#imageJournalGroups.set(id, '');
  }

  /** [KROK-14 Z4] Przeznaczenie obrazu — domyslnie z `defaultImageDestination`, nadpisywalne per obraz. */
  imageDestination(id: string): ImageDestination {
    return this.#imageDestinations.get(id) ?? 'unassigned';
  }
  setImageDestination(id: string, destination: ImageDestination): void {
    if (this.#imageDestinations.has(id)) this.#imageDestinations.set(id, destination);
  }
  /** [KROK-14 Z4] Operacja zbiorcza "ustaw wszystkim ZAZNACZONYM obrazom" — patrz brief Z4. */
  setDestinationForSelected(destination: ImageDestination): void {
    for (const [id, selected] of this.#images) {
      if (selected) this.#imageDestinations.set(id, destination);
    }
  }

  /** [KROK-19] Nazwa grupy journala dla obrazu — pusty string = brak grupy (wlasny JournalEntry). */
  imageJournalGroup(id: string): string {
    return this.#imageJournalGroups.get(id) ?? '';
  }
  setImageJournalGroup(id: string, group: string): void {
    if (this.#imageJournalGroups.has(id)) this.#imageJournalGroups.set(id, group.trim());
  }
  /** [KROK-19] Operacja zbiorcza "ustaw grupe journala wszystkim ZAZNACZONYM obrazom" — mirror `setDestinationForSelected`. */
  setJournalGroupForSelected(group: string): void {
    const trimmed = group.trim();
    for (const [id, selected] of this.#images) {
      if (selected) this.#imageJournalGroups.set(id, trimmed);
    }
  }
  setScene(id: string, selected: boolean): void {
    if (this.#scenes.has(id)) this.#scenes.set(id, selected);
  }
  setJournal(id: string, selected: boolean): void {
    if (this.#journals.has(id)) this.#journals.set(id, selected);
  }
  setJournalPage(id: string, selected: boolean): void {
    if (this.#journalPages.has(id)) this.#journalPages.set(id, selected);
  }

  /** Liczba obecnie zaznaczonych obrazow — do licznika "Zaznaczono N" w naglowku ekranu. */
  get selectedImageCount(): number {
    let n = 0;
    for (const v of this.#images.values()) if (v) n++;
    return n;
  }
  get selectedSceneCount(): number {
    let n = 0;
    for (const v of this.#scenes.values()) if (v) n++;
    return n;
  }
  get selectedJournalCount(): number {
    let n = 0;
    for (const v of this.#journals.values()) if (v) n++;
    return n;
  }

  selectAllImages(): void {
    for (const id of this.#images.keys()) this.#images.set(id, true);
  }
  selectNoImages(): void {
    for (const id of this.#images.keys()) this.#images.set(id, false);
  }
  /** Zaznacz WYLACZNIE obrazy `content` (odznacz reszte) — operacja zbiorcza z brief Z4. */
  selectOnlyContentImages(document: CIFDocument): void {
    for (const image of document.images) this.#images.set(image.id, image.classification === 'content');
  }

  setAllJournals(selected: boolean): void {
    for (const id of this.#journals.keys()) this.#journals.set(id, selected);
    for (const id of this.#journalPages.keys()) this.#journalPages.set(id, selected);
  }

  toSnapshot(): ReviewSelectionSnapshot {
    return {
      imageIds: [...this.#images.entries()].filter(([, v]) => v).map(([id]) => id),
      sceneIds: [...this.#scenes.entries()].filter(([, v]) => v).map(([id]) => id),
      journalIds: [...this.#journals.entries()].filter(([, v]) => v).map(([id]) => id),
      journalPageIds: [...this.#journalPages.entries()].filter(([, v]) => v).map(([id]) => id),
      imageDestinations: new Map(this.#imageDestinations),
    };
  }
}
