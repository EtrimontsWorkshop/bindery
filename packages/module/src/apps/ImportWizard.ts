import { ASSET_BASE_URL } from '../settings.js';
import { buildJournalsForReview, openPreviewForReview, type CIFBuildResult } from '../api.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

interface WizardState {
  status: 'idle' | 'analyzing' | 'done' | 'error';
  fileName: string | null;
  errorMessage: string | null;
  summary: import('@bindery/core').DocumentSummary | null;
  isBuildingReview: boolean;
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
      reviewProgress: this.#state.reviewProgress,
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

  #onPdfFileSelected(file: File | null): void {
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

  override async close(options?: object): Promise<this> {
    this.#closed = true;
    this.#buildController?.abort();
    return super.close(options);
  }

  static async #onAnalyze(this: ImportWizard): Promise<void> {
    if (!this.#selectedFile) return;
    this.#state.status = 'analyzing';
    this.#state.errorMessage = null;
    await this.render();

    try {
      this.#fileBuffer = await this.#selectedFile.arrayBuffer();
      // Dynamic import — only now does pdf.js (and @bindery/core, which uses
      // it) actually get loaded. Risk I3.
      const { inspectDocument } = await import('@bindery/core');
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
    if (!this.#fileBuffer || !this.#state.fileName) return;
    this.#state.isBuildingReview = true;
    this.#state.reviewBuildError = null;
    this.#state.reviewProgress = null;
    await this.render();

    this.#buildController = new AbortController();
    let result: CIFBuildResult;
    try {
      result = await buildJournalsForReview(this.#fileBuffer, this.#state.fileName, {
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

    try {
      const previewDocument = await openPreviewForReview(this.#fileBuffer);
      // [bug fix — full design review] `#buildController` is already `null`
      // at this point (see the comment near the `#closed` field) — without
      // this checked flag, closing the window EXACTLY within this time
      // window (between the end of the CIF build and opening the preview)
      // had no way to stop the `ReviewScreen.open()` call below.
      if (this.#closed) {
        await previewDocument.destroy();
        return;
      }
      this.#state.isBuildingReview = false;
      await this.render();

      const { ReviewScreen } = await import('./ReviewScreen.js');
      const reviewResult = await ReviewScreen.open({
        document: result.document,
        imageBytesById: result.imageBytesById,
        previewDocument,
        fileName: this.#state.fileName,
        fileBuffer: this.#fileBuffer,
      });

      if (reviewResult.confirmed) {
        this.#state.lastImportSummary = game.i18n!.localize('BINDERY.wizard.reviewImportDone' as never);
        ui.notifications?.info(game.i18n!.localize('BINDERY.wizard.reviewImportDone' as never));
      }
      await this.render();
    } catch (err) {
      this.#state.isBuildingReview = false;
      this.#state.reviewBuildError = game.i18n!.localize('BINDERY.wizard.journalBuildErrorGeneric');
      console.warn('Bindery | opening the review screen failed:', err);
      await this.render();
    }
  }
}
