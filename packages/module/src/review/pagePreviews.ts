/**
 * The rendered previews of the PDF's pages shown in the review screen: a few of the most recent ones, as object URLs.
 * Pure browser code (no Foundry), owned by `ReviewScreen`, which releases it when it closes.
 */
export class PagePreviews {
  readonly #render: (pageNumber: number) => Promise<Uint8Array>;
  readonly #currentPage: () => number;
  readonly #size: number;
  #urls = new Map<number, string>();
  #order: number[] = [];
  /** Pages being rendered now: a page is rendered once however many times it is asked for meanwhile. */
  #jobs = new Map<number, Promise<void>>();
  #disposed = false;

  /**
   * @param render Renders one page to WebP bytes.
   * @param currentPage The page on screen now; its preview is never evicted.
   * @param size How many previews are kept.
   */
  constructor(render: (pageNumber: number) => Promise<Uint8Array>, currentPage: () => number, size = 5) {
    this.#render = render;
    this.#currentPage = currentPage;
    this.#size = size;
  }

  /** The preview's URL, or `null` while the page has not been rendered (or is no longer kept). */
  get(pageNumber: number): string | null {
    return this.#urls.get(pageNumber) ?? null;
  }

  /**
   * Makes sure the page has a preview. Resolves to `true` for the ONE call that rendered it (the caller then redraws),
   * `false` when it was there already, when another call is rendering it, or when rendering failed.
   *
   * Every redraw of the window asks for the current page again; without the shared job each one started another
   * render of the same page and threw the previous one's result away.
   */
  async ensure(pageNumber: number): Promise<boolean> {
    if (this.#urls.has(pageNumber)) return false;
    const running = this.#jobs.get(pageNumber);
    if (running) {
      await running;
      return false;
    }
    let rendered = false;
    const job = (async () => {
      try {
        const bytes = await this.#render(pageNumber);
        if (this.#disposed) return;
        this.#urls.set(pageNumber, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' })));
        this.#order.push(pageNumber);
        // The oldest pages go first, never the one on screen (the user may have turned back to it meanwhile).
        while (this.#order.length > this.#size) {
          const at = this.#order.findIndex((n) => n !== this.#currentPage());
          if (at < 0) break;
          const [evict] = this.#order.splice(at, 1);
          const evictUrl = this.#urls.get(evict!);
          if (evictUrl) URL.revokeObjectURL(evictUrl);
          this.#urls.delete(evict!);
        }
        rendered = true;
      } catch (err) {
        console.warn('Bindery | renderPage failed:', err);
      } finally {
        this.#jobs.delete(pageNumber);
      }
    })();
    this.#jobs.set(pageNumber, job);
    await job;
    return rendered;
  }

  /** Releases every URL; a render that finishes afterwards keeps nothing. */
  dispose(): void {
    this.#disposed = true;
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#urls.clear();
    this.#order = [];
  }
}
