import { ASSET_BASE_URL } from '../settings.js';
import { loadCore } from '../loadCore.js';
import { buildJournalsForReview, openPreviewForReview, type CIFBuildResult } from '../api.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

interface WizardState {
  status: 'idle' | 'analyzing' | 'done' | 'error';
  fileName: string | null;
  errorMessage: string | null;
  summary: import('@bindery/core').DocumentSummary | null;
  isBuildingReview: boolean;
  /** A review screen opened from this wizard is still open. */
  isReviewOpen: boolean;
  reviewProgress: { done: number; total: number } | null;
  reviewBuildError: string | null;
  lastImportSummary: string | null;
}

/**
 * pdf.js is NOT imported at the module level — only inside
 * #onAnalyze, when the user actually opens the window and clicks analyze.
 * Verified: a world that never opens this window should not download
 * pdf.mjs or @bindery/core (which re-exports types, but the inspectDocument
 * code inside it also dynamically imports pdfjs-dist — @bindery/core itself
 * is small).
 *
 * `ReviewScreen` is DYNAMICALLY imported only in `#onOpenReview`
 * (for the same reason — not loading the <40KB world-startup budget with the
 * whole review screen's code, virtualization etc., which are needed ONLY
 * after the button is actually clicked). This file no longer creates any
 * Foundry documents by itself — it ONLY builds a `CIFDocument` and hands
 * control to `ReviewScreen`, which is the ONLY place that creates
 * Scene/JournalEntry documents (a human always reviews before saving).
 */
export class ImportWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-wizard',
    classes: ['bindery', 'bindery-wizard'],
    window: {
      title: 'BINDERY.wizard.title',
      resizable: true,
      icon: 'fa-solid fa-file-import',
    },
    position: {
      // [redesign 2a] 480 -> 560: the drop zone + profile card need more
      // breathing room than the old, cramped tabular layout.
      width: 560,
      // `height: 'auto'` doesn't allow scrolling when
      // the content (the extracted-images grid) grows beyond the visible
      // area — the window simply clips the rest with no scrollbar. A fixed
      // height + CSS `overflow-y` on `.window-content` (Foundry's default)
      // gives scrolling; `resizable: true` (already set) lets the user
      // enlarge the window.
      height: 600,
    },
    actions: {
      analyze: ImportWizard.#onAnalyze,
      openReview: ImportWizard.#onOpenReview,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery-pdf-importer/templates/wizard.hbs',
      // [user report, "scrolling down jumps back to the top"] The review
      // build progress (`onProgress` below) calls `this.render()` ONCE PER
      // PAGE — ApplicationV2 (`HandlebarsApplicationMixin`) replaces the
      // ENTIRE root of this part (`.bindery-wizard-root`) with a new
      // element on EVERY render (`_replaceHTML`, `element.replaceWith(...)`,
      // because this part doesn't have `root: true`), so the scrollable
      // content INSIDE it (`.bindery-wizard-body`, `overflow-y: auto` in
      // `bindery.css`) gets a FRESH element with `scrollTop` reset by
      // definition — the user scrolls down to see the page counter, and the
      // next progress tick immediately reverts it. `scrollable` is Foundry's
      // own documented mechanism (`handlebars-application.mjs`,
      // `_preSyncPartState`/`_syncPartState`) for exactly this case: it
      // remembers the `scrollTop`/`scrollLeft` of the given selector BEFORE
      // the swap and restores it AFTER — no custom mechanism is needed.
      scrollable: ['.bindery-wizard-body'],
    },
  };

  #state: WizardState = {
    status: 'idle',
    fileName: null,
    errorMessage: null,
    summary: null,
    isBuildingReview: false,
    isReviewOpen: false,
    reviewProgress: null,
    reviewBuildError: null,
    lastImportSummary: null,
  };

  #selectedFile: File | null = null;
  #fileBuffer: ArrayBuffer | null = null;
  #buildController: AbortController | null = null;
  /**
   * [bug fix — full design review] `#buildController` is nulled right AFTER
   * the CIF build phase (`finally` in `#onOpenReview`), EARLIER than
   * `openPreviewForReview`/`ReviewScreen.open()` (these two steps don't have
   * their own `AbortSignal` — `openPreviewDocument` in core doesn't accept
   * one). Closing the window during THIS time window made `close()`'s
   * `abort()` a silent no-op, and `ReviewScreen` would open anyway, despite
   * the user's explicit close. This flag is checked AFTER both of these
   * steps, independent of `#buildController`.
   */
  #closed = false;

  override async _prepareContext(): Promise<Record<string, unknown>> {
    return {
      status: this.#state.status,
      fileName: this.#state.fileName,
      errorMessage: this.#state.errorMessage,
      summary: this.#state.summary,
      isAnalyzing: this.#state.status === 'analyzing',
      hasResult: this.#state.status === 'done' && this.#state.summary !== null,
      hasError: this.#state.status === 'error',
      isBuildingReview: this.#state.isBuildingReview,
      isReviewOpen: this.#state.isReviewOpen,
      isBusy: this.#isBusy(),
      reviewProgress: this.#state.reviewProgress,
      // The build reports whole percent of all its stages together (`stagedProgress` in core).
      reviewProgressPercent: this.#state.reviewProgress && this.#state.reviewProgress.total > 0 ? Math.floor((this.#state.reviewProgress.done / this.#state.reviewProgress.total) * 100) : 0,
      reviewBuildError: this.#state.reviewBuildError,
      lastImportSummary: this.#state.lastImportSummary,
    };
  }

  // The base class's generic types are parameterized by the instance; in a
  // subclass with no generic parameters of its own, it's simpler and just
  // as safe in practice to pass through unchanged to super.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const input = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="pdf"]');
    input?.addEventListener('change', () => {
      this.#onPdfFileSelected(input.files?.[0] ?? null);
    });

    // [redesign 2a, "implement drop handling, or don't visually promise it"]
    // The drop zone calls the SAME path as the file input's change event
    // (`#onPdfFileSelected`) — one source of truth, zero duplicated file
    // selection logic. `dragover` must call `preventDefault()`, otherwise
    // the browser's default behavior OPENS the dropped file as navigation
    // instead of firing `drop`.
    const dropzone = this.element.querySelector<HTMLElement>('[data-role="dropzone"]');
    dropzone?.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      if (this.#isBusy()) return;
      dropzone.classList.add('bindery-dragover');
    });
    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('bindery-dragover');
    });
    dropzone?.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropzone.classList.remove('bindery-dragover');
      const file = ev.dataTransfer?.files?.[0] ?? null;
      if (file) this.#onPdfFileSelected(file);
    });
  }

  /**
   * Analysing, building the review, or a review screen still open. Picking another file meanwhile would mix two
   * PDFs: the work in flight reads `#state.fileName` after its `await`s, so the new name would label the old file's
   * journals and images. The template disables the file input and the drop zone, and the handlers check it too.
   */
  #isBusy(): boolean {
    return this.#state.status === 'analyzing' || this.#state.isBuildingReview || this.#state.isReviewOpen;
  }

  #onPdfFileSelected(file: File | null): void {
    if (this.#isBusy()) return;
    this.#selectedFile = file;
    this.#fileBuffer = null;
    this.#state.fileName = file?.name ?? null;
    this.#state.status = 'idle';
    this.#state.errorMessage = null;
    this.#state.summary = null;
    this.#state.reviewBuildError = null;
    this.#state.lastImportSummary = null;
    void this.render();
  }

  /** The wizard that is open now. The settings menu creates a NEW instance on every click (`registerMenu`), and all of them share one element id. */
  static #current: ImportWizard | null = null;

  /**
   * One wizard at a time. A second instance rendered while the first is open would take over the first one's element
   * (same id, Foundry swaps it), leaving the first to run unseen: its analysis could not be closed or aborted, and
   * each instance guards against a second review screen only for itself (`#isBusy`). The open wizard is brought to the
   * front instead, and the new instance is never rendered.
   */
  override async render(options?: object | boolean, _options?: object): Promise<this> {
    const current = ImportWizard.#current;
    if (current !== null && current !== this) {
      current.bringToFront();
      return this;
    }
    ImportWizard.#current = this;
    return super.render(options as never, _options as never);
  }

  override async close(options?: object): Promise<this> {
    this.#closed = true;
    this.#buildController?.abort();
    if (ImportWizard.#current === this) ImportWizard.#current = null;
    await super.close(options);
    return this;
  }

  static async #onAnalyze(this: ImportWizard): Promise<void> {
    if (!this.#selectedFile || this.#isBusy()) return;
    this.#state.status = 'analyzing';
    this.#state.errorMessage = null;
    await this.render();

    try {
      this.#fileBuffer = await this.#selectedFile.arrayBuffer();
      // Dynamic import — only now does pdf.js (and @bindery/core, which uses
      // it) actually get loaded. Risk I3.
      const { inspectDocument } = await loadCore();
      const summary = await inspectDocument(this.#fileBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#state.status = 'done';
      this.#state.summary = summary;
    } catch (err: unknown) {
      this.#state.status = 'error';
      const name = (err as { name?: string } | null)?.name;
      // An encrypted PDF -> a readable message, zero attempts to bypass
      // protections, zero unhandled exception in the console.
      this.#state.errorMessage =
        name === 'PasswordException'
          ? game.i18n!.localize('BINDERY.wizard.errorEncrypted')
          : game.i18n!.localize('BINDERY.wizard.errorGeneric');
      console.warn('Bindery | inspectDocument failed:', err);
    }

    await this.render();
  }

  /**
   * Replaces the old extractImages->buildJournals->createJournals
   * chain (each step creating documents IMMEDIATELY, with no review) — it
   * now builds the whole `CIFDocument` (images+scenes+journals+diagnostics),
   * opens a page preview, and hands EVERYTHING to the review screen. Zero
   * Foundry documents are created in THIS function.
   */
  static async #onOpenReview(this: ImportWizard): Promise<void> {
    // A second review over the first one is refused: `ReviewScreen` has a fixed id, and Foundry swaps the first
    // window's element out for the second's, so the first instance would never close — its pdf.js worker (the whole
    // file), its document-level key listeners and its `open()` promise would stay behind until the page reloads.
    if (!this.#fileBuffer || !this.#state.fileName || this.#isBusy()) return;
    // Read once: everything below runs after `await`s.
    const fileBuffer = this.#fileBuffer;
    const fileName = this.#state.fileName;
    this.#state.isBuildingReview = true;
    this.#state.reviewBuildError = null;
    this.#state.reviewProgress = null;
    await this.render();

    this.#buildController = new AbortController();
    let result: CIFBuildResult;
    try {
      result = await buildJournalsForReview(fileBuffer, fileName, {
        signal: this.#buildController.signal,
        onProgress: (done, total) => {
          this.#state.reviewProgress = { done, total };
          void this.render();
        },
      });
    } catch (err: unknown) {
      this.#state.isBuildingReview = false;
      if (err instanceof DOMException && err.name === 'AbortError') {
        await this.render();
        return;
      }
      this.#state.reviewBuildError = game.i18n!.localize('BINDERY.wizard.journalBuildErrorGeneric');
      console.warn('Bindery | buildJournalsForReview failed:', err);
      await this.render();
      return;
    } finally {
      this.#buildController = null;
    }

    // Owned here until `ReviewScreen.open()` takes it (the screen releases it when it closes); released here on any
    // way out before that, or its pdf.js worker keeps the whole file in memory until the page reloads.
    let previewDocument: Awaited<ReturnType<typeof openPreviewForReview>> | null = null;
    try {
      previewDocument = await openPreviewForReview(fileBuffer);
      // [bug fix — full design review] `#buildController` is already `null`
      // at this point (see the comment near the `#closed` field) — without
      // this checked flag, closing the window EXACTLY within this time
      // window (between the end of the CIF build and opening the preview)
      // had no way to stop the `ReviewScreen.open()` call below.
      if (this.#closed) return;
      // "Add a white background to images": the analysis has done it (on the pixels, before encoding), so the review
      // shows, edits and rotates the pictures with it. Noted here so that saving does not check every picture again.
      if (result.whiteBackgroundApplied) {
        const { markAllOpaque } = await import('../documents/whiteBackground.js');
        markAllOpaque(result.imageBytesById);
      }
      const { ReviewScreen } = await import('./ReviewScreen.js');
      if (this.#closed) return;
      this.#state.isBuildingReview = false;
      this.#state.isReviewOpen = true;
      await this.render();

      const reviewPromise = ReviewScreen.open({
        document: result.document,
        imageBytesById: result.imageBytesById,
        previewDocument,
        fileName,
        fileBuffer,
      });
      previewDocument = null; // the review screen owns it from now on
      const reviewResult = await reviewPromise;
      this.#state.isReviewOpen = false;

      if (reviewResult.confirmed) {
        // "Import complete" only when it is: an import that made nothing, or only a part, says so.
        const errors = reviewResult.errorCount ?? 0;
        const created = reviewResult.createdCount ?? 0;
        if (errors === 0) {
          this.#state.lastImportSummary = game.i18n!.localize('BINDERY.wizard.reviewImportDone' as never);
          ui.notifications?.info(this.#state.lastImportSummary);
        } else if (created > 0) {
          this.#state.lastImportSummary = game.i18n!.format('BINDERY.wizard.reviewImportPartial' as never, { created: String(created), errors: String(errors) } as never);
          ui.notifications?.warn(this.#state.lastImportSummary);
        } else {
          this.#state.lastImportSummary = game.i18n!.format('BINDERY.wizard.reviewImportFailed' as never, { errors: String(errors) } as never);
          ui.notifications?.error(this.#state.lastImportSummary);
        }
      }
      await this.render();
    } catch (err) {
      this.#state.isBuildingReview = false;
      this.#state.isReviewOpen = false;
      this.#state.reviewBuildError = game.i18n!.localize('BINDERY.wizard.journalBuildErrorGeneric');
      console.warn('Bindery | opening the review screen failed:', err);
      await this.render();
    } finally {
      await previewDocument?.destroy();
    }
  }
}
