import type { CIFDocument, CIFImage, CIFScene, CIFJournal, CIFActor, AdapterResult, Diagnostic, PreviewDocument, Rect, RotatedRect, RegionCrop } from '@bindery/core';
import { classifyTargetKind, pdfRectToScreen, screenRotatedRectToPdf, rotatedRectBounds, inscribedRotatedRectScale, DEFAULT_WEBP_QUALITY } from '@bindery/core';
import { MODULE_ID, type ImportTargets } from '../settings.js';
import { ReviewSelection, defaultImageDestination, sortImagesForReview, type ImageDestination } from '../review/selectionState.js';
import { ActorReviewSelection, computeActorCompleteness, applyActorOverrides } from '../review/actorSelectionState.js';
import { VirtualList } from '../review/VirtualList.js';
import { uploadImage } from '../documents/uploadImages.js';
import { createSceneFromImage } from '../documents/createSceneFromImage.js';
import { createJournalsFromCIF, type CIFJournalForCreation } from '../documents/createJournalFromCIF.js';
import { createJournalHandoutFromImage } from '../documents/createJournalHandoutFromImage.js';
import { createJournalHandoutFromImages } from '../documents/createJournalHandoutFromImages.js';
import { createActorsFromAdapterResults } from '../documents/createActors.js';
import { coc7Adapter, type Coc7ActorPayload } from '../adapters/coc7.js';
import { ensureFolder } from '../documents/ensureFolder.js';
import { pickGrid, type GridConfig } from './GridPicker.js';
import { prepareToken } from './TokenPrepApp.js';
import { eraseImage } from './ImageEraseApp.js';
import { STATBLOCKS_ENABLED } from '../features.js';
import { localizeMessage } from '../i18n.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** [Step 17] Below this threshold, the grid auto-detection suggestion (`detectGrid.ts`) is too weak to guess anything from — see `#pickGridForImage`. */
const MIN_GRID_SUGGESTION_CONFIDENCE = 0.4;

/**
 * [Step 20, at user request] Core's auto-detection of "this is a whole
 * scene/map" (`doc.scenes`, CIFScene) and "this is the full book text as a
 * journal" (`doc.journals`, CIFJournal from the PDF bookmark hierarchy) is
 * disabled "for now" — a flag instead of removing the code, so it can be
 * restored easily later. The "Scenes"/"Journals" tabs are hidden in
 * `review-screen.hbs`; the same flag skips their creation in `#runImport`
 * (without this, images used by `doc.scenes` would be "used" — see
 * `usedImageIds` — despite the hidden tab, and would NOT reach the Images
 * tab as a normal Destination choice). The same images are still available
 * in the Images tab with a Scene/Journal Destination, handled per-image
 * instead of through this pipeline.
 */
const SCENES_JOURNALS_FROM_CIF_ENABLED = false;

type ReviewTab = 'images' | 'scenes' | 'journals' | 'actors' | 'diagnostics';
type ReviewStep = 'review' | 'target' | 'summary';
/** [User request, "two tabs: automatic and manual"] Image source — PURELY a presentational split of the Images tab list, not a new `CIFImage` field: `manual` is recognized by the `id` prefix (`manual-crop-`, see `#createManualCrop`). */
type ImageSourceTab = 'auto' | 'manual';
/** [User request] Sub-tab WITHIN each `ImageSourceTab` — filters by the ALREADY existing `ReviewSelection.imageDestination` (the same choice as the per-row "Destination" dropdown), not new state. */
type ImageDestTab = ImageDestination;

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
  /** [Step 42 Z1] Starting value of the "remove background" toggle in `TokenPrepApp` — see `images.removeTokenBackgroundDefault` in `schema.ts` (`@bindery/core`). */
  removeTokenBackgroundDefault?: boolean;
}

export interface ReviewScreenResult {
  confirmed: boolean;
}

/**
 * [Step 11] Review screen (phase 9) — split-pane ApplicationV2, virtualized
 * lists (Z2), page preview + bbox overlays (Z3), selection model (Z4), a
 * read-only journal tree (Z5), the target screen (Z6), the diagnostics panel
 * (Z7). PURE presentation/selection over an already-built `CIFDocument` —
 * zero decision logic (classification/CIF is built EXCLUSIVELY in
 * `packages/core`, check:boundary A1).
 *
 * Opened dynamically (see `ImportWizard.ts`) — NOT statically imported from
 * `main.ts`, so as not to burden the <40KB world-startup budget (I3).
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
      selectAllActors: ReviewScreen.#onSelectAllActors,
      selectNoActors: ReviewScreen.#onSelectNoActors,
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
        '[data-list="actors"]',
        '[data-list="scenes"]',
        '[data-list="journals"]',
        '[data-list="diagnostics"]',
        '[data-list="summaryDiagnostics"]',
      ],
    },
  };

  static open(data: ReviewScreenData): Promise<ReviewScreenResult> {
    return new Promise((resolve) => {
      const app = new ReviewScreen(data);
      app.#resolve = resolve;
      void app.render(true);
    });
  }

  #data: ReviewScreenData;
  #selection: ReviewSelection;
  #resolve: ((result: ReviewScreenResult) => void) | null = null;
  #settled = false;

  #step: ReviewStep = 'review';
  #tab: ReviewTab = 'images';
  /** [User request] Sub-tabs WITHIN the Images tab — see `ImageSourceTab`/`ImageDestTab`. */
  #imageSourceTab: ImageSourceTab = 'auto';
  // [User request, "all images end up in Unassigned"]
  // The default sub-tab is now `unassigned` (not `scene`) — since EVERY
  // image starts with this destination, opening on "Scene" would show an
  // empty list every time.
  #imageDestTab: ImageDestTab = 'unassigned';

  #currentPageNumber = 1;
  #pageImageCache = new Map<number, string>();
  #pageImageOrder: number[] = [];
  static readonly #PAGE_CACHE_SIZE = 5;
  #pageRenderToken = 0;

  /** [Step 11 Z3] Id of the image highlighted by a click ON THE LIST OR on the bbox overlay — works both ways. */
  #highlightedImageId: string | null = null;
  #overlayImages: readonly CIFImage[] = [];

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

  // ---- [Step 18] "Select and crop" — manual selection of a page fragment --------
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
  /** Confirm/cancel bar element added DYNAMICALLY to `.bindery-page-canvas-wrap` (like `rectEl` in `#dragState` — it's not in the Handlebars markup) — kept here so it can be removed on confirm/cancel/page change. */
  #pendingCropToolbar: HTMLElement | null = null;
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
   * [Step 19, bug reported live: "I pick Journal and change page, and it
   * reverts to Scene"] The bulk-operations bar (`bulkDestination`/
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
  #thumbnailUrls = new Map<string, string>();
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

  // ---- [Step 20 Z2] Actors tab --------------------------------------
  #actorSelection: ActorReviewSelection;
  /** [Step 20 Z3] Id of the actor highlighted by a click on the list OR on the bbox overlay — mirrors `#highlightedImageId`. */
  #highlightedActorId: string | null = null;
  /**
   * [Step 20 Z2] `coc7Adapter.fromActor` computed OVER THE DATA BEING
   * REVIEWED (user overrides already applied via `applyActorOverrides`) —
   * SOLELY for the `notes`/`issues` PREVIEW on this screen (A3/A10: "unparsed
   * fields stay visible, never hidden"). `#runImport` computes its OWN,
   * independent result right before saving (on the freshest `#actorSelection`
   * state) — this map is PURELY a display cache, never the source of truth
   * for the import.
   */
  #actorAdapterPreview = new Map<string, AdapterResult<Coc7ActorPayload>>();

  #targets: ImportTargets;
  #isImporting = false;
  #importError: string | null = null;
  #summaryEntries: { label: string; uuid?: string }[] = [];
  #summaryDiagnostics: Diagnostic[] = [];

  constructor(data: ReviewScreenData) {
    super();
    this.#data = data;
    this.#selection = ReviewSelection.fromDocument(data.document);
    this.#actorSelection = ActorReviewSelection.fromDocument(data.document);
    this.#rebuildJournalRows();
    this.#rebuildDiagnosticGroups();
    this.#rebuildActorAdapterPreview();
    const stored = game.settings!.get(MODULE_ID, 'importTargets') as ImportTargets;
    // [Step 19 Z3] `actorFolder` can be `undefined` in settings saved
    // BEFORE this step (the old default object didn't have this field) —
    // this screen doesn't (yet) manage actors, so a defensive fallback is
    // enough, so as not to break `ImportTargets` on older worlds.
    this.#targets = { sceneFolder: stored.sceneFolder, journalFolder: stored.journalFolder, actorFolder: stored.actorFolder ?? '', namePrefix: stored.namePrefix };
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

  /**
   * [Step 20 Z2] Recomputes the PREVIEW `notes`/`issues` for ALL actors,
   * over the data AFTER user overrides (`applyActorOverrides`) — called
   * after every edit of a name/value/attack, so the notes list in the row
   * reflects what the user JUST changed (A3/A10: an actor hiding its own
   * uncertainty is "faster to review and less safe" — MDD P6, a warning
   * stated explicitly in this step).
   */
  #rebuildActorAdapterPreview(): void {
    this.#actorAdapterPreview.clear();
    for (const actor of this.#data.document.actors ?? []) {
      const patched = applyActorOverrides(actor, this.#actorSelection);
      const ctx = { folderId: null, imagePathResolver: () => null, language: null, profileId: null };
      // `coc7Adapter` is typed as `SystemAdapter` (contract §5.6, `fromActor` returns `AdapterResult<object>`)
      // — a safe cast to the concrete shape of OUR OWN implementation (`coc7.ts`), the same as `createActors.ts` already does.
      this.#actorAdapterPreview.set(actor.id, coc7Adapter.fromActor(patched, ctx) as AdapterResult<Coc7ActorPayload>);
    }
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

  /** The Images list AFTER both levels of filtering (source + destination), in the same order as `sortImagesForReview` — the only thing `#mountImageList`/`#mountOverlay` actually see. */
  #visibleImages(): CIFImage[] {
    return sortImagesForReview(this.#data.document.images).filter(
      (i) => (ReviewScreen.#isManualImage(i) ? 'manual' : 'auto') === this.#imageSourceTab && this.#selection.imageDestination(i.id) === this.#imageDestTab,
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
    const counts: Record<ImageDestTab, number> = { scene: 0, journal: 0, token: 0, unassigned: 0 };
    for (const image of this.#data.document.images) {
      if ((ReviewScreen.#isManualImage(image) ? 'manual' : 'auto') !== this.#imageSourceTab) continue;
      counts[this.#selection.imageDestination(image.id)]++;
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
      // [Step 44 Z1] See `features.ts` — the first public release covers
      // images only. The Actors tab is hidden in the template
      // (`{{#if statblocksEnabled}}`), so `this.#tab` can never actually
      // become `'actors'` via the UI, but the context passes the flag
      // through explicitly anyway instead of relying on that indirectly.
      statblocksEnabled: STATBLOCKS_ENABLED,
      isTabImages: this.#tab === 'images',
      isTabScenes: this.#tab === 'scenes',
      isTabJournals: this.#tab === 'journals',
      isTabActors: this.#tab === 'actors',
      isTabDiagnostics: this.#tab === 'diagnostics',
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
      imageDestSceneCount: destCounts.scene,
      imageDestJournalCount: destCounts.journal,
      imageDestTokenCount: destCounts.token,
      imageDestUnassignedCount: destCounts.unassigned,
      imageCount: doc.images.length,
      sceneCount: doc.scenes.length,
      journalCount: doc.journals.length,
      actorCount: doc.actors?.length ?? 0,
      // [Step 21 Z1] `doc.actors === undefined` means no profile was passed
      // when building this document (see `buildCIFFromDocument`, `profile`
      // is optional) — distinct from "there was a profile, but it found
      // nothing" (`doc.actors === []`, `hasActorProfile` is `true` then).
      // The distinction is needed so the Actors tab can explain to the user
      // WHAT happened instead of just showing an empty list for no reason.
      hasActorProfile: doc.actors !== undefined,
      diagnosticGroupCount: this.#diagnosticGroups.length,
      selectedImageCount: this.#selection.selectedImageCount,
      importableImageCount: this.#selection.selectedAssignedImageCount,
      hasUnassignedSelection: this.#selection.selectedImageCount > this.#selection.selectedAssignedImageCount,
      selectedSceneCount: this.#selection.selectedSceneCount,
      selectedJournalCount: this.#selection.selectedJournalCount,
      selectedActorCount: this.#actorSelection.selectedCount,
      // [User request, "can't import an NPC without a token, the Next button
      // is greyed out"] The "Next" button on the review screen was gated
      // SOLELY on the `selectedImageCount` condition (see
      // `review-screen.hbs`) — an author wanting to import ONLY actors
      // (without selecting any image as token/scene/journal) had no way to
      // proceed, even though `selectedActorCount` was > 0. The sum of ALL
      // FOUR independent categories ("is there ANYTHING at all to import"),
      // not just images.
      totalSelectedCount: this.#totalSelectedCount(),
      currentPageNumber: this.#currentPageNumber,
      pageCount: this.#data.previewDocument.pageCount,
      canGoPrevPage: this.#currentPageNumber > 1,
      canGoNextPage: this.#currentPageNumber < this.#data.previewDocument.pageCount,
      currentPageImageUrl: this.#pageImageCache.get(this.#currentPageNumber) ?? null,
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
      _actors: doc.actors ?? [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    this.#hideThumbPreview();

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
        void this.#mountOverlay(context._sortedImages as CIFImage[]);
        this.#wireBulkImageControls();
      } else if (this.#tab === 'scenes') {
        this.#mountSceneList();
      } else if (this.#tab === 'journals') {
        this.#mountJournalList();
      } else if (this.#tab === 'actors') {
        void this.#ensurePageImage(this.#currentPageNumber);
        this.#mountActorList(context._actors as CIFActor[]);
        void this.#mountActorOverlay(context._actors as CIFActor[]);
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
    this.#hideThumbPreview();
    this.#imageList?.destroy();
    this.#sceneList?.destroy();
    this.#journalList?.destroy();
    this.#diagnosticList?.destroy();
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    for (const url of this.#thumbnailUrls.values()) URL.revokeObjectURL(url);
    await this.#data.previewDocument.destroy();
    if (!this.#settled) {
      this.#settled = true;
      this.#resolve?.({ confirmed: false });
    }
    return super.close(options);
  }

  // ---- Page preview (Z3) ----------------------------------------------

  async #ensurePageImage(pageNumber: number): Promise<void> {
    if (this.#pageImageCache.has(pageNumber)) return;
    const token = ++this.#pageRenderToken;
    try {
      const encoded = await this.#data.previewDocument.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' });
      if (token !== this.#pageRenderToken) return; // user has already moved on — discard the stale result
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded.bytes)], { type: 'image/webp' }));
      this.#pageImageCache.set(pageNumber, url);
      this.#pageImageOrder.push(pageNumber);
      while (this.#pageImageOrder.length > ReviewScreen.#PAGE_CACHE_SIZE) {
        const evict = this.#pageImageOrder.shift()!;
        const evictUrl = this.#pageImageCache.get(evict);
        if (evictUrl) URL.revokeObjectURL(evictUrl);
        this.#pageImageCache.delete(evict);
      }
      if (this.#tab === 'images' && this.#step === 'review') await this.render();
    } catch (err) {
      console.warn('Bindery | renderPage failed:', err);
    }
  }

  /** Redraws the overlay on the SAME (already loaded) page — without a full `render()`, so it doesn't lose the list's scroll position. `getPageBox` is cached in `PreviewDocument`, so this is cheap. */
  async #redrawOverlay(): Promise<void> {
    await this.#mountOverlay(this.#overlayImages);
  }

  async #mountOverlay(images: readonly CIFImage[]): Promise<void> {
    this.#overlayImages = images;
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    // [Bug fix — whole-design review] `_onRender` calls `#mountOverlay`
    // without `await` (deliberately — we don't want to block the render's
    // completion on loading the page geometry), so ANOTHER full render (e.g.
    // a second "next page" click before `getPageBox` below resolves) can
    // change `#currentPageNumber` BEFORE this `await` returns. Without this
    // guard flag, the overlay would draw rectangles computed for a page that
    // is NO LONGER current on top of the image of the CURRENT page — the
    // other (already in-flight) `#mountOverlay` will draw the correct
    // overlay right after anyway, so it's safe to simply skip drawing here.
    const requestedPageNumber = this.#currentPageNumber;
    const box = await this.#data.previewDocument.getPageBox(requestedPageNumber);
    if (this.#currentPageNumber !== requestedPageNumber) return;
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      // [Step 18, fix for reported bug "misses, it's shifted to the
      // right"] The overlay's CSS box MUST have exactly the same proportions
      // as the viewBox, otherwise SVG's default `preserveAspectRatio`
      // ("xMidYMid meet") adds invisible bars and centers/scales the SVG
      // content within its own box — `width:100%;height:100%` from CSS is
      // computed relative to `.bindery-page-canvas-wrap` (whose height is
      // constrained by layout), NOT relative to the actually rendered
      // `<img>` (which for a tall page is taller and scrollable), so the
      // proportions didn't match and the naive calculation in
      // `toOverlayPoint` (a simple `viewBox/rect`) gave a wrong result.
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const image of images) {
        if (image.provenance.pageNumber !== this.#currentPageNumber) continue;
        const screen = pdfRectToScreen(image.provenance.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const isHighlighted = image.id === this.#highlightedImageId;
        const classes = [this.#selection.isImageSelected(image.id) ? 'bindery-overlay-selected' : 'bindery-overlay-unselected'];
        if (isHighlighted) classes.push('bindery-overlay-highlighted');
        rect.setAttribute('class', classes.join(' '));
        rect.dataset['imageId'] = image.id;
        rect.addEventListener('click', () => {
          this.#highlightedImageId = image.id;
          this.#imageList?.scrollToIndex(images.findIndex((i) => i.id === image.id));
          this.#refreshImageRowHighlights();
          draw();
        });
        svg.appendChild(rect);
        // [User request, "the ability to resize an automatically found
        // image"] Handles appear SOLELY on the currently highlighted image
        // (the same mechanism as clicking a list row/rectangle — nothing new
        // to turn on) — reusing `#highlightedImageId` instead of a separate
        // mode.
        if (isHighlighted && !this.#pendingCrop) this.#renderResizeHandles(svg, image, rect, screen);
      }
      if (this.#pendingCrop && this.#pendingCropPageNumber !== this.#currentPageNumber) {
        // Safety net: switching to another page (◄/► navigation, clicking an
        // image/actor row on another page) should already have reset
        // `#pendingCrop` at the source — this is an extra safety net so we
        // don't ACCIDENTALLY crop a fragment of one page based on
        // coordinates drawn on a completely different one.
        this.#pendingCrop = null;
        this.#pendingCropPageNumber = null;
        this.#teardownPendingCropUi();
      }
      this.#renderPendingCropOverlay(svg);
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });

    this.#wireSelectDrag(svg, img, draw);
  }

  // ---- [Step 18] "Select and crop" ---------------------------------------

  static async #onToggleSelectMode(this: ReviewScreen): Promise<void> {
    this.#isSelectMode = !this.#isSelectMode;
    this.#dragState = null;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.render();
  }

  /**
   * Wires up mouse dragging ON `svg` (not on the overlay's individual
   * rectangles) — a `pointerdown` on a child bubbles up to the parent
   * anyway, so one set of listeners on the whole overlay is enough. The
   * `dataset['dragWired']` flag guards against re-wiring on EVERY call to
   * `#mountOverlay`/`#redrawOverlay` (clicking an existing rectangle
   * refreshes the overlay without a full `render()`, so the same `<svg>`
   * element can pass through `#mountOverlay` multiple times) — the `<svg>`
   * element SURVIVES `svg.innerHTML = ''` in `draw()` (which only clears its
   * children), so a flag on the element itself is a safe, persistent marker.
   */
  #wireSelectDrag(svg: SVGSVGElement, img: HTMLImageElement, redraw: () => void): void {
    if (svg.dataset['dragWired']) return;
    svg.dataset['dragWired'] = '1';

    // The Foundry window's size (and hence the rendered <img>'s) can change
    // AFTER the first `draw()` (dragging/resizing the ApplicationV2 window)
    // — without this, the overlay would stay at the old size and
    // letterboxing/misalignment would return on every window resize.
    new ResizeObserver(() => redraw()).observe(img);

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.#isSelectMode || this.#isCropping || this.#pendingCrop || e.button !== 0) return;
      e.preventDefault();
      const start = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('class', 'bindery-select-drag-rect');
      rectEl.setAttribute('x', String(start.x));
      rectEl.setAttribute('y', String(start.y));
      rectEl.setAttribute('width', '0');
      rectEl.setAttribute('height', '0');
      svg.appendChild(rectEl);
      this.#dragState = { startScreen: start, rectEl };
      svg.setPointerCapture(e.pointerId);
    });

    svg.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      const cur = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });

    const MIN_DRAG_PX = 8; // below this we treat it as an accidental click, not a deliberate selection
    const finishDrag = (e: PointerEvent): void => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      this.#dragState = null;
      rectEl.remove();
      const cur = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      const screenRect: Rect = {
        minX: Math.min(startScreen.x, cur.x),
        maxX: Math.max(startScreen.x, cur.x),
        minY: Math.min(startScreen.y, cur.y),
        maxY: Math.max(startScreen.y, cur.y),
      };
      if (screenRect.maxX - screenRect.minX < MIN_DRAG_PX || screenRect.maxY - screenRect.minY < MIN_DRAG_PX) return;
      // [User request, "rotate the selected area before cropping"]
      // We no longer crop right away — we move into a "rotation adjustment"
      // state (handle + confirm/cancel bar), see `#pendingCrop`.
      this.#pendingCrop = {
        centerX: (screenRect.minX + screenRect.maxX) / 2,
        centerY: (screenRect.minY + screenRect.maxY) / 2,
        width: screenRect.maxX - screenRect.minX,
        height: screenRect.maxY - screenRect.minY,
        rotationRad: 0,
      };
      this.#pendingCropPageNumber = this.#currentPageNumber;
      this.#renderPendingCropOverlay(svg);
      const wrap = svg.closest<HTMLElement>('.bindery-page-canvas-wrap');
      if (wrap) this.#showPendingCropToolbar(wrap);
    };
    svg.addEventListener('pointerup', finishDrag);
    svg.addEventListener('pointercancel', finishDrag);
  }

  /**
   * [User request, "the area is shifted to the right relative to the
   * cursor"] `rect` is the WHOLE `<svg>` box — the FRAME's size
   * (`img.clientWidth/Height`, see the comment next to
   * `.bindery-page-canvas-wrap`), NOT the size of the actually visible
   * (letterboxed) content. The `viewBox`'s default
   * `preserveAspectRatio="xMidYMid meet"` scales ITS OWN CONTENT (the
   * overlay rectangles) to the LARGEST fragment of `rect` with the
   * `viewBox`'s proportions, CENTERED — exactly what `object-fit: contain`
   * does to the `<img>` itself (hence the empty bars visible on screen
   * whenever the PDF page's proportions aren't EXACTLY 3:4). The overlay
   * rectangles (drawn in `viewBox` units) therefore land correctly — the
   * same SVG mechanism positions them. A naive `vb.width/rect.width`
   * division (without this same correction) assumed the content fills the
   * WHOLE `rect`, so EVERY click/drag was offset by half the width of the
   * letterboxing bar — a small but real shift to the right (or downward) on
   * every page whose proportions aren't exactly 3:4 (i.e. almost every
   * page). When zoomed (`bindery-zoomed`, `object-fit:none`, `<img>` scaled
   * by width only) `rect` and `viewBox` have the same proportions by
   * definition — the formula below then degenerates to the old (correct in
   * that case) behavior.
   */
  #toOverlayPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (rect.width <= 0 || rect.height <= 0 || vb.width <= 0 || vb.height <= 0) {
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    const rectAspect = rect.width / rect.height;
    const vbAspect = vb.width / vb.height;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (vbAspect > rectAspect) {
      contentHeight = rect.width / vbAspect;
      offsetY = (rect.height - contentHeight) / 2;
    } else if (vbAspect < rectAspect) {
      contentWidth = rect.height * vbAspect;
      offsetX = (rect.width - contentWidth) / 2;
    }
    const scaleX = vb.width / contentWidth;
    const scaleY = vb.height / contentHeight;
    return { x: (clientX - rect.left - offsetX) * scaleX, y: (clientY - rect.top - offsetY) * scaleY };
  }

  /**
   * [User request, "rotate the selected area before cropping", drag handle]
   * Draws `#pendingCrop` as a `<g>` with `transform="rotate(deg cx cy)"`
   * (SVG's `rotate` uses EXACTLY the same matrix `[cos,-sin; sin,cos]` as
   * `screenRotatedRectToPdf` on the core side — so what's seen on screen is,
   * by definition, consistent with what actually gets cropped afterward).
   * The handle is a simple circle ABOVE the center of the top edge, in the
   * `<g>`'s LOCAL (unrotated) coordinate space — it rotates together with
   * the rectangle purely via the parent's transform, no separate algebra.
   * The handle's radius/offset are converted to `viewBox` units so that on
   * SCREEN it has a constant size regardless of the page's resolution/zoom
   * level (otherwise on a high-resolution page the handle would be
   * invisibly small).
   *
   * [rotation direction] `rotationRad = atan2(dy, dx) + PI/2` (where `dx,dy`
   * is the cursor vector relative to the center) — derived so that after
   * applying EXACTLY the same rotation matrix as SVG's `rotate()`, the
   * handle (locally straight ABOVE the center) lands EXACTLY under the
   * cursor: dragging the handle is therefore WYSIWYG on screen by
   * definition. Whether the final, PIXEL-cropped image rotates in the same
   * direction as the on-screen preview could NOT be verified without a live
   * test in Foundry (see `renderRotatedRegion.test.ts`) — if the live test
   * shows it's reversed, the only fix is to negate the angle HERE (in
   * `rotationRad = ...` below), not in the `core` layer.
   */
  #renderPendingCropOverlay(svg: SVGSVGElement): void {
    svg.querySelector('.bindery-pending-crop')?.remove();
    const pending = this.#pendingCrop;
    if (!pending) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = vb.width > 0 && svgRect.width > 0 ? vb.width / svgRect.width : 1;
    const HANDLE_OFFSET_SCREEN_PX = 32;
    const HANDLE_RADIUS_SCREEN_PX = 8;
    const handleOffset = HANDLE_OFFSET_SCREEN_PX * scale;
    const handleRadius = HANDLE_RADIUS_SCREEN_PX * scale;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'bindery-pending-crop');
    const deg = (pending.rotationRad * 180) / Math.PI;
    g.setAttribute('transform', `rotate(${deg} ${pending.centerX} ${pending.centerY})`);

    const rectEl = document.createElementNS(SVG_NS, 'rect');
    rectEl.setAttribute('x', String(pending.centerX - pending.width / 2));
    rectEl.setAttribute('y', String(pending.centerY - pending.height / 2));
    rectEl.setAttribute('width', String(pending.width));
    rectEl.setAttribute('height', String(pending.height));
    rectEl.setAttribute('class', 'bindery-pending-crop-rect');
    g.appendChild(rectEl);

    const topY = pending.centerY - pending.height / 2;
    const handleY = topY - handleOffset;

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(pending.centerX));
    line.setAttribute('y1', String(topY));
    line.setAttribute('x2', String(pending.centerX));
    line.setAttribute('y2', String(handleY));
    line.setAttribute('class', 'bindery-pending-crop-handle-line');
    g.appendChild(line);

    const handle = document.createElementNS(SVG_NS, 'circle');
    handle.setAttribute('cx', String(pending.centerX));
    handle.setAttribute('cy', String(handleY));
    handle.setAttribute('r', String(handleRadius));
    handle.setAttribute('class', 'bindery-pending-crop-handle');
    g.appendChild(handle);

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#pendingCrop || !handle.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      const pt = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      const angle = Math.atan2(pt.y - this.#pendingCrop.centerY, pt.x - this.#pendingCrop.centerX);
      this.#pendingCrop = { ...this.#pendingCrop, rotationRad: angle + Math.PI / 2 };
      // [User request, "it's very sluggish, only a few degrees at a time"]
      // The full `#renderPendingCropOverlay` must NOT be called here — it
      // REMOVES and RECREATES the `handle` (via `svg.querySelector(...)
      // .remove()` at the start), and removing an element from the DOM that
      // holds `setPointerCapture` silently releases that capture (the
      // browser automatically fires `lostpointercapture`). The newly
      // created `handle` does NOT have capture, so SUBSEQUENT `pointermove`
      // events (the cursor already far from its position) missed it
      // entirely — hence "only works a few degrees at a time" (one move =
      // one event before the handle got replaced). During dragging, ONLY
      // the rotation angle changes — the local geometry (rect/line/handle)
      // is constant — so it's enough to swap the `transform` on the
      // EXISTING `g`, without rebuilding the whole group/losing capture.
      const deg = (this.#pendingCrop.rotationRad * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${deg} ${this.#pendingCrop.centerX} ${this.#pendingCrop.centerY})`);
    });
    const releaseHandle = (e: PointerEvent): void => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointerup', releaseHandle);
    handle.addEventListener('pointercancel', releaseHandle);

    svg.appendChild(g);
  }

  /** Confirm/cancel bar added DYNAMICALLY to `.bindery-page-canvas-wrap` (like `rectEl`/`#pendingCrop` — it's not in the Handlebars markup, see `#pendingCropToolbar`). */
  #showPendingCropToolbar(wrap: HTMLElement): void {
    this.#pendingCropToolbar?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'bindery-pending-crop-toolbar';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'bindery-btn bindery-btn--primary';
    confirmBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeConfirmCrop' as never);
    confirmBtn.addEventListener('click', () => void this.#confirmPendingCrop());
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bindery-btn';
    cancelBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeCancelCrop' as never);
    cancelBtn.addEventListener('click', () => this.#cancelPendingCrop());
    toolbar.append(confirmBtn, cancelBtn);
    wrap.appendChild(toolbar);
    this.#pendingCropToolbar = toolbar;
  }

  #teardownPendingCropUi(): void {
    this.#pendingCropToolbar?.remove();
    this.#pendingCropToolbar = null;
  }

  async #confirmPendingCrop(): Promise<void> {
    const pending = this.#pendingCrop;
    if (!pending || this.#isCropping) return;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.#createManualCropRotated(pending);
  }

  #cancelPendingCrop(): void {
    if (!this.#pendingCrop) return;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    void this.#redrawOverlay();
  }

  /**
   * [User request, "the ability to resize an automatically found image — it's
   * too big/too small to manually enlarge or shrink"] Eight handles (4
   * corners + 4 edge midpoints) on the rectangle of the HIGHLIGHTED image —
   * works the same way for an automatically detected image and a manually
   * cropped one, because the fitting mechanism doesn't depend on the
   * image's source. Corners change both axes at once, edge midpoints only
   * one (`dx`/`dy` = -1 minX/minY, 0 = no change, +1 = maxX/maxY).
   *
   * [Lesson from an earlier bug in the same session, "the rotation handle
   * only works a few degrees at a time"] WHILE dragging, a full overlay
   * redraw must NOT be called (it destroys and recreates the handles from
   * scratch, silently losing `setPointerCapture`) — `updateAll` only
   * REPLACES the attributes of already existing elements (`rectEl` +
   * handles), so the same `<circle>` element holds capture throughout the
   * whole gesture.
   */
  #renderResizeHandles(svg: SVGSVGElement, image: CIFImage, rectEl: SVGRectElement, initialScreen: Rect): void {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = vb.width > 0 && svgRect.width > 0 ? vb.width / svgRect.width : 1;
    const handleRadius = 6 * scale;
    const minSize = 12 * scale; // minimum size in viewBox px — guards against shrinking the rectangle to zero/flipping an axis
    const rotateHandleOffset = 32 * scale;
    const initialRotation = this.#imageAdjustRotation?.imageId === image.id ? this.#imageAdjustRotation.rotationRad : 0;

    const HANDLE_DEFS: Array<{ dx: -1 | 0 | 1; dy: -1 | 0 | 1; cursor: string }> = [
      { dx: -1, dy: -1, cursor: 'nwse-resize' },
      { dx: 0, dy: -1, cursor: 'ns-resize' },
      { dx: 1, dy: -1, cursor: 'nesw-resize' },
      { dx: 1, dy: 0, cursor: 'ew-resize' },
      { dx: 1, dy: 1, cursor: 'nwse-resize' },
      { dx: 0, dy: 1, cursor: 'ns-resize' },
      { dx: -1, dy: 1, cursor: 'nesw-resize' },
      { dx: -1, dy: 0, cursor: 'ew-resize' },
    ];

    // [User request, "the ability to rotate an automatically selected
    // image"] The group carries the rotation — EXACTLY the same pattern as
    // `#renderPendingCropOverlay` (SVG's `rotate()` is the same matrix as
    // `screenRotatedRectToPdf`, so screen = what actually gets cropped).
    // `rectEl` is already attached to `svg` (by the caller in `draw()`) —
    // `appendChild` MOVES it into this group, it doesn't clone it.
    const g = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(g);
    g.appendChild(rectEl);

    const resizeHandleEls = HANDLE_DEFS.map(({ cursor }) => {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('r', String(handleRadius));
      el.setAttribute('class', 'bindery-resize-handle');
      el.style.cursor = cursor;
      g.appendChild(el);
      return el;
    });
    const rotateLine = document.createElementNS(SVG_NS, 'line');
    rotateLine.setAttribute('class', 'bindery-pending-crop-handle-line');
    g.appendChild(rotateLine);
    const rotateHandle = document.createElementNS(SVG_NS, 'circle');
    rotateHandle.setAttribute('r', String(handleRadius));
    rotateHandle.setAttribute('class', 'bindery-pending-crop-handle');
    g.appendChild(rotateHandle);

    // [Lesson from an earlier bug in the same session, "the rotation handle
    // only works a few degrees at a time"] `currentRect`/`currentRotation`
    // are SHARED (closure) across ALL handles (8 for resizing + 1 for
    // rotation) — WHILE dragging, a full overlay redraw must NOT be called
    // (it destroys and recreates the handles from scratch, silently losing
    // `setPointerCapture`) — `updateAll` only REPLACES the attributes of
    // already existing elements, so the same `<circle>` element holds
    // capture throughout the whole gesture, no matter how many times it
    // fires.
    let currentRect = initialScreen;
    let currentRotation = initialRotation;

    // [User request, "can't resize from the left side of an automatically
    // selected image"] When the selection reaches almost to the page edge
    // (typical for automatically detected images covering all/almost all of
    // the page), a handle drawn EXACTLY on the rectangle's edge has HALF of
    // its circle outside the `viewBox` — SVG clips by default (`overflow:
    // hidden` by definition on the root `<svg>`) everything outside its own
    // box, so that half is invisible AND unclickable; when the edge is
    // CLOSE ENOUGH to the border, the WHOLE handle can disappear. `clampX`/
    // `clampY` only push the drawn/clickable position (never the
    // `currentRect` data, which still reflects the TRUE edge) away from the
    // `viewBox` borders by the handle's radius, so every handle always fits
    // entirely within the visible/clickable area.
    const clampX = (x: number): number => Math.min(Math.max(x, handleRadius), Math.max(handleRadius, vb.width - handleRadius));
    const clampY = (y: number): number => Math.min(Math.max(y, handleRadius), Math.max(handleRadius, vb.height - handleRadius));

    const updateAll = (): void => {
      rectEl.setAttribute('x', String(currentRect.minX));
      rectEl.setAttribute('y', String(currentRect.minY));
      rectEl.setAttribute('width', String(Math.max(0, currentRect.maxX - currentRect.minX)));
      rectEl.setAttribute('height', String(Math.max(0, currentRect.maxY - currentRect.minY)));
      const cx = (currentRect.minX + currentRect.maxX) / 2;
      const cy = (currentRect.minY + currentRect.maxY) / 2;
      HANDLE_DEFS.forEach(({ dx, dy }, i) => {
        resizeHandleEls[i]!.setAttribute('cx', String(clampX(dx === -1 ? currentRect.minX : dx === 1 ? currentRect.maxX : cx)));
        resizeHandleEls[i]!.setAttribute('cy', String(clampY(dy === -1 ? currentRect.minY : dy === 1 ? currentRect.maxY : cy)));
      });
      // Same problem/fix as the resize handles above — for a selection
      // reaching close to the TOP edge of the page, the rotation handle
      // (always above the center of the top edge) could fall outside the
      // `viewBox`. The connecting line MUST end at the SAME (clamped) point
      // as the handle, otherwise it will visually "detach" from it.
      const rotateHandleX = clampX(cx);
      const rotateHandleY = clampY(currentRect.minY - rotateHandleOffset);
      rotateLine.setAttribute('x1', String(cx));
      rotateLine.setAttribute('y1', String(currentRect.minY));
      rotateLine.setAttribute('x2', String(rotateHandleX));
      rotateLine.setAttribute('y2', String(rotateHandleY));
      rotateHandle.setAttribute('cx', String(rotateHandleX));
      rotateHandle.setAttribute('cy', String(rotateHandleY));
      const deg = (currentRotation * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${deg} ${cx} ${cy})`);
    };
    updateAll();

    /** Screen point (unrotated overlay coordinate space) -> LOCAL rectangle coordinate space (the inverse of the current `currentRotation` around `cx,cy`) — needed so that dragging the resize handles works correctly even when the image is ALREADY rotated. */
    const toLocalPoint = (screenPt: { x: number; y: number }, cx: number, cy: number): { x: number; y: number } => {
      const dx0 = screenPt.x - cx;
      const dy0 = screenPt.y - cy;
      const cos = Math.cos(-currentRotation);
      const sin = Math.sin(-currentRotation);
      return { x: cx + dx0 * cos - dy0 * sin, y: cy + dx0 * sin + dy0 * cos };
    };

    const commitOrRevert = (changed: boolean): void => {
      if (!changed) return;
      const centerX = (currentRect.minX + currentRect.maxX) / 2;
      const centerY = (currentRect.minY + currentRect.maxY) / 2;
      void this.#resizeImage(image, { centerX, centerY, width: currentRect.maxX - currentRect.minX, height: currentRect.maxY - currentRect.minY, rotationRad: currentRotation });
    };

    HANDLE_DEFS.forEach(({ dx, dy }, i) => {
      const handle = resizeHandleEls[i]!;
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (this.#isCropping) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const startRect = currentRect;
        const startCx = (startRect.minX + startRect.maxX) / 2;
        const startCy = (startRect.minY + startRect.maxY) / 2;
        let changed = false;

        const onMove = (ev: PointerEvent): void => {
          if (!handle.hasPointerCapture(ev.pointerId)) return;
          const pt = this.#toOverlayPoint(svg, ev.clientX, ev.clientY);
          const local = toLocalPoint(pt, startCx, startCy);
          const next: Rect = { ...startRect };
          if (dx === -1) next.minX = Math.min(local.x, startRect.maxX - minSize);
          if (dx === 1) next.maxX = Math.max(local.x, startRect.minX + minSize);
          if (dy === -1) next.minY = Math.min(local.y, startRect.maxY - minSize);
          if (dy === 1) next.maxY = Math.max(local.y, startRect.minY + minSize);
          currentRect = next;
          changed = true;
          updateAll();
        };
        const cleanup = (): void => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onCancel);
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        const onUp = (): void => {
          cleanup();
          commitOrRevert(changed);
        };
        const onCancel = (): void => {
          cleanup();
          currentRect = startRect;
          updateAll();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onCancel);
      });
    });

    rotateHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.#isCropping) return;
      e.preventDefault();
      e.stopPropagation();
      rotateHandle.setPointerCapture(e.pointerId);
      const startRotation = currentRotation;
      let changed = false;

      const onMove = (ev: PointerEvent): void => {
        if (!rotateHandle.hasPointerCapture(ev.pointerId)) return;
        const pt = this.#toOverlayPoint(svg, ev.clientX, ev.clientY);
        const cx = (currentRect.minX + currentRect.maxX) / 2;
        const cy = (currentRect.minY + currentRect.maxY) / 2;
        const angle = Math.atan2(pt.y - cy, pt.x - cx);
        currentRotation = angle + Math.PI / 2;
        this.#imageAdjustRotation = { imageId: image.id, rotationRad: currentRotation };
        changed = true;
        updateAll();
      };
      const cleanup = (): void => {
        rotateHandle.removeEventListener('pointermove', onMove);
        rotateHandle.removeEventListener('pointerup', onUp);
        rotateHandle.removeEventListener('pointercancel', onCancel);
        if (rotateHandle.hasPointerCapture(e.pointerId)) rotateHandle.releasePointerCapture(e.pointerId);
      };
      const onUp = (): void => {
        cleanup();
        commitOrRevert(changed);
      };
      const onCancel = (): void => {
        cleanup();
        currentRotation = startRotation;
        this.#imageAdjustRotation = startRotation !== 0 ? { imageId: image.id, rotationRad: startRotation } : null;
        updateAll();
      };
      rotateHandle.addEventListener('pointermove', onMove);
      rotateHandle.addEventListener('pointerup', onUp);
      rotateHandle.addEventListener('pointercancel', onCancel);
    });
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
      const box = await this.#data.previewDocument.getPageBox(this.#currentPageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(this.#currentPageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      image.width = crop.width;
      image.height = crop.height;
      image.format = crop.format;
      image.provenance = { ...image.provenance, bbox: rotatedRectBounds(pdfRegion) };
      this.#imageAdjustRotation = null;
      // [Bug fix, cumulative shrinking on content rotation] A fresh crop
      // from the PDF is a NEW "0°" reference point for `#rotateImage` — the
      // old `originalBytes` (if any) no longer represents the image's
      // current content.
      this.#imageRotationState.delete(image.id);
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
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
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: result.bytes, format: result.format });
      await this.render();
    } catch (err) {
      console.warn('Bindery | image erase failed:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.imageErase.failed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [Step 42, "token as a product"] Opens `TokenPrepApp` on the CURRENT
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
        removeBackgroundDefault: this.#data.removeTokenBackgroundDefault ?? false,
      });
      if (!result) return;
      image.width = result.width;
      image.height = result.height;
      image.format = result.format;
      this.#imageRotationState.delete(image.id);
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: result.bytes, format: result.format });
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
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
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
   * (list, destination choice, `#runImport`) handles it without any special
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
      const box = await this.#data.previewDocument.getPageBox(this.#currentPageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(this.#currentPageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      await this.#finalizeManualCrop(rotatedRectBounds(pdfRegion), crop);
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
   * `#runImport`) handles it without any special cases. Shared between
   * `#createManualCrop` (axis-aligned) and `#createManualCropRotated`
   * (rotated) — the only difference between them is HOW `pdfBbox`/the
   * render is computed, not what happens with the result.
   */
  async #finalizeManualCrop(pdfBbox: Rect, crop: RegionCrop): Promise<void> {
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
      provenance: { pageNumber: this.#currentPageNumber, bbox: pdfBbox, blockIds: [] },
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
    this.#teardownPendingCropUi();
    await this.render();
  }
  static async #onNextPage(this: ReviewScreen): Promise<void> {
    if (this.#currentPageNumber >= this.#data.previewDocument.pageCount) return;
    this.#currentPageNumber++;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
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
    if (this.#tab === 'images') void this.#redrawOverlay();
    else if (this.#tab === 'actors') void this.#redrawActorOverlay();
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

  // ---- Image list (Z2/Z4) ---------------------------------------------

  #mountImageList(images: CIFImage[]): void {
    // [Redesign 2a] The row stacks three lines in `.bindery-row-name-wrap`
    // (name + meta + journal group) next to a 48px-tall thumbnail — the
    // height was chosen empirically for this layout (see `bindery.css`,
    // "Image table" section).
    this.#imageList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="images"]'), 'images', images, 80, (image) => this.#buildImageRow(image));
  }

  #thumbnailFor(imageId: string): string | null {
    const cached = this.#thumbnailUrls.get(imageId);
    if (cached) return cached;
    const entry = this.#data.imageBytesById.get(imageId);
    if (!entry) return null;
    const mime = entry.format === 'png' ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([new Uint8Array(entry.bytes)], { type: mime }));
    this.#thumbnailUrls.set(imageId, url);
    return url;
  }

  #buildImageRow(image: CIFImage): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-image-row';
    row.dataset['imageId'] = image.id;
    if (image.id === this.#highlightedImageId) row.classList.add('bindery-row-highlighted');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#selection.isImageSelected(image.id);
    checkbox.addEventListener('change', () => {
      this.#selection.setImage(image.id, checkbox.checked);
      void this.#refreshHeaderCounts();
    });
    row.appendChild(checkbox);

    // [Redesign 2a] The 36x48 slot is ALWAYS present (even without a
    // thumbnail), so the grid columns (`22px 36px 74px minmax(0,1fr) 148px`)
    // stay identical in every row — VirtualList requires a fixed row
    // height, so a missing element must not change the number of columns.
    const thumbSlot = document.createElement('div');
    thumbSlot.className = 'bindery-row-thumb-slot';
    const thumbUrl = this.#thumbnailFor(image.id);
    if (thumbUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'bindery-row-thumb';
      thumb.src = thumbUrl;
      thumb.alt = '';
      thumb.title = game.i18n!.localize('BINDERY.review.thumbnailOpenTitle' as never);
      // Hovering enlarges the thumbnail for a quick look; clicking opens the
      // full preview window, which also offers the erase tools.
      thumb.addEventListener('mouseenter', () => this.#showThumbPreview(thumbUrl, thumb, image.width, image.height));
      thumb.addEventListener('mouseleave', () => this.#hideThumbPreview());
      thumb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#hideThumbPreview();
        void this.#openImageEditor(image);
      });
      thumbSlot.appendChild(thumb);
    }
    row.appendChild(thumbSlot);

    const pageLabel = document.createElement('span');
    pageLabel.className = 'bindery-row-page';
    pageLabel.textContent = `p.${image.provenance.pageNumber}`;
    row.appendChild(pageLabel);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'bindery-row-name-wrap';

    // [Step 20, gap reported live: "I'm missing the ability to name selected
    // images"] Image name directly editable IN the row — mirrors the
    // pattern from `#buildJournalRow` (there `nameInput` mutates
    // `row.journal.name` directly on the core object). `image.caption` is
    // an ALREADY existing, optional `CIFImage` field (see
    // `packages/core/src/cif/types.ts`) read by `#runImport` as an override
    // for the default name (`image.caption?.trim() || "Image p.N"`) — ALL
    // three paths (Scene/Journal/Token) and journal grouping get this name
    // for free, with no extra logic here.
    const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input';
    nameInput.placeholder = `${defaultImageName} p.${image.provenance.pageNumber}`;
    nameInput.value = image.caption ?? '';
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    nameInput.addEventListener('change', () => {
      image.caption = nameInput.value.trim() || undefined;
    });
    nameWrap.appendChild(nameInput);

    // [User request, "'unknown - 65x115 - undecided (40%)' is completely
    // unnecessary, only the size can stay"] Previously a full description
    // (`targetKind — WxH — classification (confidence%)`) — everything
    // besides the size itself was the classifier's internal jargon,
    // unreadable to the user and useless for deciding on a destination.
    const meta = document.createElement('span');
    meta.className = 'bindery-row-meta';
    meta.textContent = `${image.width}×${image.height}`;
    nameWrap.appendChild(meta);

    // [Step 19] Journal group name — only makes sense for the `journal`
    // destination (see `ReviewSelection.imageJournalGroup`), hence hidden
    // for other destinations instead of removed from the DOM (a simpler
    // visibility toggle below, in the `destSelect` change handler). A third
    // line in `nameWrap` (doc: "keep full per-row editability, don't remove
    // without asking" — see README, so it stays, just visually
    // de-emphasized via `.bindery-row-journal-group` like `meta` above).
    const groupInput = document.createElement('input');
    groupInput.type = 'text';
    groupInput.className = 'bindery-row-journal-group';
    groupInput.placeholder = game.i18n!.localize('BINDERY.review.journalGroupPlaceholder' as never);
    groupInput.value = this.#selection.imageJournalGroup(image.id);
    groupInput.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.addEventListener('change', () => {
      this.#selection.setImageJournalGroup(image.id, groupInput.value);
    });
    nameWrap.appendChild(groupInput);

    // [Step 42, "token as a product"] The same pattern as `groupInput`
    // above — a third line in `nameWrap`, visible SOLELY for the `token`
    // destination (the `.bindery-image-row` grid has a FIXED number of
    // columns, see `bindery.css`, so a new button must go into the ALREADY
    // existing, flexible `nameWrap` column, not as a new child of `row`).
    // Opens `TokenPrepApp` (background removal/mask/frame); on confirmation
    // it REPLACES the image's bytes/dimensions/format — mirrors
    // `#resizeImage`/`#rotateImage`, see `#prepareToken`. The mechanism for
    // assigning a token to an actor (step 35) doesn't know and doesn't need
    // to know that the bytes come from this panel.
    const prepareTokenBtn = document.createElement('button');
    prepareTokenBtn.type = 'button';
    prepareTokenBtn.className = 'bindery-row-prepare-token-btn';
    prepareTokenBtn.textContent = game.i18n!.localize('BINDERY.review.prepareToken' as never);
    prepareTokenBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#prepareToken(image);
    });
    nameWrap.appendChild(prepareTokenBtn);

    row.appendChild(nameWrap);

    // [Step 14 Z4] Per-image destination — suggested from `CIFImage.targetKind`
    // [User request, "all images end up in Unassigned, the user assigns
    // manually"] Always `unassigned` by default (see
    // `defaultImageDestination`) — overridable here.
    const destSelect = document.createElement('select');
    destSelect.className = 'bindery-select bindery-row-destination';
    for (const [value, labelKey] of [
      ['scene', 'BINDERY.review.destinationScene'],
      ['journal', 'BINDERY.review.destinationJournal'],
      ['token', 'BINDERY.review.destinationToken'],
      ['unassigned', 'BINDERY.review.destinationUnassigned'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = game.i18n!.localize(labelKey as never);
      destSelect.appendChild(opt);
    }
    destSelect.value = this.#selection.imageDestination(image.id);
    destSelect.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.style.display = destSelect.value === 'journal' ? '' : 'none';
    prepareTokenBtn.style.display = destSelect.value === 'token' ? '' : 'none';

    destSelect.addEventListener('change', () => {
      const destination = destSelect.value as ImageDestination;
      this.#selection.setImageDestination(image.id, destination);
      // [Step 16 Z2, fix for reported bug] `#runImport` processes SOLELY
      // selected images (checkbox) — without this, choosing a destination
      // for an image that starts UNCHECKED (EVERY image, see
      // `ReviewSelection.fromDocument` — user request, all images start
      // unchecked) did NOTHING, with no error or warning ("the scene isn't
      // created"). Changing the destination to anything other than
      // "Unassigned" is an unambiguous declaration of intent — select the
      // image right away, so the dropdown and the checkbox don't drift
      // apart into two independent, silent sources of truth.
      const shouldBeSelected = destination !== 'unassigned';
      if (this.#selection.isImageSelected(image.id) !== shouldBeSelected) this.#selection.setImage(image.id, shouldBeSelected);
      // [User request, Scene/Journal/Token/Unassigned sub-tabs] The image
      // moves to a DIFFERENT destination sub-tab — a full render (instead of
      // the previous surgical update of this one row), so it disappears
      // from the current list and appears in the correct one. `scrollable`
      // (see `PARTS.main` above) protects the list's scroll position despite
      // the full render.
      void this.render();
    });
    row.appendChild(destSelect);

    // [User request, "rotate an already-cropped image — the map covers the
    // whole page, selecting an area would crop it wrong, it's about
    // rotating an ALREADY cropped image"] Rotates the CONTENT ITSELF (the
    // pixels of the already-saved bytes) by 90° — INDEPENDENT of the
    // rotation/resize handles on the page preview
    // (`#renderResizeHandles`/`#resizeImage`), which concern SELECTING the
    // area BEFORE re-cropping from the PDF. Here the PDF is not queried
    // again at all — a pure canvas operation.
    const rotateWrap = document.createElement('div');
    rotateWrap.className = 'bindery-row-rotate';
    const rotateLeftBtn = document.createElement('button');
    rotateLeftBtn.type = 'button';
    rotateLeftBtn.className = 'bindery-row-rotate-btn';
    rotateLeftBtn.textContent = '↺';
    rotateLeftBtn.title = game.i18n!.format('BINDERY.review.rotateImageLeft' as never, { n: String(ReviewScreen.#IMAGE_ROTATE_STEP_DEG) });
    rotateLeftBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#rotateImage(image, -1);
    });
    rotateWrap.appendChild(rotateLeftBtn);
    const rotateRightBtn = document.createElement('button');
    rotateRightBtn.type = 'button';
    rotateRightBtn.className = 'bindery-row-rotate-btn';
    rotateRightBtn.textContent = '↻';
    rotateRightBtn.title = game.i18n!.format('BINDERY.review.rotateImageRight' as never, { n: String(ReviewScreen.#IMAGE_ROTATE_STEP_DEG) });
    rotateRightBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#rotateImage(image, 1);
    });
    rotateWrap.appendChild(rotateRightBtn);
    row.appendChild(rotateWrap);

    row.addEventListener('click', (ev) => {
      if (ev.target === checkbox || ev.target === destSelect || ev.target === groupInput || ev.target === nameInput) return;
      this.#highlightedImageId = image.id;
      if (this.#currentPageNumber === image.provenance.pageNumber) {
        this.#refreshImageRowHighlights();
        void this.#redrawOverlay();
      } else {
        this.#currentPageNumber = image.provenance.pageNumber;
        void this.render();
      }
    });

    return row;
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

  // [Step 16 Z2, fix for reported bug] Journals (full book text) now start
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
   * [Step 19, fix for reported bug] Restores the last choice in the bulk
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
  /** Everything currently selected for import — images, scenes, journals and actors. */
  #totalSelectedCount(): number {
    return this.#selection.selectedAssignedImageCount + this.#selection.selectedSceneCount + this.#selection.selectedJournalCount + this.#actorSelection.selectedCount;
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

  /** [Step 11 Z3] Updates the highlight class on the already-rendered image list rows, without a full `render()` (see `#redrawOverlay`). */
  #refreshImageRowHighlights(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('.bindery-image-row');
    for (const row of rows) {
      row.classList.toggle('bindery-row-highlighted', row.dataset['imageId'] === this.#highlightedImageId);
    }
  }

  // ---- [Step 20 Z2] Actor list -----------------------------------------

  /**
   * [Step 21, bug measured live] Without virtualization — deliberately,
   * unlike images/scenes/journals/diagnostics (`VirtualList`, which
   * EXPLICITLY assumes "no variable-height rows", see its own comment). An
   * actor row is inherently of variable height (an optional row of name
   * candidates, a wrapping trait list, a wrapping attack list, a variable
   * number of adapter notes) — a fixed `rowHeightPx` in `VirtualList` caused
   * the content of longer rows (e.g. "Hands" from p. 56: 5 attacks + several
   * notes) to be visually covered by the NEXT row (absolute positioning +
   * enforced height), even though the underlying data was complete the
   * whole time — the created Actor had all 4 attacks correctly, only the
   * EDITOR didn't show them. The number of actors in a real book is dozens,
   * not the thousands of images that `VirtualList` actually has to handle
   * (its own goal: "2500 items without stuttering") — plain,
   * non-virtualized rendering is the correct trade-off here, not a
   * temporary workaround.
   */
  #mountActorList(actors: CIFActor[]): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="actors"]');
    if (!container) return;
    container.innerHTML = '';
    for (const actor of actors) container.appendChild(this.#buildActorRow(actor));
    // [User request, "I pick an image from the list, it jumps back to the
    // top"] The same problem as `VirtualList` (see the rationale next to
    // `initialScrollTop` there), even though this list is NOT virtualized:
    // the container is EMPTY in the Handlebars template, so Foundry's own
    // `scrollable` tries to restore `scrollTop` BEFORE the rows above even
    // exist — setting scroll on an empty container gets clamped to 0 by the
    // browser. So we restore it OURSELVES, AFTER filling it.
    container.scrollTop = this.#listScrollTop['actors'] ?? 0;
    container.addEventListener('scroll', () => (this.#listScrollTop['actors'] = container.scrollTop));
  }

  /** Stat row with abbreviated labels (`STR`,`APP`,...) — see `CHARACTERISTIC_KEY_MAP`/derivedBlock in `adapters/coc7.ts`. The canonical key is longer than the standard CoC7 character-sheet abbreviation (e.g. "strength" vs "STR") — a reverse map SOLELY for labeling inputs on this screen, not for any decision. */
  static readonly #STAT_SHORT_LABELS: Readonly<Record<string, string>> = {
    strength: 'STR',
    charisma: 'APP',
    constitution: 'CON',
    willpower: 'POW',
    size: 'SIZ',
    education: 'EDU',
    dexterity: 'DEX',
    intelligence: 'INT',
    sanity: 'SAN',
    hitPoints: 'HP',
    damageBonus: 'DB',
    build: 'Build',
    movement: 'Move',
    magicPoints: 'MP',
  };

  #buildActorRow(actor: CIFActor): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-actor-row';
    row.dataset['actorId'] = actor.id;
    if (actor.id === this.#highlightedActorId) row.classList.add('bindery-row-highlighted');

    const completeness = computeActorCompleteness(actor);
    const preview = this.#actorAdapterPreview.get(actor.id);

    const line1 = document.createElement('div');
    line1.className = 'bindery-actor-row-line1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#actorSelection.isSelected(actor.id);
    checkbox.addEventListener('change', () => {
      this.#actorSelection.setSelected(actor.id, checkbox.checked);
      void this.#refreshActorHeaderCounts();
    });
    line1.appendChild(checkbox);

    // [DoD Z2] Name resolution — the text field is always editable (a
    // confident name starts pre-filled, a placeholder starts EMPTY, forcing
    // a deliberate choice), plus shortcut buttons for each candidate from
    // `nameCandidates` (S4/A10 — "one click, not a form", Z2 brief).
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input bindery-actor-name-input';
    nameInput.placeholder = actor.nameConfident ? actor.name : game.i18n!.localize('BINDERY.review.actorUnresolvedNamePlaceholder' as never);
    nameInput.value = this.#actorSelection.resolvedName(actor);
    if (!this.#actorSelection.isNameResolved(actor)) nameInput.classList.add('bindery-actor-name-unresolved');
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    nameInput.addEventListener('change', () => {
      this.#actorSelection.setResolvedName(actor.id, nameInput.value);
      nameInput.classList.toggle('bindery-actor-name-unresolved', !this.#actorSelection.isNameResolved(actor));
      this.#rebuildActorAdapterPreview();
      this.#refreshActorRowNotes(actor.id);
      void this.#refreshActorHeaderCounts();
    });
    line1.appendChild(nameInput);

    const completenessBadge = document.createElement('span');
    completenessBadge.className = 'bindery-actor-completeness';
    completenessBadge.dataset['complete'] = completeness.missingStatCount === 0 && completeness.hasAttacks ? '1' : '0';
    completenessBadge.textContent = `${completeness.presentStatCount}/${completeness.expectedStatCount}${completeness.hasAttacks ? '' : ' · ' + game.i18n!.localize('BINDERY.review.actorNoAttacks' as never)}`;
    completenessBadge.dataset['tooltip'] = game.i18n!.localize('BINDERY.review.actorCompletenessTooltip' as never);
    line1.appendChild(completenessBadge);

    const pageLink = document.createElement('span');
    pageLink.className = 'bindery-actor-page-link';
    pageLink.textContent = `p. ${actor.provenance.pageNumber}`;
    line1.appendChild(pageLink);
    row.appendChild(line1);

    row.appendChild(this.#buildActorImageSection(actor));

    // Name candidates — SOLELY while the name is still unresolved (they disappear after resolution, so as not to clutter the row).
    if (actor.nameCandidates && actor.nameCandidates.length > 0 && !this.#actorSelection.isNameResolved(actor)) {
      const candidatesRow = document.createElement('div');
      candidatesRow.className = 'bindery-actor-candidates';
      const label = document.createElement('span');
      label.textContent = game.i18n!.localize('BINDERY.review.actorCandidatesLabel' as never) + ':';
      candidatesRow.appendChild(label);
      for (const candidate of actor.nameCandidates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bindery-actor-candidate-btn';
        btn.textContent = candidate;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#actorSelection.setResolvedName(actor.id, candidate);
          nameInput.value = candidate;
          nameInput.classList.remove('bindery-actor-name-unresolved');
          this.#rebuildActorAdapterPreview();
          void this.render();
        });
        candidatesRow.appendChild(btn);
      }
      row.appendChild(candidatesRow);
    }

    // [DoD Z2] Characteristic/derived values — an editable input per key ACTUALLY present on this actor (generic, not a hardcoded field list).
    const statsRow = document.createElement('div');
    statsRow.className = 'bindery-actor-stats';
    for (const [key, stat] of Object.entries(actor.statistics)) {
      const field = document.createElement('label');
      field.className = 'bindery-actor-stat-field';
      const shortLabel = ReviewScreen.#STAT_SHORT_LABELS[key] ?? key;
      const labelSpan = document.createElement('span');
      labelSpan.textContent = shortLabel;
      field.appendChild(labelSpan);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = this.#actorSelection.effectiveStatRaw(actor, key);
      input.title = stat.sourceLabel;
      input.addEventListener('click', (ev) => ev.stopPropagation());
      input.addEventListener('change', () => {
        this.#actorSelection.setStatOverride(actor.id, key, input.value);
        this.#rebuildActorAdapterPreview();
        this.#refreshActorRowNotes(actor.id);
      });
      field.appendChild(input);
      statsRow.appendChild(field);
    }
    row.appendChild(statsRow);

    // [DoD Z2] Attacks — name/to-hit/damage + a remove button (restorable by clicking again — `toggleAttackRemoved`).
    if (actor.attacks.length > 0) {
      const attacksRow = document.createElement('div');
      attacksRow.className = 'bindery-actor-attacks';
      actor.attacks.forEach((attack, index) => {
        const chip = document.createElement('span');
        chip.className = 'bindery-actor-attack-chip';
        if (this.#actorSelection.isAttackRemoved(actor.id, index)) chip.classList.add('bindery-actor-attack-removed');
        const text = document.createElement('span');
        text.textContent = `${attack.name}${attack.toHit ? ' ' + attack.toHit + '%' : ''}${attack.damage ? ' ' + attack.damage : ''}`;
        chip.appendChild(text);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'bindery-actor-attack-remove';
        removeBtn.textContent = this.#actorSelection.isAttackRemoved(actor.id, index) ? '↺' : '×';
        removeBtn.dataset['tooltip'] = this.#actorSelection.isAttackRemoved(actor.id, index)
          ? game.i18n!.localize('BINDERY.review.actorAttackRestore' as never)
          : game.i18n!.localize('BINDERY.review.actorAttackRemove' as never);
        removeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#actorSelection.toggleAttackRemoved(actor.id, index);
          chip.classList.toggle('bindery-actor-attack-removed');
          removeBtn.textContent = this.#actorSelection.isAttackRemoved(actor.id, index) ? '↺' : '×';
          this.#rebuildActorAdapterPreview();
          this.#refreshActorRowNotes(actor.id);
        });
        chip.appendChild(removeBtn);
        attacksRow.appendChild(chip);
      });
      row.appendChild(attacksRow);
    }

    // [DoD Z2, A3/A10] Adapter `notes` — VISIBLE, never hidden. A container with its own data attribute, so `#refreshActorRowNotes` can replace it without rebuilding the whole row.
    const notesBox = document.createElement('div');
    notesBox.className = 'bindery-actor-notes';
    notesBox.dataset['actorNotesFor'] = actor.id;
    this.#renderActorNotesInto(notesBox, preview);
    row.appendChild(notesBox);

    row.addEventListener('click', (ev) => {
      if (ev.target instanceof HTMLElement && (ev.target.closest('input') || ev.target.closest('button'))) return;
      this.#highlightedActorId = actor.id;
      if (this.#currentPageNumber === actor.provenance.pageNumber) {
        this.#refreshActorRowHighlights();
        void this.#redrawActorOverlay();
      } else {
        this.#currentPageNumber = actor.provenance.pageNumber;
        void this.render();
      }
    });

    return row;
  }

  /**
   * [Step 35 Z1/Z2] Actor token+portrait — SOLELY a choice from the list of
   * images with the `token` destination (Images tab), zero automatic
   * geometric matching (`images.associateWithEntity` from the profile, MDD
   * §5.5, deliberately unused — a product decision from step 35). The list
   * is NOT restricted to the actor's page (brief: "the author may want any
   * of them"). An empty list explains why it's empty (the same pattern as
   * the empty Actors tab without a profile, step 21), instead of showing an
   * empty dropdown.
   */
  #buildActorImageSection(actor: CIFActor): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-actor-image-section';

    // [User request, "an image with the checkbox unchecked could still be
    // chosen as a token, but never reached the import"] `imageDestination
    // === 'token'` by itself is NOT enough — an image with an unchecked
    // checkbox (Images tab) NEVER reaches `uploadedTokenImagePathById` (see
    // `#runImport`, the loop over `doc.images`: `if (!isImageSelected)
    // continue`), so choosing it here would end up as a token with no image
    // on the sheet (the adapter degrades with a warning, but the author
    // might not notice that warning). Better not to offer a choice that
    // won't work anyway.
    const candidates = this.#data.document.images
      .filter((img) => this.#selection.isImageSelected(img.id) && this.#selection.imageDestination(img.id) === 'token')
      .sort((a, b) => a.provenance.pageNumber - b.provenance.pageNumber);

    if (candidates.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'bindery-actor-image-empty-hint hint';
      hint.textContent = game.i18n!.localize('BINDERY.review.actorTokenEmptyHint' as never);
      wrap.appendChild(hint);
      return wrap;
    }

    // [User request, "auto-suggest by page number", then "this suggested
    // token looks wrong" — measured case: suggested p. 3 for an actor from
    // p. 23] When the author hasn't chosen ANYTHING yet
    // (`hasTokenImageSelection` — distinguishes this from an explicit
    // "none"), suggest the candidate CLOSEST to the actor's own statblock
    // page — BUT only when "closest" actually means CLOSE (the same
    // content layout of the book, e.g. a portrait on the adjacent
    // page/spread), not "least-far in the whole book". Without a threshold,
    // when the whole document has only a few images marked as token,
    // "closest" could point at something 20 pages away — geometrically
    // UNRELATED to this character (exactly the reported case), a worse
    // suggestion than no suggestion at all (A10 — don't guess when the
    // signal is weak).
    const TOKEN_SUGGESTION_MAX_PAGE_DISTANCE = 2;
    if (!this.#actorSelection.hasTokenImageSelection(actor.id)) {
      const nearest = candidates.reduce((best, img) =>
        Math.abs(img.provenance.pageNumber - actor.provenance.pageNumber) < Math.abs(best.provenance.pageNumber - actor.provenance.pageNumber) ? img : best,
      );
      if (Math.abs(nearest.provenance.pageNumber - actor.provenance.pageNumber) <= TOKEN_SUGGESTION_MAX_PAGE_DISTANCE) {
        this.#actorSelection.setTokenImageId(actor.id, nearest.id);
      }
    }

    const tokenField = document.createElement('div');
    tokenField.className = 'bindery-actor-image-field';
    const tokenLabel = document.createElement('span');
    tokenLabel.className = 'bindery-actor-image-field-label';
    tokenLabel.textContent = game.i18n!.localize('BINDERY.review.actorTokenLabel' as never);
    tokenField.appendChild(tokenLabel);
    tokenField.appendChild(
      this.#buildImagePicker(candidates, this.#actorSelection.tokenImageId(actor.id), (imageId) => {
        this.#actorSelection.setTokenImageId(actor.id, imageId);
      }),
    );
    wrap.appendChild(tokenField);

    // [Z2, "Separating the portrait and the token"] Under "Advanced
    // settings" — collapsed by default and WITHOUT its own assignment (the
    // portrait follows the token, P1), expanded automatically when the
    // author has ALREADY separated them earlier (e.g. after editing an
    // earlier row and re-rendering the whole list).
    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    details.open = this.#actorSelection.hasCustomPortrait(actor.id);
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.review.actorAdvancedSettings' as never);
    details.appendChild(summary);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'bindery-actor-portrait-toggle';
    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.className = 'bindery-check';
    toggleCheckbox.checked = this.#actorSelection.hasCustomPortrait(actor.id);
    const toggleText = document.createElement('span');
    toggleText.textContent = game.i18n!.localize('BINDERY.review.actorSeparatePortraitToggle' as never);
    toggleLabel.appendChild(toggleCheckbox);
    toggleLabel.appendChild(toggleText);
    details.appendChild(toggleLabel);

    const portraitField = document.createElement('div');
    portraitField.className = 'bindery-actor-image-field';
    portraitField.style.display = toggleCheckbox.checked ? '' : 'none';
    const portraitLabel = document.createElement('span');
    portraitLabel.className = 'bindery-actor-image-field-label';
    portraitLabel.textContent = game.i18n!.localize('BINDERY.review.actorPortraitLabel' as never);
    portraitField.appendChild(portraitLabel);
    details.appendChild(portraitField);

    // [Z2] The portrait preview is only built once the override is enabled —
    // while it follows the token, there's no OWN state worth its own widget
    // (see `portraitImageId` in `ActorReviewSelection`).
    const mountPortraitPicker = (): void => {
      const existing = portraitField.querySelector('.bindery-actor-image-picker');
      existing?.remove();
      portraitField.appendChild(
        this.#buildImagePicker(candidates, this.#actorSelection.portraitImageId(actor.id), (imageId) => {
          this.#actorSelection.setPortraitImageId(actor.id, imageId);
        }),
      );
    };
    if (toggleCheckbox.checked) mountPortraitPicker();

    toggleCheckbox.addEventListener('click', (ev) => ev.stopPropagation());
    toggleCheckbox.addEventListener('change', () => {
      if (toggleCheckbox.checked) {
        this.#actorSelection.setPortraitImageId(actor.id, this.#actorSelection.tokenImageId(actor.id));
        portraitField.style.display = '';
        mountPortraitPicker();
      } else {
        this.#actorSelection.clearCustomPortrait(actor.id);
        portraitField.style.display = 'none';
        portraitField.querySelector('.bindery-actor-image-picker')?.remove();
      }
    });

    wrap.appendChild(details);
    return wrap;
  }

  /**
   * [Step 35 Z1] A dropdown with thumbnails — a native `<select>` can't show
   * an image per option (a hard HTML limitation), hence a custom, tiny
   * popover: a button showing the CURRENT choice (thumbnail+page), and on
   * click, a list of all candidates (thumbnail+page each). Self-contained,
   * closed by clicking outside it — zero dependency on the rest of the row,
   * so it can be used for both the token and the portrait.
   */
  #buildImagePicker(images: readonly CIFImage[], currentId: string, onSelect: (imageId: string) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-actor-image-picker';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bindery-actor-image-picker-toggle';

    const menu = document.createElement('div');
    menu.className = 'bindery-actor-image-picker-menu';
    menu.hidden = true;

    const renderToggleContent = (imageId: string): void => {
      toggle.innerHTML = '';
      const image = images.find((i) => i.id === imageId) ?? null;
      const thumbUrl = imageId ? this.#thumbnailFor(imageId) : null;
      if (thumbUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'bindery-actor-image-picker-thumb';
        thumb.src = thumbUrl;
        thumb.alt = '';
        toggle.appendChild(thumb);
      }
      const text = document.createElement('span');
      text.textContent = image ? `p. ${image.provenance.pageNumber}` : game.i18n!.localize('BINDERY.review.actorImageNone' as never);
      toggle.appendChild(text);
    };
    renderToggleContent(currentId);

    const buildOption = (imageId: string, image: CIFImage | null): HTMLElement => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'bindery-actor-image-picker-option';
      const thumbUrl = image ? this.#thumbnailFor(image.id) : null;
      if (thumbUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'bindery-actor-image-picker-thumb';
        thumb.src = thumbUrl;
        thumb.alt = '';
        opt.appendChild(thumb);
      }
      const text = document.createElement('span');
      text.textContent = image ? `p. ${image.provenance.pageNumber}` : game.i18n!.localize('BINDERY.review.actorImageNone' as never);
      opt.appendChild(text);
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        renderToggleContent(imageId);
        onSelect(imageId);
      });
      return opt;
    };

    menu.appendChild(buildOption('', null));
    for (const image of images) menu.appendChild(buildOption(image.id, image));

    const closeOnOutsideClick = (ev: MouseEvent): void => {
      if (wrap.contains(ev.target as Node)) return;
      menu.hidden = true;
      document.removeEventListener('click', closeOnOutsideClick);
    };
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      if (willOpen) document.addEventListener('click', closeOnOutsideClick);
    });

    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    return wrap;
  }

  #renderActorNotesInto(container: HTMLElement, preview: AdapterResult<Coc7ActorPayload> | undefined): void {
    container.innerHTML = '';
    if (!preview) return;
    for (const issue of preview.issues) {
      const p = document.createElement('p');
      p.className = `bindery-actor-note bindery-actor-note-${issue.severity}`;
      p.textContent = localizeMessage('coc7', issue);
      container.appendChild(p);
    }
    for (const note of preview.notes) {
      const p = document.createElement('p');
      p.className = 'bindery-actor-note bindery-actor-note-info';
      p.textContent = localizeMessage('coc7', note);
      container.appendChild(p);
    }
  }

  /** Refreshes SOLELY the notes of ONE row (after editing a field) — without a full `render()`, so as not to lose the list's focus/scroll. */
  #refreshActorRowNotes(actorId: string): void {
    const box = this.element.querySelector<HTMLElement>(`[data-actor-notes-for="${actorId}"]`);
    if (box) this.#renderActorNotesInto(box, this.#actorAdapterPreview.get(actorId));
  }

  static #onSelectAllActors(this: ReviewScreen): void {
    this.#actorSelection.selectAll();
    void this.render();
  }
  static #onSelectNoActors(this: ReviewScreen): void {
    this.#actorSelection.selectNone();
    void this.render();
  }

  /** [Bug fix — see `#refreshHeaderCounts`, the same bug, the same `.bindery-review-counts` relic.] */
  async #refreshActorHeaderCounts(): Promise<void> {
    this.#refreshFooter();
    const el = this.element.querySelector<HTMLElement>('[data-count="actors"]');
    if (!el || this.#tab !== 'actors') return;
    el.textContent = `${game.i18n!.localize('BINDERY.review.selectedCount' as never)}: ${this.#actorSelection.selectedCount}/${(this.#data.document.actors ?? []).length}`;
  }

  #refreshActorRowHighlights(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('.bindery-actor-row');
    for (const row of rows) {
      row.classList.toggle('bindery-row-highlighted', row.dataset['actorId'] === this.#highlightedActorId);
    }
  }

  /** [Step 20 Z2] `provenance` navigation in BOTH directions — mirrors the images' `#mountOverlay`/`#redrawOverlay`, but without "select and crop" mode (doesn't apply to actors). */
  async #redrawActorOverlay(): Promise<void> {
    await this.#mountActorOverlay(this.#data.document.actors ?? []);
  }

  async #mountActorOverlay(actors: readonly CIFActor[]): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    // [Bug fix — see the identical comment in `#mountOverlay`.]
    const requestedPageNumber = this.#currentPageNumber;
    const box = await this.#data.previewDocument.getPageBox(requestedPageNumber);
    if (this.#currentPageNumber !== requestedPageNumber) return;
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const actor of actors) {
        if (actor.provenance.pageNumber !== this.#currentPageNumber) continue;
        const screen = pdfRectToScreen(actor.provenance.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const classes = [this.#actorSelection.isSelected(actor.id) ? 'bindery-overlay-selected' : 'bindery-overlay-unselected'];
        if (actor.id === this.#highlightedActorId) classes.push('bindery-overlay-highlighted');
        rect.setAttribute('class', classes.join(' '));
        rect.dataset['actorId'] = actor.id;
        rect.addEventListener('click', () => {
          this.#highlightedActorId = actor.id;
          // [Step 21] Without VirtualList (see the `#mountActorList` comment) — the row
          // is already in the DOM, a plain scroll-into-view is enough.
          this.element.querySelector(`.bindery-actor-row[data-actor-id="${actor.id}"]`)?.scrollIntoView({ block: 'nearest' });
          this.#refreshActorRowHighlights();
          draw();
        });
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
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
    label.textContent = `${scene.name} — p. ${scene.provenance.pageNumber}`;
    row.appendChild(label);
    return row;
  }

  // ---- Journal tree (Z5) ------------------------------------------------

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

  // ---- Diagnostics (Z7) -----------------------------------------------------

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
      jump.textContent = `p. ${firstPage}`;
      jump.addEventListener('click', () => {
        this.#currentPageNumber = firstPage;
        this.#tab = 'images';
        void this.render();
      });
      row.appendChild(jump);
    }
    return row;
  }

  // ---- Tabs / step (Z2/Z6) -----------------------------------------------

  static #onSwitchTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const tab = target.dataset['tab'] as ReviewTab | undefined;
    if (!tab) return;
    this.#tab = tab;
    void this.render();
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
    const actorFolder = this.element.querySelector<HTMLInputElement>('input[name="actorFolder"]');
    const imagePath = this.element.querySelector<HTMLInputElement>('input[name="imagePath"]');
    const namePrefix = this.element.querySelector<HTMLInputElement>('input[name="namePrefix"]');
    sceneFolder?.addEventListener('change', () => (this.#targets.sceneFolder = sceneFolder.value));
    journalFolder?.addEventListener('change', () => (this.#targets.journalFolder = journalFolder.value));
    actorFolder?.addEventListener('change', () => (this.#targets.actorFolder = actorFolder.value));
    namePrefix?.addEventListener('change', () => (this.#targets.namePrefix = namePrefix.value));
    if (imagePath) {
      imagePath.value = game.settings!.get(MODULE_ID, 'uploadPath') as string;
      imagePath.addEventListener('change', () => void game.settings!.set(MODULE_ID, 'uploadPath', imagePath.value));
    }
  }

  // ---- Import (Z6) --------------------------------------------------------

  static async #onConfirmImport(this: ReviewScreen): Promise<void> {
    this.#isImporting = true;
    this.#importError = null;
    await this.render();

    try {
      await game.settings!.set(MODULE_ID, 'importTargets', { ...this.#targets });
      const summary = await this.#runImport();
      this.#summaryEntries = summary.entries;
      this.#summaryDiagnostics = summary.diagnostics;
      this.#settled = true;
      this.#resolve?.({ confirmed: true });
      this.#step = 'summary';
    } catch (err) {
      this.#importError = game.i18n!.localize('BINDERY.review.importErrorGeneric');
      console.warn('Bindery | import from the review screen failed:', err);
    } finally {
      this.#isImporting = false;
      await this.render();
    }
  }

  async #runImport(): Promise<{ entries: { label: string; uuid?: string }[]; diagnostics: Diagnostic[] }> {
    const doc = this.#data.document;
    const baseName = this.#data.fileName.replace(/\.pdf$/i, '') || 'bindery-import';
    const prefix = this.#targets.namePrefix.trim();
    const withPrefix = (name: string): string => (prefix ? `${prefix} ${name}` : name);
    // The uploaded FILE's name mirrors the document name the user actually
    // typed in the Images tab (`image.caption`), sanitized by `uploadImage`
    // itself — an empty caption keeps the previous, PDF-filename+id scheme
    // unchanged.
    const uploadBaseNameFor = (image: CIFImage): string => (image.caption?.trim() ? `${baseName}-${image.caption.trim()}` : `${baseName}-${image.id}`);

    const entries: { label: string; uuid?: string }[] = [];
    const runDiagnostics: Diagnostic[] = [];

    // Scenes — SOLELY the selected ones.
    const sceneFolderId = await ensureFolder(this.#targets.sceneFolder, 'Scene');
    // [Step 14 Z4, fixed in Step 16 Z2] Images already handled via CIFScene
    // (below) or embedded in a journal (further down) do NOT pass through
    // the per-image destination loop again — the same image shouldn't get
    // TWO documents. SOLELY for scenes/journals/pages that are ACTUALLY
    // selected — the original version added `scene.imageRef`
    // unconditionally, so an image belonging to an UNSELECTED (and thus
    // never created) CIFScene was nonetheless excluded from the per-image
    // destination loop in the Images tab ("the scene isn't created" — the
    // image got NO document at all, contrary to the user's intent set in
    // the dropdown).
    const usedImageIds = new Set<string>();
    // [Step 20] See the comment next to `SCENES_JOURNALS_FROM_CIF_ENABLED`
    // at the top of the file — CIFScene/CIFJournal auto-detection is
    // disabled "for now", the same images are still available in the Images
    // tab with a Scene/Journal Destination.
    if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
      for (const scene of doc.scenes) {
        if (this.#selection.isSceneSelected(scene.id)) usedImageIds.add(scene.imageRef);
      }

      for (const scene of doc.scenes) {
        if (!this.#selection.isSceneSelected(scene.id)) continue;
        const image = doc.images.find((i) => i.id === scene.imageRef);
        const bytes = this.#data.imageBytesById.get(scene.imageRef);
        if (!image || !bytes) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_IMAGE_MISSING', params: { name: scene.name, imageRef: scene.imageRef }, pageNumber: scene.provenance.pageNumber });
          continue;
        }
        try {
          const upload = await uploadImage({ bytes: bytes.bytes, baseName: `${baseName}-${scene.imageRef}`, format: bytes.format === 'png' ? 'png' : 'webp' });
          const name = withPrefix(scene.name);
          const grid = await this.#pickGridForImage(bytes, image);
          const created = await createSceneFromImage({ name, imagePath: upload.path, width: image.width, height: image.height, grid, folder: sceneFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } catch (err) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_CREATE_FAILED', params: { name: scene.name, error: err instanceof Error ? err.message : String(err) }, pageNumber: scene.provenance.pageNumber });
        }
      }
    }

    // Journals — SOLELY selected journals, SOLELY selected pages within them.
    const journalFolderId = await ensureFolder(this.#targets.journalFolder, 'JournalEntry');
    if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
      const filteredJournals: CIFJournalForCreation[] = [];
      for (const journal of doc.journals) {
        if (!this.#selection.isJournalSelected(journal.id)) continue;
        const pages = journal.pages.filter((p) => this.#selection.isJournalPageSelected(p.id));
        if (pages.length === 0) continue;
        for (const p of pages) for (const id of p.imageRefs) usedImageIds.add(id);
        filteredJournals.push({ name: withPrefix(journal.name), pages: pages.map((p) => ({ name: p.name, headingLevel: p.headingLevel, html: p.html })) });
      }
      if (filteredJournals.length > 0) {
        const imagesForUpload = doc.images.filter((i) => usedImageIds.has(i.id)).map((i) => ({ id: i.id, format: i.format }));
        const result = await createJournalsFromCIF({
          journals: filteredJournals,
          images: imagesForUpload,
          imageBytesById: this.#data.imageBytesById,
          baseName,
          folder: journalFolderId,
        });
        for (const j of result.createdJournals) entries.push({ label: j.name, uuid: j.uuid });
        for (const missing of result.missingImageIds) {
          runDiagnostics.push({ severity: 'warning', code: 'REVIEW_JOURNAL_IMAGE_MISSING', params: { imageId: missing } });
        }
      }
    }

    const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);

    // [Step 19, gap reported live: "I'm missing better sorting of
    // journals"] Images with the `journal` destination AND a non-empty
    // group name (set in the Images tab — per-image or in bulk) go
    // TOGETHER into ONE JournalEntry (multiple image-type pages), instead of
    // each getting its own separate journal as before. Images with an EMPTY
    // group (the default) keep the old behavior — handled by the per-image
    // loop below, which skips images already in `usedImageIds`.
    const journalGroups = new Map<string, CIFImage[]>();
    for (const image of doc.images) {
      if (usedImageIds.has(image.id)) continue;
      if (!this.#selection.isImageSelected(image.id)) continue;
      if (this.#selection.imageDestination(image.id) !== 'journal') continue;
      const group = this.#selection.imageJournalGroup(image.id);
      if (!group) continue;
      // Claimed right away (not only after successful processing below) —
      // this image BELONGS to the group regardless of whether its
      // processing succeeds; the per-image loop below shouldn't touch it
      // even on error (avoids duplicate diagnostics for the same image).
      usedImageIds.add(image.id);
      const list = journalGroups.get(group) ?? [];
      list.push(image);
      journalGroups.set(group, list);
    }
    for (const [groupName, groupImages] of journalGroups) {
      const pages: { name: string; imagePath: string }[] = [];
      for (const image of groupImages) {
        const bytes = this.#data.imageBytesById.get(image.id);
        if (!bytes) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
          continue;
        }
        try {
          const upload = await uploadImage({ bytes: bytes.bytes, baseName: uploadBaseNameFor(image), format: bytes.format === 'png' ? 'png' : 'webp' });
          pages.push({ name: withPrefix(image.caption?.trim() || `${defaultImageName} p.${image.provenance.pageNumber}`), imagePath: upload.path });
        } catch (err) {
          // [Step 27 Z1] A code distinct from `REVIEW_IMAGE_DESTINATION_FAILED` below —
          // a different parameter shape (imageId+groupName, not name+destination), so
          // a shared code would give an inconsistent localization template.
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_JOURNAL_GROUP_FAILED', params: { imageId: image.id, groupName, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
        }
      }
      if (pages.length === 0) continue;
      try {
        const created = await createJournalHandoutFromImages({ name: withPrefix(groupName), pages, folder: journalFolderId });
        entries.push({ label: created.name, uuid: created.uuid });
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_JOURNAL_GROUP_CREATE_FAILED', params: { groupName, error: err instanceof Error ? err.message : String(err) } });
      }
    }

    // [Step 35 Z2] The UPLOADED `token` image path per `CIFImage.id` — the
    // only bridge between the Images tab (what was ACTUALLY uploaded,
    // below) and the Actors tab (what the author CHOSE as token/portrait,
    // `ctx.imagePathResolver` passed to the adapter). Intent: an image
    // chosen as token that for some reason didn't end up HERE (deselected
    // in the Images tab, destination changed, upload error — see the
    // `catch` below) simply has no entry here, so the resolver returns
    // `null` and the adapter degrades with an explicit warning instead of
    // writing a path to a nonexistent file (A3/A7, Z2 brief).
    const uploadedTokenImagePathById = new Map<string, string>();

    // [Step 14 Z4] Per-image destination (Images tab) — SOLELY selected
    // images that have NOT already been handled as a CIFScene, embedded in
    // a journal, or gathered into a journal group above. `scene`/`journal`/
    // `token` are created directly from a SINGLE image (MDD v2.1 §1.2, P1);
    // `unassigned` (formerly `skip` — user request, see
    // `defaultImageDestination`) is skipped.
    for (const image of doc.images) {
      if (usedImageIds.has(image.id)) continue;
      if (!this.#selection.isImageSelected(image.id)) continue;
      const destination = this.#selection.imageDestination(image.id);
      if (destination === 'unassigned') continue;

      const bytes = this.#data.imageBytesById.get(image.id);
      if (!bytes) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
        continue;
      }
      const name = withPrefix(image.caption?.trim() || `${defaultImageName} p.${image.provenance.pageNumber}`);
      try {
        const upload = await uploadImage({ bytes: bytes.bytes, baseName: uploadBaseNameFor(image), format: bytes.format === 'png' ? 'png' : 'webp' });
        if (destination === 'scene') {
          const grid = await this.#pickGridForImage(bytes, image);
          const created = await createSceneFromImage({ name, imagePath: upload.path, width: image.width, height: image.height, grid, folder: sceneFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } else if (destination === 'journal') {
          const created = await createJournalHandoutFromImage({ name, imagePath: upload.path, folder: journalFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } else {
          // [Step 14 Z4, fixed in Step 16 Z2] 'token' — saved to disk,
          // without creating a document (brief). Originally, a label
          // without a path was INDISTINGUISHABLE from "nothing happened"
          // ("I can't see where the tokens are being saved") — we append
          // the real path returned by `FilePicker.upload()`, the only trace
          // of this save visible to the user (no document, hence no
          // `uuid`/link to open).
          entries.push({ label: `${name} — ${upload.path}` });
          // [Step 35 Z2] Recorded AFTER a successful upload — see the
          // comment next to `uploadedTokenImagePathById` above.
          uploadedTokenImagePathById.set(image.id, upload.path);
        }
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_DESTINATION_FAILED', params: { name, destination, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
      }
    }

    // [Step 20 Z2] Actors — SOLELY selected ones, AFTER user overrides
    // (`applyActorOverrides`), with adapter notes TURNED ON (unlike
    // `tools/build-z4-measurement-macro.ts` from step 19, which deliberately
    // zeroed them SOLELY for measurement — the actual product always computes
    // them, A3/A10).
    const selectedActors = (doc.actors ?? []).filter((a) => this.#actorSelection.isSelected(a.id));
    if (selectedActors.length > 0) {
      const actorFolderId = await ensureFolder(this.#targets.actorFolder, 'Actor');
      const actorResults = selectedActors.map((actor) => {
        const patched = applyActorOverrides(actor, this.#actorSelection);
        // [Step 35 Z1/Z2] `tokenImageRef`/`portraitImageRef` — the id of the
        // image CHOSEN by the author in the Actors tab (empty string =
        // "none"), resolved to a path SOLELY via `imagePathResolver` (see
        // `uploadedTokenImagePathById` above) — the adapter degrades on its
        // own when the resolver returns `null`.
        const ctx = {
          folderId: actorFolderId ?? null,
          imagePathResolver: (ref: string) => uploadedTokenImagePathById.get(ref) ?? null,
          language: doc.source.detectedLanguage,
          profileId: doc.source.detectedProfileId,
          tokenImageRef: this.#actorSelection.tokenImageId(actor.id) || null,
          portraitImageRef: this.#actorSelection.portraitImageId(actor.id) || null,
        };
        // See the comment next to `#rebuildActorAdapterPreview` — the same safe cast, our OWN `coc7Adapter` implementation.
        return coc7Adapter.fromActor(patched, ctx) as AdapterResult<Coc7ActorPayload>;
      });
      try {
        const created = await createActorsFromAdapterResults({ results: actorResults, folder: actorFolderId });
        for (const entry of created) {
          entries.push({ label: entry.actor.name as unknown as string, uuid: (entry.actor as unknown as { uuid?: string }).uuid });
          // [Step 27 Z1] Without an "actor name: " prefix — the issue's
          // parameters (e.g. `UNCERTAIN_NAME`'s `name`) already carry the
          // same name; duplicating it here (the previous shape, using
          // `.message`) was visible redundancy ("X: Uncertain name: X..."),
          // not an intentional feature.
          for (const issue of entry.issues) {
            runDiagnostics.push({ severity: issue.severity, code: issue.code, params: issue.params });
          }
        }
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_ACTOR_CREATE_FAILED', params: { error: err instanceof Error ? err.message : String(err) } });
      }
    }

    return { entries, diagnostics: runDiagnostics };
  }

  /**
   * [Step 16 Z2, wiring in GridPicker] Opens `GridPicker` (built in step 8,
   * never called from anywhere until now — dead code) with a LIVE preview of
   * the SPECIFIC image, instead of giving every scene the same, ill-fitting
   * starting point. The user can confirm (the calibration is saved as
   * `lastGridConfig` — the starting slider position for the NEXT scene, so
   * as not to start from scratch on similar maps) or cancel — in which case
   * we use the LAST CONFIRMED calibration as a reasonable approximation (an
   * explicit user choice to "skip", not a silent imposition of someone
   * else's settings like in the original bug — see this file's history).
   */
  async #pickGridForImage(bytes: { bytes: Uint8Array; format: string }, image: { width: number; height: number; suggestedGrid?: CIFImage['suggestedGrid'] }): Promise<GridConfig> {
    const mime = bytes.format === 'png' ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes.bytes)], { type: mime }));
    try {
      // [Step 17] The auto-detection suggestion is passed SOLELY when
      // confidence exceeds the "worth showing" threshold — below it, the
      // last manual calibration (`lastGridConfig`, see `GridPickerApp.pick`)
      // is a better starting point than guessing on a weak signal.
      const suggested = image.suggestedGrid;
      const suggestedGrid =
        suggested && suggested.confidence >= MIN_GRID_SUGGESTION_CONFIDENCE
          ? { size: suggested.size, offsetX: suggested.offsetX, offsetY: suggested.offsetY }
          : undefined;
      const picked = await pickGrid({ imageDataUrl: url, imageWidth: image.width, imageHeight: image.height, suggestedGrid });
      if (picked) return picked;
      return game.settings!.get(MODULE_ID, 'lastGridConfig') as GridConfig;
    } finally {
      URL.revokeObjectURL(url);
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
