import type { CIFDocument, CIFImage, CIFScene, CIFJournal, Diagnostic, PreviewDocument, Rect, RotatedRect, RegionCrop } from '@bindery/core';
import { classifyTargetKind, screenRotatedRectToPdf, rotatedRectBounds, inscribedRotatedRectScale, DEFAULT_WEBP_QUALITY } from '@bindery/core';
import { MODULE_ID, type ImportTargets } from '../settings.js';
import { ReviewSelection, defaultImageDestination, sortImagesForReview, type ImageDestination } from '../review/selectionState.js';
import { VirtualList } from '../review/VirtualList.js';
import { prepareToken } from './TokenPrepApp.js';
import { STATBLOCK_IMPORT_ENABLED } from '../statblock/enabled.js';
import { pageRef } from '../i18n.js';
import { PagePreviews } from '../review/pagePreviews.js';
import { ImageThumbnails } from '../review/imageThumbnails.js';
import { PageOverlay } from '../review/pageOverlay.js';
import { ImageRows } from '../review/imageRows.js';
import { runReviewImport, type ImportProgress } from '../review/runImport.js';
import type { StatblockReviewState } from '../statblock/ui/statblockReviewState.js';
import { eraseImage } from './ImageEraseApp.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

type ReviewTab = 'images' | 'scenes' | 'journals' | 'diagnostics' | 'statblocks';
type ReviewStep = 'review' | 'target' | 'summary';
/** [User request, "two tabs: automatic and manual"] Image source — PURELY a presentational split of the Images tab list, not a new `CIFImage` field: `manual` is recognized by the `id` prefix (`manual-crop-`, see `#createManualCrop`). */
type ImageSourceTab = 'auto' | 'manual';
/**
 * [User request] Sub-tab WITHIN each `ImageSourceTab` — filters by the ALREADY existing `ReviewSelection.imageDestination` (the same choice as the per-row "Destination" dropdown), not new state.
 * `unassignedText` is the unassigned images that are boxes of text (`CIFImage.holdsText`): core hides them by default, so they are kept apart from the other unassigned images.
 */
type ImageDestTab = ImageDestination | 'unassignedText';

interface JournalRow {
  kind: 'journal' | 'page';
  journal: CIFJournal;
  pageId?: string;
  pageName?: string;
  pageIndex?: number;
}

interface DiagnosticGroup {
  code: string;
  severity: Diagnostic['severity'];
  count: number;
  examples: Diagnostic[];
}

export interface ReviewScreenData {
  document: CIFDocument;
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  previewDocument: PreviewDocument;
  fileName: string;
  /** The PDF's bytes — enables the Statblocks tab (finding statblocks needs the document itself, not only the extracted images). */
  fileBuffer?: ArrayBuffer;
}

export interface ReviewScreenResult {
  confirmed: boolean;
  /** Documents and files the import made (0 when not confirmed). */
  createdCount?: number;
  /** Things the import could not do: its diagnostics of severity `error` (0 when not confirmed). */
  errorCount?: number;
}

/**
 * Review screen — split-pane ApplicationV2, virtualized lists, page preview + bbox overlays,
 * selection model, a read-only journal tree, the target screen, the diagnostics panel. PURE
 * presentation/selection over an already-built `CIFDocument` — zero decision logic
 * (classification/CIF is built EXCLUSIVELY in `packages/core`, `check:boundary`).
 *
 * Opened dynamically (see `ImportWizard.ts`) — NOT statically imported from
 * `main.ts`, so as not to burden the <40KB world-startup budget.
 */
export class ReviewScreen extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-review',
    classes: ['bindery', 'bindery-review-app'],
    window: {
      title: 'BINDERY.review.title',
      resizable: true,
      icon: 'fa-solid fa-magnifying-glass',
    },
    // [Redesign 2a, fix reported live] The preview split (fixed 340px) +
    // image table (columns fixed at 22/36/74/148px from the README) needs
    // considerably more room than the old single label — at the old 960
    // width the name column got about 14px (practically invisible).
    position: { width: 1180, height: 720 },
    actions: {
      cancelReview: ReviewScreen.#onCancelReview,
      proceedToTarget: ReviewScreen.#onProceedToTarget,
      backToReview: ReviewScreen.#onBackToReview,
      confirmImport: ReviewScreen.#onConfirmImport,
      closeReview: ReviewScreen.#onCloseReview,
      switchTab: ReviewScreen.#onSwitchTab,
      switchImageSourceTab: ReviewScreen.#onSwitchImageSourceTab,
      switchImageDestTab: ReviewScreen.#onSwitchImageDestTab,
      selectAllImages: ReviewScreen.#onSelectAllImages,
      selectNoImages: ReviewScreen.#onSelectNoImages,
      selectAllJournals: ReviewScreen.#onSelectAllJournals,
      selectNoJournals: ReviewScreen.#onSelectNoJournals,
      applyBulkSettings: ReviewScreen.#onApplyBulkSettings,
      prevPage: ReviewScreen.#onPrevPage,
      nextPage: ReviewScreen.#onNextPage,
      openDocument: ReviewScreen.#onOpenDocument,
      toggleSelectMode: ReviewScreen.#onToggleSelectMode,
      zoomIn: ReviewScreen.#onZoomIn,
      zoomOut: ReviewScreen.#onZoomOut,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery-pdf-importer/templates/review-screen.hbs',
      // [User report, "clicking an image scrolls the list back to the top"]
      // Clicking a row on a page other than the one currently shown
      // (`#buildImageRow`) and many other actions (select all/none, apply
      // bulk settings, ...) call `this.render()` — the same mechanism as in
      // `ImportWizard.ts` (see the comment there): ApplicationV2 replaces
      // this whole part's root with a new element, so EVERY scrollable
      // container inside it (including `VirtualList`, which reads
      // `container.scrollTop` directly on mount — `VirtualList.ts`) gets a
      // fresh element with `scrollTop` reset by definition. `scrollable` is
      // Foundry's own documented mechanism (`handlebars-application.mjs`)
      // for exactly this case — it remembers `scrollTop` BEFORE the swap and
      // restores it AFTER, BEFORE `_onRender` (and hence `#mountImageList`/
      // `VirtualList`'s constructor) even runs, so virtualization sees the
      // correct position right away. All five scrollable lists on the review
      // screen, not just Images.
      scrollable: [
        '[data-list="images"]',
        '[data-list="scenes"]',
        '[data-list="journals"]',
        '[data-list="diagnostics"]',
        '[data-list="summaryDiagnostics"]',
      ],
    },
  };

  /** The review screen currently open, if any — there is at most one (see `open`). */
  static #current: ReviewScreen | null = null;

  /**
   * Opens the review screen, which takes ownership of `data.previewDocument` (released in `close`). Only one review
   * screen can be open: the window has a fixed id, and Foundry swaps an open window's element out for a second
   * instance's, so the first one would never close — its pdf.js worker, its document-level key listeners and its
   * promise would stay behind. A second call while one is open brings the open one to front and resolves unconfirmed.
   */
  static open(data: ReviewScreenData): Promise<ReviewScreenResult> {
    const current = ReviewScreen.#current;
    if (current) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.review.alreadyOpen' as never));
      current.bringToFront();
      void data.previewDocument.destroy().catch((err: unknown) => console.warn('Bindery | releasing the preview document failed:', err));
      return Promise.resolve({ confirmed: false });
    }
    return new Promise((resolve) => {
      const app = new ReviewScreen(data);
      app.#resolve = resolve;
      ReviewScreen.#current = app;
      app.render(true).catch((err: unknown) => {
        console.warn('Bindery | rendering the review screen failed:', err);
        void app.close();
      });
    });
  }

  #data: ReviewScreenData;
  #selection: ReviewSelection;
  #resolve: ((result: ReviewScreenResult) => void) | null = null;
  #settled = false;

  #step: ReviewStep = 'review';
  #tab: ReviewTab = 'images';
  /** The Statblocks tab's state — created in the background right after the review screen first renders, so the tab's counter is accurate before the tab is opened (finding statblocks reads the whole PDF, but never blocks the screen). */
  #statblocks: StatblockReviewState | null = null;
  /** Detection is started once per review screen, not on every render. */
  #statblockDetectionStarted = false;
  #statblocksStarting: Promise<void> | null = null;
  /** [User request] Sub-tabs WITHIN the Images tab — see `ImageSourceTab`/`ImageDestTab`. */
  #imageSourceTab: ImageSourceTab = 'auto';
  // [User request, "all images end up in Unassigned"]
  // The default sub-tab is now `unassigned` (not `scene`) — since EVERY
  // image starts with this destination, opening on "Scene" would show an
  // empty list every time.
  #imageDestTab: ImageDestTab = 'unassigned';

  #currentPageNumber = 1;
  #pagePreviews: PagePreviews;

  /** Id of the image highlighted by a click ON THE LIST OR on the bbox overlay — works both ways. */
  #highlightedImageId: string | null = null;
  #arrowKeyHandlers: { onPointerDown: (ev: PointerEvent) => void; onKeyDown: (ev: KeyboardEvent) => void; onKeyUp: (ev: KeyboardEvent) => void } | null = null;
  /** Whether the last click was inside this window — only then the arrow keys move the highlight. */
  #keysBelongToWindow = true;

  // ---- [User request, "zooming the PDF in the importer"] --------
  /**
   * Page-preview zoom level — SHARED between the Images/Actors tabs (the
   * same pattern as `#currentPageNumber`). 100 = default, fixed 3:4 frame
   * with letterboxing (`bindery.css`, "UNTOUCHED" — a literal dimension from
   * the design handoff) — ABOVE 100 it switches `.bindery-page-canvas-wrap`
   * into scrollable mode (mirroring `.bindery-profile-studio`'s already
   * existing, proven use of the same layout: `overflow:auto`, image scaled
   * by width ONLY). Changing zoom is DELIBERATELY surgical (`#setZoom`,
   * without `void this.render()`) — a full render would replace the whole
   * part's root and reset the image list's scroll position (the same
   * mechanism `scrollable` above fixes for OTHER actions, but zoom doesn't
   * need to go through it at all, since it's a purely visual style change).
   */
  static readonly #MIN_ZOOM = 100;
  static readonly #MAX_ZOOM = 300;
  static readonly #ZOOM_STEP = 25;
  #zoomPercent = ReviewScreen.#MIN_ZOOM;
  /** [User request, "I'd prefer a smaller angle than 90 degrees, e.g. every 10"] Step for a single `#rotateImage` click — a minor correction (e.g. a slightly skewed scanned map), not a full quarter-turn. */
  static readonly #IMAGE_ROTATE_STEP_DEG = 10;

  // ---- "Select and crop" — manual selection of a page fragment --------
  /** Mode toggled on/off by a button in the page-preview toolbar — see `#onToggleSelectMode`. */
  #isSelectMode = false;
  /** Counter for `id`s of manually added images (`manual-crop-N`) — unique within THIS review session, which is the only requirement (see `buildCIFImages` in core: `id` is merely a local key for this document). */
  #manualCropSeq = 0;
  /** State of an in-progress drag (between pointerdown and pointerup) — `null` when nothing is being dragged. Coordinates are in the SVG overlay's viewBox space (the same pixels as the rendered page preview). */
  #dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null = null;
  /** Guards against parallel/overlapping crops (e.g. a second drag before the first region render has finished). */
  #isCropping = false;
  /**
   * [User request, "rotate the selected area before cropping"] After a drag
   * finishes (`finishDrag`) we no longer crop right away — we move into a
   * "rotation adjustment" state: this rectangle (coordinates in the SAME
   * viewBox space as `#dragState`) is drawn with a drag handle
   * (`#renderPendingCropOverlay`) and a confirm/cancel bar
   * (`#showPendingCropToolbar`), until the user confirms
   * (`#confirmPendingCrop`) or cancels (`#cancelPendingCrop`). `null` when
   * nothing is being adjusted.
   */
  #pendingCrop: RotatedRect | null = null;
  /** Page number ON WHICH `#pendingCrop` was created — the pixel coordinates only make sense for that specific page/preview. Every place that changes `#currentPageNumber` (◄/► navigation, clicking an image/actor row on another page, typing a page number) must reset `#pendingCrop` — `draw()` in `#mountOverlay` checks this as an extra safety net, see below. */
  #pendingCropPageNumber: number | null = null;
  /**
   * [User request, "the ability to rotate an automatically selected image"]
   * LIVE rotation adjusted via the handle in `#renderResizeHandles` for the
   * HIGHLIGHTED image — kept separate from `image.provenance.bbox` (which is
   * ALWAYS axis-aligned throughout the project) and keyed by `imageId`, so
   * it can't accidentally "leak" onto another image if the highlight changes
   * without a full render. Reset after a successful `#resizeImage` (see
   * there) — otherwise the NEXT edit of the same image would start from an
   * incorrect, "doubled" rotation.
   */
  #imageAdjustRotation: { imageId: string; rotationRad: number } | null = null;
  /**
   * The bulk-operations bar (`bulkDestination`/
   * `bulkJournalGroup`) is a plain `<select>`/`<input>` in the Handlebars
   * markup, with NO `{{value}}` bound to persistent state (unlike e.g.
   * `targets.namePrefix`) — every `render()` (including plain ◄/► page
   * preview navigation) recreates them FROM SCRATCH, and the browser
   * defaults to selecting the FIRST `<select>` option ("Scene"), silently
   * losing the user's choice. These two fields remember the last choice and
   * are restored in `#wireBulkImageControls` after every mount of the
   * Images tab.
   */
  #bulkDestinationValue: ImageDestination = 'scene';
  #bulkJournalGroupValue = '';
  #imageList: VirtualList<CIFImage> | null = null;
  #sceneList: VirtualList<CIFScene> | null = null;
  #journalRows: JournalRow[] = [];
  #journalList: VirtualList<JournalRow> | null = null;
  #diagnosticGroups: DiagnosticGroup[] = [];
  #diagnosticList: VirtualList<DiagnosticGroup> | null = null;
  #thumbnails: ImageThumbnails;
  /** The layer over the page preview: image boxes, resize handles, the crop rectangle (see `review/pageOverlay.ts`). */
  #overlay: PageOverlay;
  /** Builds the rows of the image list (see `review/imageRows.ts`). */
  #imageRows: ImageRows;
  /** The enlarged thumbnail shown while hovering an image row's thumbnail (appended to `document.body`, so the virtualized list can't clip it). */
  #thumbPreviewEl: HTMLElement | null = null;
  /**
   * [Bug fix, reported: "after 36 rotations of 10°, the image should return
   * to its original state (360°), but it shrinks with every rotation"]
   * BEFORE this fix, every `#rotateImage` rotated the already-cropped RESULT
   * of the previous rotation, so the cropping loss (`inscribedRotatedRectScale`
   * < 1 for any angle other than a multiple of 180°) ACCUMULATED
   * exponentially even though the total angle returned to 0°. Fix: remember
   * the ORIGINAL bytes (from the moment of the FIRST rotation click for a
   * given image, before any cropping at all) + the total angle IN DEGREES
   * (int, modulo 360 — zero floating-point drift from repeatedly adding
   * radians) and ALWAYS rotate the ORIGINAL bytes by the ENTIRE total angle
   * from zero, never the result of the previous rotation. At a total angle
   * of 0° (any multiple of 360°) `inscribedRotatedRectScale` returns EXACTLY
   * 1 — a full, exact return to the original. Cleared in `#resizeImage` (a
   * fresh crop from the PDF is a NEW "0°" reference point, the old
   * `originalBytes` no longer applies).
   */
  #imageRotationState = new Map<string, { originalBytes: Uint8Array; originalFormat: string; totalDeg: number }>();
  /**
   * Images the user changed by hand in the token panel or the image editor. The "white background" setting does not
   * put its background back on them when they are saved: a background the user removed on purpose stays removed.
   */
  #handEditedImageIds = new Set<string>();
  /**
   * [User request, "I pick an image from the list, it jumps back to the
   * top"] Scroll position of EVERY virtualized list, tracked LIVE (see
   * `VirtualList`'s `onScroll`) and restored on every remount
   * (`initialScrollTop`) — Foundry's own `scrollable` (`PARTS.main` above)
   * does NOT work for these lists, see the rationale next to
   * `initialScrollTop` in `VirtualList.ts`. The key = the same string as
   * `data-list="..."` in the template, PURELY for readability (not read
   * from the DOM).
   */
  #listScrollTop: Record<string, number> = {};

  #targets: ImportTargets;
  #isImporting = false;
  /**
   * What earlier import attempts of this screen already did. An attempt that fails part-way (a folder that cannot be
   * created, a journal that cannot be saved) leaves the documents it made behind, and clicking "Import" again would
   * make them a second time. A retry skips what is recorded here and keeps its summary entries; an upload is reused
   * while the picture's bytes are the same array (an edit replaces them, so an edited picture is uploaded again).
   */
  #importProgress: ImportProgress = { doneKeys: new Set(), entries: [], uploads: new Map() };
  #importError: string | null = null;
  #summaryEntries: { label: string; uuid?: string }[] = [];
  #summaryDiagnostics: Diagnostic[] = [];

  constructor(data: ReviewScreenData) {
    super();
    this.#data = data;
    this.#pagePreviews = new PagePreviews(
      async (pageNumber) => (await data.previewDocument.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' })).bytes,
      () => this.#currentPageNumber,
    );
    this.#thumbnails = new ImageThumbnails(data.imageBytesById);
    this.#selection = ReviewSelection.fromDocument(data.document);
    this.#rebuildJournalRows();
    this.#rebuildDiagnosticGroups();
    const stored = game.settings!.get(MODULE_ID, 'importTargets') as ImportTargets;
    this.#targets = { sceneFolder: stored.sceneFolder, journalFolder: stored.journalFolder, namePrefix: stored.namePrefix };
    // The collaborators below read and change this screen's state through accessors, which need the screen itself
    // (inside an object literal `this` is the literal).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.#overlay = new PageOverlay({
      get element() {
        return self.element;
      },
      get currentPageNumber() {
        return self.#currentPageNumber;
      },
      set currentPageNumber(value) {
        self.#currentPageNumber = value;
      },
      data: this.#data,
      get highlightedImageId() {
        return self.#highlightedImageId;
      },
      set highlightedImageId(value) {
        self.#highlightedImageId = value;
      },
      selection: this.#selection,
      get imageList() {
        return self.#imageList;
      },
      set imageList(value) {
        self.#imageList = value;
      },
      refreshImageRowHighlights: () => this.#refreshImageRowHighlights(),
      get pendingCrop() {
        return self.#pendingCrop;
      },
      set pendingCrop(value) {
        self.#pendingCrop = value;
      },
      get pendingCropPageNumber() {
        return self.#pendingCropPageNumber;
      },
      set pendingCropPageNumber(value) {
        self.#pendingCropPageNumber = value;
      },
      get overlayDraw() {
        return self.#overlayDraw;
      },
      set overlayDraw(value) {
        self.#overlayDraw = value;
      },
      get overlayResizeObserver() {
        return self.#overlayResizeObserver;
      },
      set overlayResizeObserver(value) {
        self.#overlayResizeObserver = value;
      },
      get isSelectMode() {
        return self.#isSelectMode;
      },
      set isSelectMode(value) {
        self.#isSelectMode = value;
      },
      get isCropping() {
        return self.#isCropping;
      },
      set isCropping(value) {
        self.#isCropping = value;
      },
      get dragState() {
        return self.#dragState;
      },
      set dragState(value) {
        self.#dragState = value;
      },
      createManualCropRotated: (screenRect) => this.#createManualCropRotated(screenRect),
      get imageAdjustRotation() {
        return self.#imageAdjustRotation;
      },
      set imageAdjustRotation(value) {
        self.#imageAdjustRotation = value;
      },
      resizeImage: (image, screenRect) => this.#resizeImage(image, screenRect),
    });
    this.#imageRows = new ImageRows({
      get highlightedImageId() {
        return self.#highlightedImageId;
      },
      set highlightedImageId(value) {
        self.#highlightedImageId = value;
      },
      selection: this.#selection,
      refreshHeaderCounts: () => this.#refreshHeaderCounts(),
      data: this.#data,
      thumbnails: this.#thumbnails,
      showThumbPreview: (url, anchor, imageWidth, imageHeight) => this.#showThumbPreview(url, anchor, imageWidth, imageHeight),
      hideThumbPreview: () => this.#hideThumbPreview(),
      openImageEditor: (image) => this.#openImageEditor(image),
      prepareToken: (image) => this.#prepareToken(image),
      render: () => this.render(),
      rotateImage: (image, direction) => this.#rotateImage(image, direction),
      get currentPageNumber() {
        return self.#currentPageNumber;
      },
      set currentPageNumber(value) {
        self.#currentPageNumber = value;
      },
      refreshImageRowHighlights: () => this.#refreshImageRowHighlights(),
      overlay: this.#overlay,
      IMAGE_ROTATE_STEP_DEG: ReviewScreen.#IMAGE_ROTATE_STEP_DEG,
    });
  }

  #rebuildJournalRows(): void {
    const rows: JournalRow[] = [];
    for (const journal of this.#data.document.journals) {
      rows.push({ kind: 'journal', journal });
      journal.pages.forEach((page, index) => {
        rows.push({ kind: 'page', journal, pageId: page.id, pageName: page.name, pageIndex: index });
      });
    }
    this.#journalRows = rows;
  }

  #rebuildDiagnosticGroups(): void {
    const byCode = new Map<string, Diagnostic[]>();
    for (const d of this.#data.document.diagnostics) {
      const arr = byCode.get(d.code) ?? [];
      arr.push(d);
      byCode.set(d.code, arr);
    }
    this.#diagnosticGroups = [...byCode.entries()]
      .map(([code, examples]) => ({ code, severity: examples[0]!.severity, count: examples.length, examples: examples.slice(0, 20) }))
      .sort((a, b) => b.count - a.count);
  }

  /** [User request] `manual-crop-` is the ONLY place where this prefix is assigned (`#createManualCrop`) — a safe way to recognize the source without an extra field on `CIFImage`. */
  static #isManualImage(image: CIFImage): boolean {
    return image.id.startsWith('manual-crop-');
  }

  /** The sub-tab (destination level) an image is listed under. */
  #destTabOf(image: CIFImage): ImageDestTab {
    const destination = this.#selection.imageDestination(image.id);
    return destination === 'unassigned' && image.holdsText === true ? 'unassignedText' : destination;
  }

  /** The Images list AFTER both levels of filtering (source + destination), in the same order as `sortImagesForReview` — the only thing `#mountImageList`/`#mountOverlay` actually see. */
  #visibleImages(): CIFImage[] {
    return sortImagesForReview(this.#data.document.images, game.settings!.get(MODULE_ID, 'sortByPage') === true).filter(
      (i) => (ReviewScreen.#isManualImage(i) ? 'manual' : 'auto') === this.#imageSourceTab && this.#destTabOf(i) === this.#imageDestTab,
    );
  }

  /** Counters for the source sub-tabs ("Automatically detected"/"Manually selected") — the WHOLE document, regardless of the active destination sub-tab. */
  #imageSourceCounts(): { auto: number; manual: number } {
    let auto = 0;
    let manual = 0;
    for (const image of this.#data.document.images) {
      if (ReviewScreen.#isManualImage(image)) manual++;
      else auto++;
    }
    return { auto, manual };
  }

  /** Counters for the destination sub-tabs (Scene/Journal/Token/Unassigned) — SOLELY within the active source sub-tab. */
  #imageDestCounts(): Record<ImageDestTab, number> {
    const counts: Record<ImageDestTab, number> = { scene: 0, journal: 0, token: 0, unassigned: 0, unassignedText: 0 };
    for (const image of this.#data.document.images) {
      if ((ReviewScreen.#isManualImage(image) ? 'manual' : 'auto') !== this.#imageSourceTab) continue;
      counts[this.#destTabOf(image)]++;
    }
    return counts;
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const doc = this.#data.document;
    const sortedImages = this.#visibleImages();
    const sourceCounts = this.#imageSourceCounts();
    const destCounts = this.#imageDestCounts();
    return {
      isStepReview: this.#step === 'review',
      isStepTarget: this.#step === 'target',
      isStepSummary: this.#step === 'summary',
      // [Redesign 2a] The step track in the left column — "File" is ALWAYS
      // complete (the PDF was already chosen in the ImportWizard before this
      // screen even exists), "Review"/"Import" cycle through done/active/future
      // depending on `#step`.
      step2Done: this.#step !== 'review',
      step2Active: this.#step === 'review',
      step3Done: this.#step === 'summary',
      step3Active: this.#step === 'target',
      step3Future: this.#step === 'review',
      isTabImages: this.#tab === 'images',
      isTabScenes: this.#tab === 'scenes',
      isTabJournals: this.#tab === 'journals',
      isTabDiagnostics: this.#tab === 'diagnostics',
      isTabStatblocks: this.#tab === 'statblocks',
      hasStatblockTab: STATBLOCK_IMPORT_ENABLED && this.#data.fileBuffer !== undefined,
      statblockCount: this.#statblocks?.includedCount ?? 0,
      statblockCountLabel: this.#statblockCountLabel(),
      statblocks: this.#statblocks?.describe((imageId) => this.#thumbnails.full(imageId)) ?? null,
      // [User request, "two tabs: automatic and manual" + Scene/Journal/Token
      // sub-tabs] See `#visibleImages`/`ImageSourceTab`/`ImageDestTab` — PURE
      // presentation over already existing state (`ReviewSelection.imageDestination`,
      // image `id`), zero new decision logic.
      isImageSourceAuto: this.#imageSourceTab === 'auto',
      isImageSourceManual: this.#imageSourceTab === 'manual',
      autoImageCount: sourceCounts.auto,
      manualImageCount: sourceCounts.manual,
      isImageDestScene: this.#imageDestTab === 'scene',
      isImageDestJournal: this.#imageDestTab === 'journal',
      isImageDestToken: this.#imageDestTab === 'token',
      isImageDestUnassigned: this.#imageDestTab === 'unassigned',
      isImageDestUnassignedText: this.#imageDestTab === 'unassignedText',
      imageDestUnassignedTextCount: destCounts.unassignedText,
      hasTextImages: doc.images.some((i) => i.holdsText === true),
      imageDestSceneCount: destCounts.scene,
      imageDestJournalCount: destCounts.journal,
      imageDestTokenCount: destCounts.token,
      imageDestUnassignedCount: destCounts.unassigned,
      imageCount: doc.images.length,
      sceneCount: doc.scenes.length,
      journalCount: doc.journals.length,
      diagnosticGroupCount: this.#diagnosticGroups.length,
      selectedImageCount: this.#selection.selectedImageCount,
      importableImageCount: this.#selection.selectedAssignedImageCount,
      hasUnassignedSelection: this.#selection.selectedImageCount > this.#selection.selectedAssignedImageCount,
      selectedSceneCount: this.#selection.selectedSceneCount,
      selectedJournalCount: this.#selection.selectedJournalCount,
      totalSelectedCount: this.#totalSelectedCount(),
      currentPageNumber: this.#currentPageNumber,
      pageCount: this.#data.previewDocument.pageCount,
      canGoPrevPage: this.#currentPageNumber > 1,
      canGoNextPage: this.#currentPageNumber < this.#data.previewDocument.pageCount,
      currentPageImageUrl: this.#pagePreviews.get(this.#currentPageNumber),
      isSelectMode: this.#isSelectMode,
      zoomPercent: this.#zoomPercent,
      isZoomed: this.#zoomPercent > ReviewScreen.#MIN_ZOOM,
      canZoomIn: this.#zoomPercent < ReviewScreen.#MAX_ZOOM,
      canZoomOut: this.#zoomPercent > ReviewScreen.#MIN_ZOOM,
      targets: this.#targets,
      isImporting: this.#isImporting,
      importError: this.#importError,
      summaryEntries: this.#summaryEntries,
      summaryHasIssues: this.#summaryDiagnostics.length > 0,
      _sortedImages: sortedImages,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    if (!this.#statblockDetectionStarted && STATBLOCK_IMPORT_ENABLED && this.#data.fileBuffer !== undefined) {
      this.#statblockDetectionStarted = true;
      // After this render has finished: starting detection renders the screen again.
      setTimeout(() => void this.#ensureStatblocks(), 0);
    }
    this.#hideThumbPreview();
    this.#wireStatblockControls();

    // [At the user's request, the same pattern as Profile Studio] Navigation
    // SOLELY via ◄/► buttons was cumbersome on long documents — a numeric
    // field lets the page number be typed directly. Shared between the
    // Images/Actors tabs (`#currentPageNumber` is ONE, shared field) — at
    // most one `[data-input="pageNumber"]` exists in the DOM at a time (the
    // other tab isn't rendered), so the query always finds the right input
    // regardless of the active tab.
    const pageNumberInput = this.element.querySelector<HTMLInputElement>('input[data-input="pageNumber"]');
    pageNumberInput?.addEventListener('change', () => {
      const parsed = Math.round(Number(pageNumberInput.value));
      const pageCount = this.#data.previewDocument.pageCount;
      const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : this.#currentPageNumber, 1), Math.max(pageCount, 1));
      pageNumberInput.value = String(clamped);
      if (clamped !== this.#currentPageNumber) {
        this.#currentPageNumber = clamped;
        void this.render();
      }
    });
    pageNumberInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') pageNumberInput.blur();
    });

    this.#installArrowKeys();

    this.#imageList?.destroy();
    this.#imageList = null;
    this.#sceneList?.destroy();
    this.#sceneList = null;
    this.#journalList?.destroy();
    this.#journalList = null;
    this.#diagnosticList?.destroy();
    this.#diagnosticList = null;

    // [User request] Applied BEFORE mounting the overlay
    // (`#mountOverlay`/`#mountActorOverlay` below) — `draw()` there reads
    // `img.clientWidth` to scale the SVG, so the image must already have its
    // target (possibly zoomed) width before that happens. Without this,
    // every navigation between pages (a full `render()`, a brand new `<img>`
    // element) would silently lose the current zoom level.
    this.#applyZoomToDom();

    if (this.#step === 'review') {
      if (this.#tab === 'images') {
        void this.#ensurePageImage(this.#currentPageNumber);
        this.#mountImageList(context._sortedImages as CIFImage[]);
        void this.#overlay.mountOverlay(context._sortedImages as CIFImage[]);
        this.#wireBulkImageControls();
      } else if (this.#tab === 'scenes') {
        this.#mountSceneList();
      } else if (this.#tab === 'journals') {
        this.#mountJournalList();
      } else if (this.#tab === 'diagnostics') {
        this.#mountDiagnosticList(this.element.querySelector<HTMLElement>('[data-list="diagnostics"]'));
      }
      this.#wireTargetInputs();
    } else if (this.#step === 'target') {
      this.#wireTargetInputs();
    } else if (this.#step === 'summary') {
      this.#mountDiagnosticList(this.element.querySelector<HTMLElement>('[data-list="summaryDiagnostics"]'), this.#summaryDiagnostics);
    }
  }

  override async close(options?: object): Promise<this> {
    // Closing mid-import would leave the import running with no window to show its result or its errors.
    if (this.#isImporting) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.review.importInProgress' as never));
      return this;
    }
    if (ReviewScreen.#current === this) ReviewScreen.#current = null;
    this.#overlayResizeObserver?.disconnect();
    this.#overlayResizeObserver = null;
    this.#overlayDraw = null;
    this.#statblocks?.dispose();
    this.#removeArrowKeys();
    this.#hideThumbPreview();
    this.#imageList?.destroy();
    this.#sceneList?.destroy();
    this.#journalList?.destroy();
    this.#diagnosticList?.destroy();
    this.#pagePreviews.dispose();
    this.#thumbnails.dispose();
    try {
      await this.#data.previewDocument.destroy();
    } catch (err) {
      // A failing release must not keep the window open or leave `ReviewScreen.open` unresolved.
      console.warn('Bindery | releasing the preview document failed:', err);
    }
    if (!this.#settled) {
      this.#settled = true;
      this.#resolve?.({ confirmed: false });
    }
    await super.close(options);
    return this;
  }

  // ---- Page preview ----------------------------------------------

  async #ensurePageImage(pageNumber: number): Promise<void> {
    const rendered = await this.#pagePreviews.ensure(pageNumber);
    // A page the user has already left stays in the cache for when they come back; only the one on screen is shown.
    if (rendered && pageNumber === this.#currentPageNumber && this.#tab === 'images' && this.#step === 'review') await this.render();
  }

  #overlayResizeObserver: ResizeObserver | null = null;
  #overlayDraw: (() => void) | null = null;

  // ---- "Select and crop" ---------------------------------------

  static async #onToggleSelectMode(this: ReviewScreen): Promise<void> {
    this.#isSelectMode = !this.#isSelectMode;
    this.#dragState = null;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#overlay.teardownPendingCropUi();
    await this.render();
  }

  /**
   * [User request, "resizing" + "the ability to rotate an automatically
   * selected image"] Like `#createManualCropRotated` (the same
   * `screenRotatedRectToPdf` -> `previewDocument.renderRotatedRegion`), but
   * OVERWRITES the existing image IN PLACE (same `id`, same entry in
   * `doc.images` — `image` is a direct reference, not a copy) instead of
   * creating a new one — the image does NOT change tab/sub-tab
   * (classification/destination don't change), ONLY the cropped area
   * (size and/or rotation) and the rendered bytes/dimensions change.
   * `screenRect.rotationRad` can be 0 (a pure resize) — that's just a
   * special case of the same core function, exactly as with a new crop.
   */
  async #resizeImage(image: CIFImage, screenRect: RotatedRect): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
      const width = img?.naturalWidth ?? 0;
      const height = img?.naturalHeight ?? 0;
      if (!width || !height) return;
      // Read once: the page can be turned (arrow keys, the page field) while the lines below wait, and the region
      // belongs to the page it was drawn on.
      const pageNumber = this.#currentPageNumber;
      const box = await this.#data.previewDocument.getPageBox(pageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(pageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      image.width = crop.width;
      image.height = crop.height;
      image.format = crop.format;
      image.provenance = { ...image.provenance, bbox: rotatedRectBounds(pdfRegion) };
      this.#imageAdjustRotation = null;
      // The picture is rendered from the page again, so whatever was done to it by hand (eraser, token panel) is gone:
      // it is an ordinary picture once more, and the "white background" setting applies to it.
      this.#handEditedImageIds.delete(image.id);
      // [Bug fix, cumulative shrinking on content rotation] A fresh crop
      // from the PDF is a NEW "0°" reference point for `#rotateImage` — the
      // old `originalBytes` (if any) no longer represents the image's
      // current content.
      this.#imageRotationState.delete(image.id);
      this.#thumbnails.drop(image.id);
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: crop.bytes, format: crop.format });
      await this.render();
    } catch (err) {
      console.warn('Bindery | image resize/rotate failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * Shows a large, non-interactive preview of an image next to its row
   * thumbnail. The size is computed from the image's own dimensions (not from
   * the loaded `<img>`), so positioning doesn't depend on decode timing. The
   * popup is removed on mouse leave, on any wheel scroll (the virtualized
   * list rebuilds rows under a stationary cursor, so `mouseleave` isn't
   * reliable there) and when the window closes or re-renders.
   */
  #showThumbPreview(url: string, anchor: HTMLElement, imageWidth: number, imageHeight: number): void {
    this.#hideThumbPreview();
    const margin = 12;
    const maxW = Math.min(640, window.innerWidth * 0.5);
    const maxH = Math.min(720, window.innerHeight - margin * 2 - 10);
    const scale = Math.min(maxW / Math.max(1, imageWidth), maxH / Math.max(1, imageHeight), 4);
    const width = Math.max(1, Math.round(imageWidth * scale));
    const height = Math.max(1, Math.round(imageHeight * scale));

    const popup = document.createElement('div');
    popup.className = 'bindery bindery-thumb-preview';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.width = width;
    img.height = height;
    popup.appendChild(img);

    const rect = anchor.getBoundingClientRect();
    const boxW = width + 10;
    const boxH = height + 10;
    const fitsRight = rect.right + margin + boxW <= window.innerWidth - margin;
    const left = fitsRight ? rect.right + margin : Math.max(margin, rect.left - margin - boxW);
    const top = Math.min(Math.max(margin, rect.top + rect.height / 2 - boxH / 2), Math.max(margin, window.innerHeight - margin - boxH));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    document.body.appendChild(popup);
    this.#thumbPreviewEl = popup;
    window.addEventListener('wheel', () => this.#hideThumbPreview(), { once: true, passive: true, capture: true });
  }

  #hideThumbPreview(): void {
    this.#thumbPreviewEl?.remove();
    this.#thumbPreviewEl = null;
  }

  /**
   * Opens `ImageEraseApp` (a large preview with erase tools) on the CURRENT
   * image bytes; when the user applies changes it replaces the
   * bytes/dimensions/format — the same replacement pattern as
   * `#prepareToken`/`#resizeImage`, see there.
   */
  async #openImageEditor(image: CIFImage): Promise<void> {
    if (this.#isCropping) return;
    const entry = this.#data.imageBytesById.get(image.id);
    if (!entry) return;
    this.#isCropping = true;
    try {
      const result = await eraseImage({ bytes: entry.bytes, format: entry.format });
      if (!result) return;
      image.width = result.width;
      image.height = result.height;
      image.format = result.format;
      this.#imageRotationState.delete(image.id);
      this.#thumbnails.drop(image.id);
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: result.bytes, format: result.format });
      this.#handEditedImageIds.add(image.id);
      await this.render();
    } catch (err) {
      console.warn('Bindery | image erase failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.imageErase.failed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * Opens `TokenPrepApp` on the CURRENT
   * image bytes (`this.#data.imageBytesById`, NOT the PDF — background
   * removal, crop/zoom, mask and frame work on already-cropped content,
   * exactly like `#rotateImage`); on confirmation it replaces the
   * bytes/dimensions/format — mirrors `#resizeImage`'s replacement pattern,
   * see there.
   */
  async #prepareToken(image: CIFImage): Promise<void> {
    if (this.#isCropping) return;
    const entry = this.#data.imageBytesById.get(image.id);
    if (!entry) return;
    this.#isCropping = true;
    try {
      const result = await prepareToken({
        bytes: entry.bytes,
        format: entry.format,
        width: image.width,
        height: image.height,
        removeBackgroundDefault: false,
      });
      if (!result) return;
      image.width = result.width;
      image.height = result.height;
      image.format = result.format;
      this.#imageRotationState.delete(image.id);
      this.#thumbnails.drop(image.id);
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: result.bytes, format: result.format });
      this.#handEditedImageIds.add(image.id);
      await this.render();
    } catch (err) {
      console.warn('Bindery | token preparation failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [User request, "it's about rotating an ALREADY cropped image — the map
   * covers the whole page, rotating the selection would crop it wrong";
   * then "I'd prefer a smaller angle than 90 degrees, e.g. every 10"; then
   * "the image shrinks a lot after rotating, lots of empty space in the
   * frame"; then "after 36 rotations it should return to its original state
   * (360°), but it shrinks with every rotation"] Rotates the CONTENT
   * ITSELF — the PDF is not queried again at all (unlike `#resizeImage`,
   * which always goes back to the PDF for a fresh render). EVERY call
   * rotates `#imageRotationState`'s `originalBytes` (the ORIGINAL bytes,
   * NEVER overwritten, from before any rotation) by the ENTIRE new total
   * angle from zero — it does NOT rotate the result of the previous call —
   * otherwise the cropping loss from `inscribedRotatedRectScale` (the
   * LARGEST rectangle with the same proportions that fits ENTIRELY inside
   * the rotated content, zero transparent corners) would accumulate with
   * every click, even though the total angle returns to 0°/360°.
   */
  async #rotateImage(image: CIFImage, direction: 1 | -1): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      let state = this.#imageRotationState.get(image.id);
      if (!state) {
        const entry = this.#data.imageBytesById.get(image.id);
        if (!entry) return;
        state = { originalBytes: entry.bytes, originalFormat: entry.format, totalDeg: 0 };
        this.#imageRotationState.set(image.id, state);
      }
      const mime = state.originalFormat === 'png' ? 'image/png' : 'image/webp';
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(state.originalBytes)], { type: mime }));
      const totalDeg = (((state.totalDeg + direction * ReviewScreen.#IMAGE_ROTATE_STEP_DEG) % 360) + 360) % 360;
      const angleRad = (totalDeg * Math.PI) / 180;
      const scale = inscribedRotatedRectScale(bitmap.width, bitmap.height, angleRad);
      const outWidth = Math.max(1, Math.round(bitmap.width * scale));
      const outHeight = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(outWidth, outHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2D context for OffscreenCanvas');
      ctx.translate(outWidth / 2, outHeight / 2);
      ctx.rotate(angleRad);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      bitmap.close();
      const outBlob = await canvas.convertToBlob({ type: mime, quality: mime === 'image/webp' ? DEFAULT_WEBP_QUALITY : undefined });
      const newBytes = new Uint8Array(await outBlob.arrayBuffer());

      state.totalDeg = totalDeg;
      image.width = outWidth;
      image.height = outHeight;
      this.#thumbnails.drop(image.id);
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: newBytes, format: state.originalFormat });
      await this.render();
    } catch (err) {
      console.warn('Bindery | image rotation failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.imageRotateFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [User request, "rotate the selected area before cropping"] A ROTATED
   * screen bbox (`#pendingCrop`, `rotationRad` can be 0 — unrotated is just
   * a special case, see the test "rotationRad=0 -> same result as plain
   * screenRectToPdf" in `pageOverlayGeometry.test.ts`, which is why there is
   * NO LONGER a separate, "simple" path for the no-rotation case) ->
   * `screenRotatedRectToPdf` -> `previewDocument.renderRotatedRegion` -> a
   * new `CIFImage` inserted into `doc.images` — THE SAME data shape as an
   * image from core's automatic extraction, so the rest of the screen
   * (list, destination choice, `runReviewImport`) handles it without any special
   * cases (see `#finalizeManualCrop`). `provenance.bbox` (ALWAYS axis-aligned
   * throughout the project) is the bounding box of the rotated PDF region
   * (`rotatedRectBounds`) — for a rotated crop, the preview in the
   * list/overlay will therefore show a slightly LARGER, unrotated rectangle
   * around the actually saved (correctly rotated and cropped) image; the
   * saved image itself is cropped correctly regardless of this
   * simplification.
   */
  async #createManualCropRotated(screenRect: RotatedRect): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
      const width = img?.naturalWidth ?? 0;
      const height = img?.naturalHeight ?? 0;
      if (!width || !height) return;
      // Read once, as in `#resizeImage`: the crop belongs to the page it was drawn on.
      const pageNumber = this.#currentPageNumber;
      const box = await this.#data.previewDocument.getPageBox(pageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(pageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      await this.#finalizeManualCrop(pageNumber, rotatedRectBounds(pdfRegion), crop);
    } catch (err) {
      console.warn('Bindery | manual crop of rotated fragment failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.selectModeCropFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * PDF bbox + render result -> a new `CIFImage` inserted into
   * `doc.images` — THE SAME data shape as an image from core's automatic
   * extraction, so the rest of the screen (list, destination choice,
   * `runReviewImport`) handles it without any special cases. Shared between
   * `#createManualCrop` (axis-aligned) and `#createManualCropRotated`
   * (rotated) — the only difference between them is HOW `pdfBbox`/the
   * render is computed, not what happens with the result.
   */
  async #finalizeManualCrop(pageNumber: number, pdfBbox: Rect, crop: RegionCrop): Promise<void> {
    const id = `manual-crop-${++this.#manualCropSeq}`;
    const targetKind = classifyTargetKind({ width: crop.width, height: crop.height, classification: 'content', nearStatblockOrHeading: false });
    const newImage: CIFImage = {
      id,
      targetKind,
      width: crop.width,
      height: crop.height,
      format: crop.format,
      assetRef: id,
      classification: 'content',
      confidence: 1,
      rawText: '',
      provenance: { pageNumber, bbox: pdfBbox, blockIds: [] },
    };
    this.#data.document.images.push(newImage);
    (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(id, { bytes: crop.bytes, format: crop.format });
    const destination = defaultImageDestination();
    this.#selection.addManualImage(id, destination);
    this.#highlightedImageId = id;
    // [User request, Scene/Journal/Token/Unassigned sub-tabs]
    // A newly cropped fragment goes into the "Manually selected" sub-tab
    // under ITS OWN destination — without this, with a different sub-tab
    // active (e.g. the default "Scene", when the crop went to "Journal"),
    // the "Select and crop" effect was invisible: the image existed, but in
    // a DIFFERENT tab that wasn't currently shown.
    this.#imageSourceTab = 'manual';
    this.#imageDestTab = destination;
    await this.render();
  }

  static async #onPrevPage(this: ReviewScreen): Promise<void> {
    if (this.#currentPageNumber <= 1) return;
    this.#currentPageNumber--;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#overlay.teardownPendingCropUi();
    await this.render();
  }
  static async #onNextPage(this: ReviewScreen): Promise<void> {
    if (this.#currentPageNumber >= this.#data.previewDocument.pageCount) return;
    this.#currentPageNumber++;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#overlay.teardownPendingCropUi();
    await this.render();
  }

  static #onZoomIn(this: ReviewScreen): void {
    this.#setZoom(Math.min(ReviewScreen.#MAX_ZOOM, this.#zoomPercent + ReviewScreen.#ZOOM_STEP));
  }
  static #onZoomOut(this: ReviewScreen): void {
    this.#setZoom(Math.max(ReviewScreen.#MIN_ZOOM, this.#zoomPercent - ReviewScreen.#ZOOM_STEP));
  }

  /**
   * [User request, "the ability to zoom the PDF in the importer"]
   * DELIBERATELY surgical (without `void this.render()`) — zoom is a purely
   * visual style change to the existing `<img>`/overlay, it doesn't require
   * recreating the whole template. Mirrors
   * `#refreshImageRowHighlights`/`#redrawOverlay` (the same reason: a full
   * render would reset the image list's scroll position).
   */
  #setZoom(percent: number): void {
    if (percent === this.#zoomPercent) return;
    this.#zoomPercent = percent;
    this.#applyZoomToDom();
    for (const el of this.element.querySelectorAll<HTMLElement>('[data-zoom-readout]')) el.textContent = `${percent}%`;
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('[data-action="zoomOut"]')) btn.disabled = percent <= ReviewScreen.#MIN_ZOOM;
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('[data-action="zoomIn"]')) btn.disabled = percent >= ReviewScreen.#MAX_ZOOM;
    if (this.#tab === 'images') void this.#overlay.redrawOverlay();
  }

  /**
   * Applies the current `#zoomPercent` to the ALREADY EXISTING preview
   * elements — called both from `#setZoom` (+/− click) and from
   * `_onRender` (EVERY full render, e.g. page navigation, creates the
   * `<img>` FROM SCRATCH, so the zoom must be reapplied, otherwise it
   * silently reverts to 100%). Below the threshold (`#MIN_ZOOM`) it restores
   * EXACTLY the default layout (`bindery.css`: fixed 3:4 frame with
   * letterboxing) — an empty `style.width` (not an explicit value) gives
   * HIGHER priority to the plain CSS rule that sets it.
   *
   * [User request, "the window containing the pdf also grows" — the FIRST
   * fix attempt HERE (manual measurement + height lock in JS) broke
   * subsequent "+" clicks, see the now-REMOVED comment and `bindery.css`'s
   * current rationale next to `.bindery-zoomed`] The frame stays a FIXED
   * size purely through CSS itself (`aspect-ratio: 3/4` on
   * `.bindery-page-canvas-wrap`, DELIBERATELY not removed by
   * `.bindery-zoomed`) — the frame's height is computed SOLELY from its
   * width (which zoom never touches), never from the content inside, so
   * `overflow:auto` always has EXACTLY the same, fixed scrollable viewport.
   * Zero measurement in JS needed.
   */
  #applyZoomToDom(): void {
    const zoomed = this.#zoomPercent > ReviewScreen.#MIN_ZOOM;
    for (const wrap of this.element.querySelectorAll<HTMLElement>('.bindery-page-canvas-wrap')) {
      wrap.classList.toggle('bindery-zoomed', zoomed);
      const img = wrap.querySelector<HTMLImageElement>('.bindery-page-image');
      if (img) img.style.width = zoomed ? `${this.#zoomPercent}%` : '';
    }
  }

  /**
   * [Extracted after a whole-design review — the same pattern was
   * separately duplicated in `#mountImageList`/`#mountSceneList`/
   * `#mountJournalList`/`#mountDiagnosticList`] `scrollKey` is the only
   * thing EACH of them had separately (besides row height and the row
   * builder) — a single place to wire `initialScrollTop`/`onScroll` to
   * `#listScrollTop`, instead of four copies of the same logic, where the
   * key could silently drift out of sync with the `data-list` attribute in
   * the template.
   */
  #mountList<T>(container: HTMLElement | null, scrollKey: string, items: readonly T[], rowHeightPx: number, renderRow: (item: T) => HTMLElement): VirtualList<T> | null {
    if (!container) return null;
    return new VirtualList<T>({
      container,
      items,
      rowHeightPx,
      renderRow,
      initialScrollTop: this.#listScrollTop[scrollKey],
      onScroll: (top) => (this.#listScrollTop[scrollKey] = top),
    });
  }

  // ---- Image list ---------------------------------------------

  #mountImageList(images: CIFImage[]): void {
    // [Redesign 2a] The row stacks three lines in `.bindery-row-name-wrap`
    // (name + meta + journal group) next to a 48px-tall thumbnail — the
    // height was chosen empirically for this layout (see `bindery.css`,
    // "Image table" section).
    this.#imageList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="images"]'), 'images', images, 80, (image) => this.#imageRows.buildImageRow(image));
  }

  /** Ids of the images in the ACTIVE tab (source + destination sub-tab) — what the bulk buttons above the list are allowed to touch. Images sitting in other tabs are not visible, so they must not be changed silently. */
  #activeTabImageIds(): Set<string> {
    return new Set(this.#visibleImages().map((i) => i.id));
  }

  static #onSelectAllImages(this: ReviewScreen): void {
    this.#selection.selectAllImages(this.#activeTabImageIds());
    void this.render();
  }
  static #onSelectNoImages(this: ReviewScreen): void {
    this.#selection.selectNoImages(this.#activeTabImageIds());
    void this.render();
  }

  // Journals (full book text) now start
  // unchecked (see `ReviewSelection.fromDocument`) — these two buttons are
  // an explicit bulk opt-in, so a user who ACTUALLY wants full-text journals
  // doesn't have to click every chapter individually.
  static #onSelectAllJournals(this: ReviewScreen): void {
    this.#selection.setAllJournals(true);
    void this.render();
  }
  static #onSelectNoJournals(this: ReviewScreen): void {
    this.#selection.setAllJournals(false);
    void this.render();
  }

  /**
   * [Redesign 2a] The doc merges two former buttons ("Set destination for
   * selected" + "Set journal group for selected") into one — the
   * destination is ALWAYS set (the `<select>` always has some value), the
   * journal group ONLY when the field isn't empty (see README: don't clear
   * the journal group of selected images just because someone clicked
   * "Apply" without typing anything into that field).
   */
  static #onApplyBulkSettings(this: ReviewScreen): void {
    // [User request] The bulk menu acts ONLY on the selected images of the
    // active tab — computed BEFORE the destination changes (which moves images
    // to another tab), and reused for the journal group below.
    const scope = this.#activeTabImageIds();
    const select = this.element.querySelector<HTMLSelectElement>('[data-select="bulkDestination"]');
    if (select) {
      this.#bulkDestinationValue = select.value as ImageDestination;
      this.#selection.setDestinationForSelected(this.#bulkDestinationValue, scope);
    }
    const input = this.element.querySelector<HTMLInputElement>('[data-input="bulkJournalGroup"]');
    if (input && input.value.trim() !== '') {
      this.#selection.setJournalGroupForSelected(input.value, scope);
      this.#bulkJournalGroupValue = '';
    }
    void this.render();
  }

  /**
   * Restores the last choice in the bulk
   * operations bar (`bulkDestination`/`bulkJournalGroup`) AFTER every mount
   * of the Images tab — see the comment next to `#bulkDestinationValue`
   * above for why, without this, the choice was silently lost on every page
   * preview navigation.
   */
  #wireBulkImageControls(): void {
    const destSelect = this.element.querySelector<HTMLSelectElement>('[data-select="bulkDestination"]');
    if (destSelect) {
      destSelect.value = this.#bulkDestinationValue;
      destSelect.addEventListener('change', () => {
        this.#bulkDestinationValue = destSelect.value as ImageDestination;
      });
    }
    const groupInput = this.element.querySelector<HTMLInputElement>('[data-input="bulkJournalGroup"]');
    if (groupInput) {
      groupInput.value = this.#bulkJournalGroupValue;
      groupInput.addEventListener('input', () => {
        this.#bulkJournalGroupValue = groupInput.value;
      });
    }
  }

  /**
   * [Bug fix — whole-design review] The previous version targeted
   * `.bindery-review-counts` — a class that never existed in
   * `review-screen.hbs`/`bindery.css` (probably a relic from before
   * "redesign 2a"), so `querySelector` always returned `null` and the whole
   * update was a silent no-op: the "N selected" counter in the step bar
   * froze after every checkbox (de)selection, until an incidental full
   * render. `data-count="images"` on the correct `<span>` (see the
   * template) is the only place that actually shows this counter.
   */
  /** Everything currently selected for import — images, scenes and journals. */
  #totalSelectedCount(): number {
    return this.#selection.selectedAssignedImageCount + this.#selection.selectedSceneCount + this.#selection.selectedJournalCount + (this.#statblocks?.includedCount ?? 0);
  }

  /**
   * [Bug fix, user report] The footer ("Ready to import: N" + the Next button)
   * was rendered only on a full `render()`, so ticking/unticking a checkbox
   * left it stale: after deselecting everything Next stayed enabled (and the
   * import created nothing), and after selecting one image again it stayed
   * disabled until the page changed. Called from every selection change that
   * doesn't re-render.
   */
  /** "Ready to import: N", or — when something is selected but nothing can be imported — why (selected images without a destination). */
  #footerHintText(total: number): string {
    if (total > 0) return game.i18n!.format('BINDERY.review.footerHintReady' as never, { n: String(total) });
    if (this.#selection.selectedImageCount > 0) return game.i18n!.localize('BINDERY.review.footerHintUnassigned' as never);
    return game.i18n!.localize('BINDERY.review.footerHintEmpty' as never);
  }

  #refreshFooter(): void {
    const total = this.#totalSelectedCount();
    const hint = this.element.querySelector<HTMLElement>('.bindery-footer-hint');
    if (hint) {
      hint.textContent = this.#footerHintText(total);
    }
    const next = this.element.querySelector<HTMLButtonElement>('button[data-action="proceedToTarget"]');
    if (next) next.disabled = total === 0;
  }

  async #refreshHeaderCounts(): Promise<void> {
    this.#refreshFooter();
    const el = this.element.querySelector<HTMLElement>('[data-count="images"]');
    if (!el) return;
    el.textContent = `${this.#selection.selectedImageCount} / ${this.#data.document.images.length} ${game.i18n!.localize('BINDERY.review.images' as never)}`;
  }

  /**
   * ↑/↓ move the highlighted image through the visible list. The listeners sit on the document rather than on the
   * window: a re-render or the list recycling its rows removes the focused element, and the focus then falls to the page
   * body, outside the window — the keys would be lost and Foundry would pan the canvas with them. They are used only
   * while the last click was inside this window, and a key used here goes no further (neither its press nor its release),
   * because Foundry pans the canvas with the arrow keys.
   */
  #installArrowKeys(): void {
    if (this.#arrowKeyHandlers !== null) return;
    // Clicking a row or the page lands the focus on the window itself, so keys typed right after reach it too.
    this.element.tabIndex = -1;
    this.element.style.outline = 'none';
    this.#keysBelongToWindow = true;
    const usesKey = (ev: KeyboardEvent): boolean => {
      if ((ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || !this.#keysBelongToWindow || !this.#imageList) return false;
      const target = ev.target instanceof HTMLElement ? ev.target : null;
      // Typing somewhere else (another window, the sidebar) is none of this window's business; the page body is where the focus lands when ours is lost.
      if (target !== null && target !== document.body && !this.element.contains(target)) return false;
      // Inside a field, an arrow key belongs to the field (a list's options, a number's step, a caret).
      return !(target?.closest('select, textarea, [contenteditable="true"]') || (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'button'));
    };
    const onPointerDown = (ev: PointerEvent): void => {
      this.#keysBelongToWindow = ev.target instanceof Node && this.element.contains(ev.target);
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (!usesKey(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      void this.#stepHighlightedImage(ev.key === 'ArrowDown' ? 1 : -1);
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (usesKey(ev)) ev.stopPropagation();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    this.#arrowKeyHandlers = { onPointerDown, onKeyDown, onKeyUp };
  }

  #removeArrowKeys(): void {
    if (this.#arrowKeyHandlers === null) return;
    document.removeEventListener('pointerdown', this.#arrowKeyHandlers.onPointerDown, true);
    document.removeEventListener('keydown', this.#arrowKeyHandlers.onKeyDown, true);
    document.removeEventListener('keyup', this.#arrowKeyHandlers.onKeyUp, true);
    this.#arrowKeyHandlers = null;
  }

  /** Moves the highlight to the next (`1`) or previous (`-1`) image of the visible list, bringing its page and its row into view. Nothing highlighted yet: starts at the first image. */
  async #stepHighlightedImage(delta: 1 | -1): Promise<void> {
    const images = this.#visibleImages();
    if (images.length === 0) return;
    const current = images.findIndex((i) => i.id === this.#highlightedImageId);
    const index = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), images.length - 1);
    const image = images[index]!;
    this.#highlightedImageId = image.id;
    if (this.#currentPageNumber === image.provenance.pageNumber) {
      this.#refreshImageRowHighlights();
      void this.#overlay.redrawOverlay();
    } else {
      this.#currentPageNumber = image.provenance.pageNumber;
      await this.render();
    }
    this.#imageList?.scrollToIndex(index);
  }

  /** Updates the highlight class on the already-rendered image list rows, without a full `render()` (see `#redrawOverlay`). */
  #refreshImageRowHighlights(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('.bindery-image-row');
    for (const row of rows) {
      row.classList.toggle('bindery-row-highlighted', row.dataset['imageId'] === this.#highlightedImageId);
    }
  }

  // ---- Scene list ---------------------------------------------------------

  #mountSceneList(): void {
    this.#sceneList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="scenes"]'), 'scenes', this.#data.document.scenes, 48, (scene) => this.#buildSceneRow(scene));
  }

  #buildSceneRow(scene: CIFScene): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#selection.isSceneSelected(scene.id);
    checkbox.addEventListener('change', () => this.#selection.setScene(scene.id, checkbox.checked));
    row.appendChild(checkbox);
    const label = document.createElement('span');
    label.className = 'bindery-row-label';
    label.textContent = `${scene.name} — ${pageRef(scene.provenance.pageNumber)}`;
    row.appendChild(label);
    return row;
  }

  // ---- Journal tree ------------------------------------------------

  #mountJournalList(): void {
    this.#journalList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="journals"]'), 'journals', this.#journalRows, 40, (row) => this.#buildJournalRow(row));
  }

  #buildJournalRow(row: JournalRow): HTMLElement {
    const el = document.createElement('div');
    el.className = row.kind === 'journal' ? 'bindery-review-row bindery-journal-header-row' : 'bindery-review-row bindery-journal-page-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    if (row.kind === 'journal') {
      checkbox.checked = this.#selection.isJournalSelected(row.journal.id);
      checkbox.addEventListener('change', () => {
        this.#selection.setJournal(row.journal.id, checkbox.checked);
        for (const page of row.journal.pages) this.#selection.setJournalPage(page.id, checkbox.checked);
        void this.render();
      });
    } else {
      checkbox.checked = this.#selection.isJournalPageSelected(row.pageId!);
      checkbox.addEventListener('change', () => this.#selection.setJournalPage(row.pageId!, checkbox.checked));
    }
    el.appendChild(checkbox);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input';
    nameInput.value = row.kind === 'journal' ? row.journal.name : row.pageName!;
    nameInput.addEventListener('change', () => {
      if (row.kind === 'journal') row.journal.name = nameInput.value;
      else {
        const page = row.journal.pages.find((p) => p.id === row.pageId);
        if (page) page.name = nameInput.value;
      }
    });
    el.appendChild(nameInput);

    return el;
  }

  // ---- Diagnostics -----------------------------------------------------

  #mountDiagnosticList(container: HTMLElement | null, diagnostics?: readonly Diagnostic[]): void {
    if (!container) return;
    const groups = diagnostics ? this.#groupDiagnostics(diagnostics) : this.#diagnosticGroups;
    // [User request] The same controller mounted for TWO different
    // containers (the Diagnostics tab and the Summary step) — `data-list`
    // (already used by the caller to find `container`) as the scroll
    // tracking key, so both lists have THEIR OWN, independent memory.
    const key = container.dataset['list'] ?? 'diagnostics';
    this.#diagnosticList = this.#mountList(container, key, groups, 32, (group) => this.#buildDiagnosticRow(group));
  }

  #groupDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticGroup[] {
    const byCode = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      const arr = byCode.get(d.code) ?? [];
      arr.push(d);
      byCode.set(d.code, arr);
    }
    return [...byCode.entries()].map(([code, examples]) => ({ code, severity: examples[0]!.severity, count: examples.length, examples: examples.slice(0, 20) }));
  }

  #buildDiagnosticRow(group: DiagnosticGroup): HTMLElement {
    const row = document.createElement('div');
    row.className = `bindery-review-row bindery-diagnostic-row bindery-diagnostic-${group.severity}`;
    const label = document.createElement('span');
    label.textContent = `[${group.severity}] ${group.code} × ${group.count}`;
    row.appendChild(label);
    const firstPage = group.examples.find((d) => d.pageNumber !== undefined)?.pageNumber;
    if (firstPage !== undefined && this.#step === 'review') {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = pageRef(firstPage);
      jump.addEventListener('click', () => {
        this.#currentPageNumber = firstPage;
        this.#tab = 'images';
        void this.render();
      });
      row.appendChild(jump);
    }
    return row;
  }

  // ---- Tabs / step -----------------------------------------------

  static #onSwitchTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const tab = target.dataset['tab'] as ReviewTab | undefined;
    if (!tab) return;
    this.#tab = tab;
    if (tab === 'statblocks') void this.#ensureStatblocks();
    void this.render();
  }

  /** What the tab's counter shows: "…" while detection runs, "–" when there is nothing to count yet (no profile selected), else the number of statblocks ticked for import. */
  #statblockCountLabel(): string {
    const state = this.#statblocks;
    if (!state || state.busy) return '…';
    return state.rows === null ? '–' : String(state.includedCount);
  }

  /** Creates the Statblocks tab's state and starts detection — once, even if the tab is opened while the background start is still loading. */
  #ensureStatblocks(): Promise<void> {
    const fileBuffer = this.#data.fileBuffer;
    if (!STATBLOCK_IMPORT_ENABLED || !fileBuffer) return Promise.resolve();
    this.#statblocksStarting ??= (async () => {
      const { StatblockReviewState } = await import('../statblock/ui/statblockReviewState.js');
      this.#statblocks = new StatblockReviewState(fileBuffer, this.#data.document.images.filter((i) => i.holdsText !== true), () => void this.render());
      await this.render();
      await this.#statblocks.init();
    })();
    return this.#statblocksStarting;
  }

  /** Wires the Statblocks tab's controls — the DOM is replaced on every render, so this runs after each one. */
  #wireStatblockControls(): void {
    const state = this.#statblocks;
    if (!state || this.#tab !== 'statblocks') return;
    const root = this.element;
    const profileSelect = root.querySelector<HTMLSelectElement>('select[data-sb="profile"]');
    profileSelect?.addEventListener('change', () => void state.selectProfile(profileSelect.value));
    const policySelect = root.querySelector<HTMLSelectElement>('select[data-sb="policy"]');
    policySelect?.addEventListener('change', () => (state.policy = policySelect.value as typeof state.policy));
    for (const box of root.querySelectorAll<HTMLInputElement>('input[data-sb-include]')) {
      box.addEventListener('change', () => {
        state.setInclude(box.dataset['sbInclude']!, box.checked);
        void this.render();
      });
    }
    for (const select of root.querySelectorAll<HTMLSelectElement>('select[data-sb-image]')) {
      select.addEventListener('change', () => {
        state.setImage(select.dataset['sbImage']!, select.value);
        void this.render();
      });
    }
  }

  static #onSwitchImageSourceTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const source = target.dataset['source'] as ImageSourceTab | undefined;
    if (!source) return;
    this.#imageSourceTab = source;
    void this.render();
  }

  static #onSwitchImageDestTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const dest = target.dataset['dest'] as ImageDestTab | undefined;
    if (!dest) return;
    this.#imageDestTab = dest;
    void this.render();
  }

  static #onCancelReview(this: ReviewScreen): void {
    void this.close();
  }

  static #onProceedToTarget(this: ReviewScreen): void {
    if (this.#totalSelectedCount() === 0) return;
    this.#step = 'target';
    void this.render();
  }

  static #onBackToReview(this: ReviewScreen): void {
    this.#step = 'review';
    void this.render();
  }

  #wireTargetInputs(): void {
    if (this.#step !== 'target') return;
    const sceneFolder = this.element.querySelector<HTMLInputElement>('input[name="sceneFolder"]');
    const journalFolder = this.element.querySelector<HTMLInputElement>('input[name="journalFolder"]');
    const imagePath = this.element.querySelector<HTMLInputElement>('input[name="imagePath"]');
    const namePrefix = this.element.querySelector<HTMLInputElement>('input[name="namePrefix"]');
    sceneFolder?.addEventListener('change', () => (this.#targets.sceneFolder = sceneFolder.value));
    journalFolder?.addEventListener('change', () => (this.#targets.journalFolder = journalFolder.value));
    namePrefix?.addEventListener('change', () => (this.#targets.namePrefix = namePrefix.value));
    if (imagePath) {
      imagePath.value = game.settings!.get(MODULE_ID, 'uploadPath') as string;
      imagePath.addEventListener('change', () => void game.settings!.set(MODULE_ID, 'uploadPath', imagePath.value));
    }
  }

  // ---- Import --------------------------------------------------------

  static async #onConfirmImport(this: ReviewScreen): Promise<void> {
    // The button is disabled only after the next render: a second click before that must not start a second import.
    if (this.#isImporting) return;
    this.#isImporting = true;
    this.#importError = null;
    await this.render();

    try {
      await game.settings!.set(MODULE_ID, 'importTargets', { ...this.#targets });
      const summary = await runReviewImport({
        document: this.#data.document,
        imageBytesById: this.#data.imageBytesById,
        fileName: this.#data.fileName,
        targets: this.#targets,
        selection: this.#selection,
        progress: this.#importProgress,
        handEditedImageIds: this.#handEditedImageIds,
        statblocks: this.#statblocks,
      });
      this.#summaryEntries = summary.entries;
      this.#summaryDiagnostics = summary.diagnostics;
      this.#settled = true;
      this.#resolve?.({ confirmed: true, createdCount: summary.entries.length, errorCount: summary.diagnostics.filter((d) => d.severity === 'error').length });
      this.#step = 'summary';
    } catch (err) {
      this.#importError = game.i18n!.localize('BINDERY.review.importErrorGeneric');
      console.warn('Bindery | import from the review screen failed:', err);
    } finally {
      this.#isImporting = false;
      await this.render();
    }
  }

  static #onCloseReview(this: ReviewScreen): void {
    void this.close();
  }

  static #onOpenDocument(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const uuid = target.dataset['uuid'];
    if (!uuid) return;
    void (async () => {
      const doc = await fromUuid(uuid);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc as any)?.sheet?.render(true);
    })();
  }
}
