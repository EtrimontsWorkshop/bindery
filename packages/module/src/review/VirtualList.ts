/**
 * [KROK-11 Z2] Wirtualizacja listy — cel z briefu: 2500 elementow bez
 * zacinania przy przewijaniu. Renderuje WYLACZNIE widoczne wiersze + margines,
 * poza cyklem `render()`/Handlebars ApplicationV2 (kazdy scroll-frame
 * odtwarzajacy CALY DOM przez Handlebars bylby katastrofalnie wolny i
 * gubilby pozycje przewijania) — czysta manipulacja DOM w `attach()`,
 * wywolywana raz z `_onRender`.
 *
 * Brak zaleznosci od Foundry — czysty DOM (`HTMLElement`/`document`),
 * ale zyje w `packages/module` (nie `packages/core`) bo operuje na realnym
 * drzewie DOM, nie na danych; `packages/core` nigdy nie dotyka DOM (A1).
 */

export interface VirtualListOptions<T> {
  /** Kontener ze stalej wysokoscia i `overflow-y: auto` (juz w markup/CSS, patrz `review-screen.hbs`). */
  container: HTMLElement;
  items: readonly T[];
  /** Stala wysokosc wiersza w px — wymog uproszczonej wirtualizacji (brak wierszy zmiennej wysokosci). */
  rowHeightPx: number;
  /** Buduje/aktualizuje DOM JEDNEGO wiersza. `recycled` to element z puli do ponownego uzycia (moze byc null przy pierwszym wypelnieniu) — implementacja MUSI zwrocic element gotowy do wstawienia (nowy albo `recycled` po aktualizacji). */
  renderRow: (item: T, index: number, recycled: HTMLElement | null) => HTMLElement;
  /** Liczba dodatkowych wierszy renderowanych POZA widocznym obszarem (gora+dol) — chroni przed bialym mignieciem przy szybkim przewijaniu. */
  overscan?: number;
  /**
   * [zgloszenie uzytkownika, "wybieram obraz z listy, przeskakuje na
   * początek"] Przywraca przewijanie NATYCHMIAST po zbudowaniu spacera
   * (`#layout`), WIEC KONTENER JEST WTEDY JUZ SKROLOWALNY — Foundry'owy
   * `scrollable` (`ReviewScreen.ts`'s `PARTS.main`) tego NIE ZAPEWNIA dla
   * list wirtualizowanych: przywraca `scrollTop` PRZED `_onRender`, gdy
   * kontener z szablonu Handlebars jest jeszcze CALKIEM PUSTY (bez `#spacer`
   * nadajacego mu wysokosc do przewiniecia) — ustawienie `scrollTop` na
   * elemencie bez zadnego nadmiaru tresci jest przegladarkowo przycinane do
   * 0, wiec przywrocenie CICHO nie dzialalo. Wywolujacy (`ReviewScreen.ts`)
   * musi wiec sledzic i przekazywac pozycje SAM, poza mechanizmem Foundry.
   */
  initialScrollTop?: number;
  /** Wywolywane przy KAZDYM zdarzeniu scroll (throttled przez `requestAnimationFrame`, ten sam co `#renderVisible`) — pozwala wywolujacemu sledzic biezaca pozycje BEZ wlasnego dostepu do surowego DOM-u kontenera (patrz `initialScrollTop`). */
  onScroll?: (scrollTop: number) => void;
}

/**
 * Kontroler wirtualizowanej listy — "spacer" o pelnej wysokosci wszystkich
 * elementow (poprawny pasek przewijania), wewnatrz niego okno faktycznie
 * wstawionych wierszy, pozycjonowane `transform: translateY` (tansza
 * repozycja niz `top`, nie wywoluje reflow calej reszty).
 */
export class VirtualList<T> {
  #container: HTMLElement;
  #items: readonly T[];
  #rowHeightPx: number;
  #renderRow: VirtualListOptions<T>['renderRow'];
  #overscan: number;
  #spacer: HTMLElement;
  #viewport: HTMLElement;
  #pool = new Map<number, HTMLElement>();
  #onScrollListener: () => void;
  #onScrollCallback: VirtualListOptions<T>['onScroll'];
  #rafHandle: number | null = null;

  constructor(opts: VirtualListOptions<T>) {
    this.#container = opts.container;
    this.#items = opts.items;
    this.#rowHeightPx = opts.rowHeightPx;
    this.#renderRow = opts.renderRow;
    this.#overscan = opts.overscan ?? 6;
    this.#onScrollCallback = opts.onScroll;

    this.#container.innerHTML = '';
    this.#container.style.position = 'relative';
    this.#container.style.overflowY = 'auto';

    this.#spacer = document.createElement('div');
    this.#spacer.style.position = 'relative';
    this.#spacer.style.width = '100%';
    this.#container.appendChild(this.#spacer);

    this.#viewport = document.createElement('div');
    this.#viewport.style.position = 'absolute';
    this.#viewport.style.top = '0';
    this.#viewport.style.left = '0';
    this.#viewport.style.right = '0';
    this.#spacer.appendChild(this.#viewport);

    this.#onScrollListener = () => {
      this.#onScrollCallback?.(this.#container.scrollTop);
      if (this.#rafHandle !== null) return;
      this.#rafHandle = requestAnimationFrame(() => {
        this.#rafHandle = null;
        this.#renderVisible();
      });
    };
    this.#container.addEventListener('scroll', this.#onScrollListener);

    this.#layout();
    // [zgloszenie uzytkownika, "przeskakuje na początek"] MUSI byc PO
    // `#layout()` (nadaje `#spacer`-owi wysokosc) — ustawienie `scrollTop` na
    // kontenerze bez zadnego nadmiaru tresci jest przegladarkowo przycinane
    // do 0, patrz uzasadnienie przy `initialScrollTop` w interfejsie wyzej.
    if (opts.initialScrollTop) this.#container.scrollTop = opts.initialScrollTop;
    this.#renderVisible();
  }

  /** Zmien zbior elementow (np. po zmianie filtra/sortowania) bez odtwarzania calego kontrolera. */
  setItems(items: readonly T[]): void {
    this.#items = items;
    for (const el of this.#pool.values()) el.remove();
    this.#pool.clear();
    this.#layout();
    this.#renderVisible();
  }

  #layout(): void {
    this.#spacer.style.height = `${this.#items.length * this.#rowHeightPx}px`;
  }

  #renderVisible(): void {
    const scrollTop = this.#container.scrollTop;
    const viewportHeight = this.#container.clientHeight;
    const firstVisible = Math.max(0, Math.floor(scrollTop / this.#rowHeightPx) - this.#overscan);
    const lastVisible = Math.min(
      this.#items.length - 1,
      Math.ceil((scrollTop + viewportHeight) / this.#rowHeightPx) + this.#overscan,
    );

    // Usun z puli wiersze, ktore wypadly z okna.
    for (const [index, el] of this.#pool) {
      if (index < firstVisible || index > lastVisible) {
        el.remove();
        this.#pool.delete(index);
      }
    }

    for (let index = firstVisible; index <= lastVisible; index++) {
      if (this.#pool.has(index)) continue;
      const item = this.#items[index];
      if (item === undefined) continue;
      const el = this.#renderRow(item, index, null);
      el.style.position = 'absolute';
      el.style.top = '0';
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = `${this.#rowHeightPx}px`;
      el.style.transform = `translateY(${index * this.#rowHeightPx}px)`;
      this.#viewport.appendChild(el);
      this.#pool.set(index, el);
    }
  }

  /** Przewin tak, zeby dany indeks byl widoczny (np. po kliknieciu nakladki bbox -> zaznacz odpowiadajacy wiersz, patrz Z3). */
  scrollToIndex(index: number): void {
    const target = index * this.#rowHeightPx;
    const viewportHeight = this.#container.clientHeight;
    const current = this.#container.scrollTop;
    if (target < current || target > current + viewportHeight - this.#rowHeightPx) {
      this.#container.scrollTop = Math.max(0, target - viewportHeight / 2);
    }
  }

  destroy(): void {
    if (this.#rafHandle !== null) cancelAnimationFrame(this.#rafHandle);
    this.#container.removeEventListener('scroll', this.#onScrollListener);
    this.#pool.clear();
    this.#container.innerHTML = '';
  }
}
