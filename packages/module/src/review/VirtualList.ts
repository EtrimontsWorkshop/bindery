/**
 * [Step 11 Z2] List virtualization — goal from the brief: 2500 elements
 * without stuttering while scrolling. Renders ONLY the visible rows +
 * margin, outside the `render()`/Handlebars ApplicationV2 cycle (a
 * scroll-frame that rebuilt the ENTIRE DOM via Handlebars on every frame
 * would be catastrophically slow and would lose the scroll position) —
 * plain DOM manipulation in `attach()`, called once from `_onRender`.
 *
 * No dependency on Foundry — plain DOM (`HTMLElement`/`document`), but it
 * lives in `packages/module` (not `packages/core`) because it operates on a
 * real DOM tree, not on data; `packages/core` never touches the DOM (A1).
 */

export interface VirtualListOptions<T> {
  /** Container with a fixed height and `overflow-y: auto` (already in the markup/CSS, see `review-screen.hbs`). */
  container: HTMLElement;
  items: readonly T[];
  /** Fixed row height in px — a requirement of this simplified virtualization (no variable-height rows). */
  rowHeightPx: number;
  /** Builds/updates the DOM of ONE row. `recycled` is an element from the pool to reuse (may be null on the first fill) — the implementation MUST return an element ready to insert (either new or the updated `recycled` one). */
  renderRow: (item: T, index: number, recycled: HTMLElement | null) => HTMLElement;
  /** Number of extra rows rendered OUTSIDE the visible area (top+bottom) — protects against a white flash during fast scrolling. */
  overscan?: number;
  /**
   * [user report, "I select an image from the list, it jumps back to the
   * top"] Restores scroll IMMEDIATELY after building the spacer
   * (`#layout`), SO THE CONTAINER IS ALREADY SCROLLABLE AT THAT POINT —
   * Foundry's `scrollable` (`ReviewScreen.ts`'s `PARTS.main`) does NOT
   * guarantee this for virtualized lists: it restores `scrollTop` BEFORE
   * `_onRender`, when the container from the Handlebars template is still
   * COMPLETELY EMPTY (without `#spacer` giving it a height to scroll) —
   * setting `scrollTop` on an element with no overflow content is clamped
   * to 0 by the browser, so the restore SILENTLY didn't work. The caller
   * (`ReviewScreen.ts`) therefore has to track and pass the position
   * ITSELF, outside Foundry's mechanism.
   */
  initialScrollTop?: number;
  /** Called on EVERY scroll event (throttled via `requestAnimationFrame`, the same one used by `#renderVisible`) — lets the caller track the current position WITHOUT its own access to the container's raw DOM (see `initialScrollTop`). */
  onScroll?: (scrollTop: number) => void;
}

/**
 * Virtualized list controller — a "spacer" with the full height of all
 * items (for a correct scrollbar), inside which sits the window of
 * actually-inserted rows, positioned via `transform: translateY` (cheaper
 * repositioning than `top`, doesn't trigger reflow of everything else).
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
    // [user report, "jumps back to the top"] MUST be AFTER `#layout()`
    // (which gives `#spacer` its height) — setting `scrollTop` on a
    // container with no overflow content is clamped by the browser to 0,
    // see the rationale near `initialScrollTop` in the interface above.
    if (opts.initialScrollTop) this.#container.scrollTop = opts.initialScrollTop;
    this.#renderVisible();
  }

  /** Change the item set (e.g. after a filter/sort change) without rebuilding the whole controller. */
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

    // Remove rows from the pool that fell out of the window.
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

  /** Scroll so that the given index is visible (e.g. after clicking a bbox overlay -> select the corresponding row, see Z3). */
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
