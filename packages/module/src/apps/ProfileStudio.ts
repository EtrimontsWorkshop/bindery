import type {
  AttachGeometryMeasurement,
  DocumentAnalysis,
  EntityAnalysis,
  IndexedSelectionToken,
  ItemShapeCode,
  LabelledPairConfidence,
  OverlapWarning,
  PageAnalysis,
  PageRoute,
  PatternMatchCount,
  PreviewDocument,
  ProfileV2,
  Rect,
  RelationCheckResult,
  StudioRegionKind,
  ValueCandidate,
} from '@bindery/core';
import { ASSET_BASE_URL } from '../settings.js';
import { validateActorProfileFile } from '../api.js';
import {
  createEmptyProfileDraft,
  createPatternDraft,
  draftToProfileInput,
  escapeSectionBoundaryLiteral,
  profileToDraft,
  type AttachRuleDraft,
  type FontRoleCandidatePatternDraft,
  type LabelEntryDraft,
  type PatternDraft,
  type PatternEntryDraft,
  type ProfileDraft,
} from '../review/profileDraft.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * [Step 22] Profile Studio — the profile-author tool (separate from
 * `ImportWizard`/`ReviewScreen`, which handle importing). All analysis
 * (`analyzeProfileDocument` and other `@bindery/core` functions) lives in the
 * core — this file ONLY draws the UI and handles events (`check:boundary`).
 *
 * [Step 28, screen-architecture CORRECTION] The previous version (steps 22-27)
 * had three tabs mixing three different axes (Page=material view, Whole
 * document=results view, Editor=work mode), with no representation at all of
 * the fourth, most important axis: WHICH PART OF THE PROFILE is currently
 * being built. Hence two problems reported by the product owner: the panel
 * showed three messages at once (because it didn't know what state it was
 * in), and it was only possible to add traits from the page view — to point
 * out a derived stat (e.g. PW), you had to switch to the Editor, and even
 * there you couldn't click it on the PDF, because no "pointing at derived
 * stats" state existed.
 *
 * New architecture: **entry screen** (New profile / Edit profile) ->
 * **build screen** (PDF on the left, panel on the right). The panel tabs are
 * NOW profile PATTERNS — Traits/Derived/Attacks/Skills/Name/Check —
 * not views. Clicking in the PDF applies ONLY to the active tab: this
 * solves problem #2 AT THE SOURCE (a label is created from a click IN THE
 * CONTEXT of the tab the author is currently on, not from a separate "create
 * label" step). The Z1-Z6 mechanics from the previous version (targeted
 * redraw without a full `render()`, automatic reading of the value next to a
 * label, section boundaries via dragging, a leader line, hidden advanced
 * settings) remain UNCHANGED — the correction concerns ONLY what hosts them.
 *
 * [I3] Static import in `settings.ts` (`registerMenu` requires the class to
 * be available synchronously) — that's why this file NEVER imports
 * `@bindery/core` as a REAL module-level value, ONLY as `import type` plus a
 * dynamic `import()` inside methods. `check:size` (the <40KB world-startup
 * budget) enforces this in CI.
 */

interface ProfileSummary {
  title: string;
  publication: string;
  gameLine: string;
  language: string;
  patternCount: number;
}

type BuildTab = 'grid' | 'derived' | 'attacks' | 'skills' | 'notes' | 'name' | 'check';
type EntryMode = 'choose' | 'new' | 'edit';

const ROUTE_OPTIONS: readonly PageRoute[] = ['npc', 'playerCharacter'];

/**
 * [Step 39 Z2] `ProfileDraft` fields specific to a SINGLE route — exactly
 * what the schema (`schema.ts`, `@bindery/core`) creates as `PatternSet`
 * (`patterns`/`entityAssembly`), flattened into the draft's shape. The rest
 * of `ProfileDraft`'s fields (profile metadata) are SHARED between both
 * routes — see `#activeRoute` in `ProfileStudio`.
 */
type RoutePatternSlice = Pick<ProfileDraft, 'patterns' | 'anchor' | 'attach' | 'nameConfidenceThreshold' | 'namePlaceholder' | 'skillsPattern' | 'typeLabelPattern' | 'notesPatterns'>;

function extractRouteSlice(draft: ProfileDraft): RoutePatternSlice {
  return {
    patterns: draft.patterns,
    anchor: draft.anchor,
    attach: draft.attach,
    nameConfidenceThreshold: draft.nameConfidenceThreshold,
    namePlaceholder: draft.namePlaceholder,
    skillsPattern: draft.skillsPattern,
    typeLabelPattern: draft.typeLabelPattern,
    notesPatterns: draft.notesPatterns,
  };
}

function applyRouteSlice(draft: ProfileDraft, slice: RoutePatternSlice): void {
  draft.patterns = slice.patterns;
  draft.anchor = slice.anchor;
  draft.attach = slice.attach;
  draft.nameConfidenceThreshold = slice.nameConfidenceThreshold;
  draft.namePlaceholder = slice.namePlaceholder;
  draft.skillsPattern = slice.skillsPattern;
  draft.typeLabelPattern = slice.typeLabelPattern;
  draft.notesPatterns = slice.notesPatterns;
}

/** [Step 39 Z2] Starting point for the `playerCharacter` route, when the author switches to it for the first time in this editing session — the same default values as `createEmptyProfileDraft`, but ONLY for the per-route fields (`RoutePatternSlice`). */
function emptyRouteSlice(): RoutePatternSlice {
  return { patterns: [], anchor: '', attach: [], nameConfidenceThreshold: 0.7, namePlaceholder: 'NPC #{ordinal} (p. {page})', skillsPattern: '', typeLabelPattern: '', notesPatterns: [] };
}

interface StudioState {
  /**
   * [Step 28 correction] Entry screen (two options, nothing else) vs. build screen (PDF + pattern tabs).
   * [user report: "it would be good to show the metadata step first, and
   * only proceed after it's filled in"] `'metadata'` was inserted BETWEEN
   * them — `#maybeEnterBuildScreen` (New/Edit profile, after the required
   * files are loaded) lands HERE, not directly in `'build'`. Without this
   * step, an author building a new profile would land on "Check"/"Notes"
   * (which validate the ENTIRE draft, see `#onNoteTokenClick`) with
   * `id`/`gameLine`/`language`/`title`/`publication` all defaulting to
   * empty — five fields that don't matter for the matching itself, but are
   * required by the file schema (`profileV2Schema`), and they'd only find
   * out about it from a validation error WHILE TRYING to use a completely
   * different feature.
   */
  screen: 'entry' | 'metadata' | 'build';
  /** Which entry-screen path is in progress — `'choose'` = just the two buttons, `'new'`/`'edit'` = the corresponding file picker(s). */
  entryMode: EntryMode;
  pdfFileName: string | null;
  profileFileName: string | null;
  profileSummary: ProfileSummary | null;
  profileIssues: readonly string[] | null;
  isAnalyzing: boolean;
  analyzeProgress: { done: number; total: number } | null;
  analyzeError: string | null;
  currentPageNumber: number;
  pageCount: number;
  /** [Step 28 correction] Build-screen tab — EACH ONE is a single profile pattern, not a view. `'check'` (formerly "Whole document") is always last. */
  buildTab: BuildTab;
  /** `validateProfile` errors after "Save"/a run — human-readable, never an exception. */
  editorIssues: readonly string[] | null;
  rawJsonMode: boolean;
  rawJsonError: string | null;
  /** [Step 24 Z1] "Draw an area with the mouse" mode — available ONLY on the Traits/Derived tabs (section boundaries are set geometrically, Z3, not by area selection). */
  isSelectAreaMode: boolean;
}

/** [Step 23 Z6] The target of the current "pick on page" action from the advanced form — clicking a token inserts its text into this field. `null` = picking mode inactive. */
interface PickTarget {
  description: string;
  apply: (text: string) => void;
}

/** [Step 24 Z1, simplified in the Step 28 correction] A proposal from drawing an area — ONLY label-value pairs (grid/derived). Sections are built geometrically (Z3), not via bulk selection, so `select area` is only available on the Traits/Derived tabs — `slot` says which one. */
interface SelectionProposal {
  slot: 'grid' | 'derived';
  pairs: { label: string; value: string; canonicalKey: string; checked: boolean; confidence: LabelledPairConfidence }[];
  rawPreview: string;
}

/** [Step 24 Z2] Geometry-measurement state per attach-rule row — keyed by the `AttachRuleDraft` object REFERENCE, so it survives the panel being rebuilt on every targeted redraw. */
type MeasurementState = { state: 'measuring' } | { state: 'error'; message: string } | { state: 'done'; result: AttachGeometryMeasurement };

const BUILD_TABS: readonly BuildTab[] = ['grid', 'derived', 'attacks', 'skills', 'notes', 'name', 'check'];

export class ProfileStudio extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-profile-studio',
    classes: ['bindery', 'bindery-profile-studio'],
    window: {
      title: 'BINDERY.studio.title',
      resizable: true,
      icon: 'fa-solid fa-flask',
    },
    // [user report: "looks very hard to read"] Raised together with the
    // rest of the redesign, for the same reason as ReviewScreen (the
    // "Visual redesign" step): the two-column layout of the page preview
    // (340px) plus the build panel got cramped in a narrow window,
    // especially with the wider controls (the `.bindery-input`/
    // `.bindery-select` pills, which have a larger `min-width` than the old,
    // narrow inputs).
    position: { width: 1180, height: 720 },
    actions: {
      chooseNewProfile: ProfileStudio.#onChooseNewProfile,
      chooseEditProfile: ProfileStudio.#onChooseEditProfile,
      backToEntry: ProfileStudio.#onBackToEntry,
      continueFromMetadataStep: ProfileStudio.#onContinueFromMetadataStep,
      switchBuildTab: ProfileStudio.#onSwitchBuildTab,
      switchRoute: ProfileStudio.#onSwitchRoute,
      runFullScan: ProfileStudio.#onRunFullScan,
      exportDiagnostics: ProfileStudio.#onExportDiagnostics,
      prevPage: ProfileStudio.#onPrevPage,
      nextPage: ProfileStudio.#onNextPage,
      saveProfileJson: ProfileStudio.#onSaveProfileJson,
      toggleRawJsonMode: ProfileStudio.#onToggleRawJsonMode,
      toggleSelectArea: ProfileStudio.#onToggleSelectArea,
    },
  };

  static override PARTS = {
    main: { template: 'modules/bindery-pdf-importer/templates/profile-studio.hbs' },
  };

  #state: StudioState = {
    screen: 'entry',
    entryMode: 'choose',
    pdfFileName: null,
    profileFileName: null,
    profileSummary: null,
    profileIssues: null,
    isAnalyzing: false,
    analyzeProgress: null,
    analyzeError: null,
    currentPageNumber: 1,
    pageCount: 0,
    buildTab: 'grid',
    editorIssues: null,
    rawJsonMode: false,
    rawJsonError: null,
    isSelectAreaMode: false,
  };

  #pdfBuffer: ArrayBuffer | null = null;
  #profile: ProfileV2 | null = null;
  #previewDocument: PreviewDocument | null = null;
  #docAnalysis: DocumentAnalysis | null = null;
  #scanController: AbortController | null = null;

  static readonly #PAGE_CACHE_SIZE = 6;
  #pageImageCache = new Map<number, string>();
  #pageImageOrder: number[] = [];
  #pageRenderToken = 0;

  /**
   * [Bug reproduced live] Resizing the window changes
   * `img.clientWidth/clientHeight` (the image is `width:100%`), but
   * `#mountOverlay`/`#mountPickableTokens` compute the SVG overlay size ONLY
   * at the moment they draw themselves — without this observer, nothing
   * triggered a redraw on a window resize BY ITSELF (only switching pages
   * and back forced a redraw), so the clickable rectangles on the PDF would
   * drift out of alignment with the text after a window resize.
   * `ResizeObserver` on the `<img>` (not on the `<svg>`, which this same
   * redraw modifies itself — observing its own drawing target would create a
   * loop) triggers the SAME drawing sequence as `_onRender`, every time the
   * image's actual on-screen size changes, regardless of the cause.
   */
  #overlayResizeObserver: ResizeObserver | null = null;

  #highlighted: { entityOrdinal: number; kind: StudioRegionKind } | null = null;

  #draft: ProfileDraft | null = null;
  /**
   * [Step 39 Z2] Which route (`pageRoute.ts`, `@bindery/core`) is CURRENTLY
   * being edited. `#draft`'s route-specific fields (see `RoutePatternSlice`
   * below: `patterns`/`anchor`/`attach`/`nameConfidenceThreshold`/
   * `namePlaceholder`/`skillsPattern`/`typeLabelPattern`/`notesPatterns`)
   * ALWAYS belong to THIS route — the rest of `#draft`'s fields (profile
   * metadata: id/gameLine/title/pages/images/...) are SHARED between both
   * routes and are NEVER swapped out on switching, see `#switchRoute`.
   */
  #activeRoute: PageRoute = 'npc';
  /** [Step 39 Z2] The `npc` route's pattern slice, set aside when `#activeRoute !== 'npc'` — `null` until the author has visited/left the `npc` route at least once in this editing session (when a profile is loaded it is ALWAYS populated, since `#activeRoute` starts as `'npc'`). See `#switchRoute`/`#extractRouteSlice`. */
  #npcRouteSlice: RoutePatternSlice | null = null;
  /** [Step 39 Z2] As above, for the `playerCharacter` route — `null` when the profile doesn't have it yet (no `playerCharacter` section = route unsupported, `schema.ts`). */
  #playerCharacterRouteSlice: RoutePatternSlice | null = null;
  #rawJsonText = '';
  #pickTarget: PickTarget | null = null;

  // ---- [Step 24 Z1] Pattern inference from a mouse selection ----------------
  #dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null = null;
  #selectionProposal: SelectionProposal | null = null;

  // ---- [Step 24 Z2] Geometry measurement per attach rule ---------------
  #measurements = new Map<AttachRuleDraft, MeasurementState>();

  // ---- [Step 24 Z3] Mechanic-mapping verification ------------------------
  #mechanicalRelations: string[] = [''];
  #mechanicalResults: RelationCheckResult[] | null = null;

  // ---- [Step 28, CORRECTION] Building the profile by pointing, per tab ---
  /** Tokens for the ENTIRE current page, with their index in the stream. */
  #buildTokensCache = new Map<number, IndexedSelectionToken[]>();
  /** [Correction] Each pattern tab has its OWN, explicit slot — unlike the previous version (one "active" pattern shared by everything), which was exactly the source of the reported "you can only add traits" problem. */
  #activeGridPatternId: string | null = null;
  #activeDerivedPatternId: string | null = null;
  #activeAttackPatternId: string | null = null;
  #activeSkillsPatternId: string | null = null;
  #activeNamePatternId: string | null = null;
  /** [Report after step 30, "Separating the name from the type/occupation"] A second, independent slot on the SAME "Name" tab — see `#nameSubMode`. */
  #activeTypeLabelPatternId: string | null = null;
  /** [Report after step 30] Which of the two pointing modes on the "Name" tab is active — one tab, two aspects of the same entity (name/occupation), not two separate tabs. */
  #nameSubMode: 'name' | 'typeLabel' = 'name';
  /**
   * [Step 34 Z2] The "Notes" tab is DIFFERENT from the rest — MANY
   * independent blocks (`draft.notesPatterns`, order = list order), not one
   * slot per tab. Instead of `#activeXPatternId`, this state tracks WHICH
   * block is currently waiting for a click on the PDF, to measure its
   * `offset` (`null` = none, clicks on this tab do nothing).
   */
  #notesPickPatternId: string | null = null;
  /**
   * [Step 34 Z2] Per-note-block preview, computed ONLY on request
   * (click/"Refresh preview"), never automatically on every redraw (avoids a
   * rendering loop) — see `#refreshNotePreview`. `'loading'` while computing,
   * `null` when it hasn't been computed yet AND isn't computing right now, an
   * `{ordinal,text}[]` array (one entry per entity found on the CURRENT page)
   * once done.
   */
  #notesPreview = new Map<string, 'loading' | { ordinal: number; text: string | null }[]>();
  /** [Z2] Panel preview ONLY ("S → Strength [140]") — the value is NEVER saved into the draft, key `patternId:label`. */
  #buildPairPreviewValues = new Map<string, string>();
  /** [Z2] Clicking a label produced MORE THAN ONE value candidate — we wait for a SECOND click instead of guessing (A10). */
  #pendingValueChoice: { slot: 'grid' | 'derived'; labelText: string; labelBbox: Rect; candidates: readonly ValueCandidate[] } | null = null;
  /** [Z3] Which section (Attacks/Skills) is "in focus" for boundary dragging — page and header index together, since the overlay only makes sense on the page where the header was clicked. */
  #sectionBoundaryFocus: { patternId: string; page: number; headerTokenIndex: number } | null = null;
  /** [Z3] Active drag of a section's lower boundary edge. */
  #boundaryDrag: {
    patternId: string;
    headerTokenIndex: number;
    startPdfY: number;
    pageWidthPx: number;
    pageHeightPx: number;
    overlapCheckBboxes: readonly Rect[];
  } | null = null;
  /** [Step 29 Z1] Sample item texts clicked by the author, keyed by `patternId` -- input to `inferItemPatternFromExamples`. Grows with each click in phase 3 (boundary already set), NEVER saved directly to the draft (only the generated `itemPattern` is). */
  #itemPatternExamples = new Map<string, string[]>();
  /** [Step 29 Z1] Last recognized shape per pattern — ONLY for the human-readable message in the panel ("Recognized: name → percent → ..."), never a raw regex. */
  #itemPatternShape = new Map<string, ItemShapeCode>();

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const currentPageAnalysis = this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null;
    return {
      isScreenEntry: this.#state.screen === 'entry',
      isScreenMetadata: this.#state.screen === 'metadata',
      isScreenBuild: this.#state.screen === 'build',
      isEntryChoose: this.#state.entryMode === 'choose',
      isEntryNew: this.#state.entryMode === 'new',
      isEntryEdit: this.#state.entryMode === 'edit',
      pdfFileName: this.#state.pdfFileName,
      profileFileName: this.#state.profileFileName,
      profileSummary: this.#state.profileSummary,
      hasProfile: this.#state.profileSummary !== null,
      profileIssues: this.#state.profileIssues,
      hasProfileError: this.#state.profileIssues !== null,
      hasPdf: this.#pdfBuffer !== null,
      canEnterBuild: this.#pdfBuffer !== null && (this.#state.entryMode === 'new' || this.#state.profileSummary !== null),
      isAnalyzing: this.#state.isAnalyzing,
      analyzeProgress: this.#state.analyzeProgress,
      analyzeError: this.#state.analyzeError,
      hasAnalysis: this.#docAnalysis !== null,
      currentPageNumber: this.#state.currentPageNumber,
      pageCount: this.#state.pageCount,
      canGoPrevPage: this.#state.currentPageNumber > 1,
      canGoNextPage: this.#state.currentPageNumber < this.#state.pageCount,
      currentPageImageUrl: this.#pageImageCache.get(this.#state.currentPageNumber) ?? null,
      // [Step 39 Z2] Route switcher above the tabs — "NPCs and monsters" /
      // "Player characters" (per the brief). The tabs below (`buildTabs`) are
      // THE SAME regardless of route — built from a different data set
      // (`#draft` currently points at the ACTIVE route's slice, see
      // `#switchRoute`).
      activeRoute: this.#activeRoute,
      routeOptions: ROUTE_OPTIONS.map((route) => ({ id: route, active: route === this.#activeRoute, label: this.#routeLabel(route) })),
      buildTab: this.#state.buildTab,
      buildTabs: BUILD_TABS.map((tab) => ({
        id: tab,
        active: tab === this.#state.buildTab,
        label: game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never),
        badge: this.#computeTabBadge(tab),
      })),
      isBuildTabCheck: this.#state.buildTab === 'check',
      canSelectArea: this.#draft !== null && (this.#state.buildTab === 'grid' || this.#state.buildTab === 'derived'),
      isSelectAreaMode: this.#state.isSelectAreaMode,
      rawJsonMode: this.#state.rawJsonMode,
      editorIssues: this.#state.editorIssues,
      hasEditorIssues: this.#state.editorIssues !== null,
      pickHint: this.#pickTarget?.description ?? null,
      docSummary: this.#docAnalysis
        ? {
            totalEntities: this.#docAnalysis.totalEntities,
            totalWarnings: this.#docAnalysis.totalWarnings,
            totalPlaceholderNames: this.#docAnalysis.totalPlaceholderNames,
            pageCount: this.#docAnalysis.pageCount,
          }
        : null,
      _pageAnalysis: currentPageAnalysis as unknown,
      _docAnalysis: this.#docAnalysis as unknown,
    };
  }

  static readonly #BUILD_TAB_LABEL_KEYS: Readonly<Record<BuildTab, string>> = {
    grid: 'BINDERY.studio.buildTabGrid',
    derived: 'BINDERY.studio.buildTabDerived',
    attacks: 'BINDERY.studio.buildTabAttacks',
    skills: 'BINDERY.studio.buildTabSkills',
    notes: 'BINDERY.studio.buildTabNotes',
    name: 'BINDERY.studio.buildTabName',
    check: 'BINDERY.studio.buildTabCheck',
  };

  /** [Step 28 correction] "The author can see at a glance what's left to do, without clicking through tabs." Empty / count / warning — in this priority order (a warning beats a count). */
  #computeTabBadge(tab: BuildTab): { kind: 'empty' } | { kind: 'count'; n: number } | { kind: 'warning' } {
    if (tab === 'check') {
      if (this.#docAnalysis && this.#docAnalysis.totalWarnings > 0) return { kind: 'warning' };
      if (this.#docAnalysis) return { kind: 'count', n: this.#docAnalysis.totalWarnings };
      return { kind: 'empty' };
    }
    // [Step 34 Z2] Notes have MANY patterns at once (`draft.notesPatterns`),
    // not one slot like the rest of the tabs — just the COUNT of configured
    // blocks, without trying to derive a warning: `patternMatchTotals` for
    // `proseBlock` is ALWAYS 0 (it doesn't scan the page as text, see
    // `studioAnalysis.ts`), so "0 matches" carries no information here — the
    // real effectiveness is visible in the per-block preview below, not in
    // the tab badge.
    if (tab === 'notes') {
      const n = this.#draft?.notesPatterns.length ?? 0;
      if (n === 0) return { kind: 'empty' };
      // [Live report, see `#noteLooksTruncated`] Unlike the rest of the
      // comment above ("0 matches carries no information here") — THIS
      // signal IS meaningful, because it comes from an actual content
      // preview (`#notesPreview`), not from a raw pattern-match count.
      const looksTruncated = (this.#draft?.patterns ?? []).some(
        (e) => e.pattern.kind === 'proseBlock' && this.#draft!.notesPatterns.includes(e.id) && this.#noteLooksTruncated(e.pattern, this.#notesPreview.get(e.id)),
      );
      if (looksTruncated) return { kind: 'warning' };
      return { kind: 'count', n };
    }
    const patternId = this.#patternIdForTab(tab);
    const entry = this.#findPattern(patternId);
    if (!entry) return { kind: 'empty' };
    if (this.#tabHasWarning(tab, entry)) return { kind: 'warning' };
    if (entry.pattern.kind === 'labelledPairs') return entry.pattern.labels.length > 0 ? { kind: 'count', n: entry.pattern.labels.length } : { kind: 'empty' };
    return { kind: 'count', n: 1 };
  }

  /** Zero matches for a pattern across the whole book OR an overlap referencing a region of this type — ONLY once a full scan already exists (before that, the absence of warnings is expected, not "everything's OK"). */
  #tabHasWarning(tab: Exclude<BuildTab, 'check'>, entry: PatternEntryDraft): boolean {
    // [Live report, a repeat of the "Age: ends up matched into Name" bug on
    // a profile built from scratch on Forge] `#computeBuildGuidance` already
    // warns about missing `requireFontKeys` text — but ONLY while the author
    // is currently on the Name tab in this specific mode (Name/Occupation).
    // Click the example, move on to build Traits/Attacks/Notes, and never
    // come back to Name before saving — nothing warns you. So this same
    // condition ALSO feeds the tab badge (visible from ANYWHERE in the
    // Studio), independent of `#docAnalysis` (this is a fact about the
    // pattern's OWN configuration, not about the result of a full-book scan
    // — no need to wait for "Check").
    if (tab === 'name' && entry.pattern.kind === 'fontRoleCandidate' && entry.pattern.requireFontKeys.length === 0) return true;
    if (!this.#docAnalysis) return false;
    const zeroMatch = this.#docAnalysis.patternMatchTotals.some((p) => p.patternId === entry.id && p.matchCount === 0);
    if (zeroMatch) return true;
    const regionKind: StudioRegionKind | null =
      tab === 'grid'
        ? 'grid'
        : tab === 'derived'
          ? 'derived'
          : tab === 'attacks'
            ? 'attacks'
            : tab === 'skills'
              ? 'skills'
              : tab === 'name'
                ? this.#nameSubMode === 'typeLabel'
                  ? 'typeLabel'
                  : 'name'
                : null;
    if (!regionKind) return false;
    return this.#docAnalysis.pages.some((p) => p.overlaps.some((o) => o.regionKindA === regionKind || o.regionKindB === regionKind));
  }

  #patternIdForTab(tab: BuildTab): string | null {
    switch (tab) {
      case 'grid':
        return this.#activeGridPatternId;
      case 'derived':
        return this.#activeDerivedPatternId;
      case 'attacks':
        return this.#activeAttackPatternId;
      case 'skills':
        return this.#activeSkillsPatternId;
      // [Step 34 Z2] Notes have MANY patterns — there's no single "active"
      // one to return; `#computeTabBadge` handles this case SEPARATELY,
      // above, before calling this method.
      case 'notes':
        return null;
      case 'name':
        // [Report after step 30] One tab, two slots — the flat view
        // (badge/warning) shows whichever mode is currently selected.
        return this.#nameSubMode === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
      case 'check':
        return null;
    }
  }

  #findPattern(id: string | null): PatternEntryDraft | undefined {
    if (!id || !this.#draft) return undefined;
    return this.#draft.patterns.find((e) => e.id === id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);

    const pdfInput = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="pdf"]');
    pdfInput?.addEventListener('change', () => {
      const file = pdfInput.files?.[0] ?? null;
      if (file) void this.#onPdfFileSelected(file);
    });

    const profileInput = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="profile"]');
    profileInput?.addEventListener('change', () => {
      const file = profileInput.files?.[0] ?? null;
      if (file) void this.#onProfileFileSelected(file);
    });

    if (this.#state.screen === 'metadata') {
      this.#mountMetadataScreen();
      return;
    }
    if (this.#state.screen !== 'build') return;

    this.#mountMetadataHeader();

    if (this.#state.rawJsonMode) {
      const textarea = this.element.querySelector<HTMLTextAreaElement>('textarea[data-raw-json]');
      if (textarea) {
        textarea.value = this.#rawJsonText;
        textarea.addEventListener('input', () => (this.#rawJsonText = textarea.value));
      }
      return;
    }

    // [Problem observed live] Navigation using ONLY the ◄/► buttons was
    // cumbersome on a multi-page book — the numeric field lets you type the
    // page number directly.
    const pageNumberInput = this.element.querySelector<HTMLInputElement>('input[data-input="pageNumber"]');
    pageNumberInput?.addEventListener('change', () => {
      const parsed = Math.round(Number(pageNumberInput.value));
      const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : this.#state.currentPageNumber, 1), Math.max(this.#state.pageCount, 1));
      pageNumberInput.value = String(clamped);
      if (clamped !== this.#state.currentPageNumber) {
        this.#state.currentPageNumber = clamped;
        void this.render();
      }
    });
    pageNumberInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') pageNumberInput.blur();
    });

    if (this.#state.buildTab === 'check') {
      this.#mountDocumentPanel(context._docAnalysis as DocumentAnalysis | null);
      return;
    }

    void this.#ensurePageImage(this.#state.currentPageNumber);
    this.#mountEntityPanel(context._pageAnalysis as PageAnalysis | null);
    this.#mountSelectionProposal();
    this.#mountBuildPanel();
    // Sequentially, NOT in parallel — `#mountOverlay` clears `svg.innerHTML`
    // on EVERY (re)draw; if `#mountPickableTokens`/the section boundary
    // added their elements BEFORE this clearing, `#mountOverlay` would wipe
    // them out.
    void (async () => {
      await this.#mountOverlay(context._pageAnalysis as PageAnalysis | null);
      await this.#mountPickableTokens();
      await this.#mountSectionBoundaryOverlay();
    })();
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    if (svg) this.#wireAreaSelectDrag(svg);
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (img) this.#wireOverlayResize(img);
  }

  /** [Bug reproduced live, see the comment on `#overlayResizeObserver`] Redraws the SVG overlay every time the rendered `<img>` size actually changes — ONLY the new `img` (a full Handlebars render replaces the whole DOM subtree with a new element anyway, so the old observer would stop seeing anything regardless, but an explicit `disconnect()` avoids holding a reference to a detached element). */
  #wireOverlayResize(img: HTMLImageElement): void {
    this.#overlayResizeObserver?.disconnect();
    this.#overlayResizeObserver = new ResizeObserver(() => {
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
      void this.#mountPickableTokens();
      void this.#mountSectionBoundaryOverlay();
    });
    this.#overlayResizeObserver.observe(img);
  }

  override async close(options?: object): Promise<this> {
    this.#scanController?.abort();
    this.#overlayResizeObserver?.disconnect();
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    await this.#previewDocument?.destroy();
    return super.close(options);
  }

  // ---- [Step 28 correction] Entry screen ---------------------------------

  static #onChooseNewProfile(this: ProfileStudio): void {
    this.#state.entryMode = 'new';
    void this.render();
  }

  static #onChooseEditProfile(this: ProfileStudio): void {
    this.#state.entryMode = 'edit';
    void this.render();
  }

  /** [Correction] Going back from the build screen to the entry screen — resets EVERYTHING (PDF, profile, draft), so the author can start over with a different file without closing the window. Not explicitly required by the brief, but without it a "wrong choice at the start" had no way out other than closing the whole window. */
  static #onBackToEntry(this: ProfileStudio): void {
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    this.#pageImageCache.clear();
    this.#pageImageOrder = [];
    this.#buildTokensCache.clear();
    void this.#previewDocument?.destroy();
    this.#previewDocument = null;
    this.#pdfBuffer = null;
    this.#profile = null;
    this.#draft = null;
    this.#docAnalysis = null;
    this.#resetBuildPointers();
    this.#state = {
      ...this.#state,
      screen: 'entry',
      entryMode: 'choose',
      pdfFileName: null,
      profileFileName: null,
      profileSummary: null,
      profileIssues: null,
      analyzeError: null,
      currentPageNumber: 1,
      pageCount: 0,
      buildTab: 'grid',
    };
    void this.render();
  }

  #resetBuildPointers(): void {
    this.#activeGridPatternId = null;
    this.#activeDerivedPatternId = null;
    this.#activeAttackPatternId = null;
    this.#activeSkillsPatternId = null;
    this.#activeNamePatternId = null;
    this.#activeTypeLabelPatternId = null;
    this.#resetEphemeralBuildState();
    this.#activeRoute = 'npc';
    this.#npcRouteSlice = null;
    this.#playerCharacterRouteSlice = null;
  }

  /**
   * [Step 39 Z2, live user report: "Name and occupation is shared between
   * NPCs and Player Characters... if I set it for the NPC it shows up in
   * Player Characters"] `#switchRoute` (below) correctly swaps `#draft`'s
   * FIELDS (patterns/anchor/attach/...) for the new route's slice (confirmed
   * by a direct test isolated from Foundry — zero reference sharing between
   * `#npcRouteSlice`/`#playerCharacterRouteSlice`), but the EARLIER version
   * did NOT clear the cosmetic "last click" caches —
   * `#namePreviewText`/`#typeLabelPreviewText` (the panel preview "Picked as
   * name: ..."), `#buildPairPreviewValues` (trait value preview),
   * `#itemPatternExamples`/`#itemPatternShape` (the recognized shape of
   * Attacks/Skills entries). After switching routes, these previews kept
   * showing the RESULT from the PREVIOUS route (e.g. the NPC's name in the
   * Name panel, even though the ACTUAL `playerCharacter` pattern was already
   * — correctly — empty) — from the author's perspective this looked like
   * "the same setting" shared between both routes, even though in the DRAFT
   * they had already been separated from the start. Extracted here so the
   * SAME cleanup runs on EVERY context change (switching routes BELOW,
   * returning to the entry screen ABOVE), not just some of them.
   */
  #resetEphemeralBuildState(): void {
    this.#nameSubMode = 'name';
    this.#pendingValueChoice = null;
    this.#sectionBoundaryFocus = null;
    this.#boundaryDrag = null;
    this.#buildPairPreviewValues.clear();
    this.#selectionProposal = null;
    this.#notesPickPatternId = null;
    this.#notesPreview.clear();
    this.#literalGenericityCache.clear();
    this.#namePreviewText = null;
    this.#typeLabelPreviewText = null;
    this.#itemPatternExamples.clear();
    this.#itemPatternShape.clear();
    this.#pickTarget = null;
    this.#state.isSelectAreaMode = false;
  }

  /**
   * [Step 39 Z2] Splits a just-validated profile (`@bindery/core`
   * `ProfileV2`, but accepted as `any` — the SAME convention as
   * `profileToDraft` itself, see its comment) into `#draft` (metadata + the
   * `npc` route's patterns, ALWAYS at the profile's root) and
   * `#playerCharacterRouteSlice` (an optional second section, `null` when
   * the profile doesn't have one). The only place that should LOAD a profile
   * into editor state — the three former call sites of `profileToDraft`
   * (choosing "Edit profile", a successful "Apply and check", exiting raw
   * JSON mode) all go through this method, so NONE of them silently drops
   * the `playerCharacter` section (A3).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #loadProfileIntoDraft(profile: any): void {
    this.#draft = profileToDraft(profile);
    this.#npcRouteSlice = extractRouteSlice(this.#draft);
    this.#playerCharacterRouteSlice = profile?.playerCharacter
      ? extractRouteSlice(profileToDraft({ ...profile, patterns: profile.playerCharacter.patterns, entityAssembly: profile.playerCharacter.entityAssembly }))
      : null;
    this.#activeRoute = 'npc';
  }

  /**
   * [Step 39 Z2] Like `#loadProfileIntoDraft`, but WITHOUT resetting
   * `#activeRoute` — used to refresh `#draft`/the slices for BOTH routes
   * from the canonical form normalized by Zod AFTER a successful validation
   * (`#applyDraftAndScan`), so the pattern tabs and the saved .json stay
   * consistent with what actually drives the diagnostics — without
   * switching the author back to the `npc` route if they happened to be
   * working on `playerCharacter`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #refreshDraftFromValidatedProfile(profile: any): void {
    this.#npcRouteSlice = extractRouteSlice(profileToDraft(profile));
    this.#playerCharacterRouteSlice = profile?.playerCharacter
      ? extractRouteSlice(profileToDraft({ ...profile, patterns: profile.playerCharacter.patterns, entityAssembly: profile.playerCharacter.entityAssembly }))
      : null;
    const fullDraft = profileToDraft(profile);
    const activeSlice = (this.#activeRoute === 'npc' ? this.#npcRouteSlice : this.#playerCharacterRouteSlice) ?? emptyRouteSlice();
    applyRouteSlice(fullDraft, activeSlice);
    this.#draft = fullDraft;
  }

  /**
   * [Step 39 Z2] `#draft` ALWAYS carries the shared metadata + the
   * `#activeRoute`'s patterns — this method sets aside the current slice,
   * loads the target one (or an empty starting point, when the author
   * switches to a route they haven't touched yet in this session), and
   * rebuilds the tab slots (`#deriveActivePatternSlotsFromDraft`) for the
   * NEW route — the same tabs (Traits/Derived/Attacks/...), now built from a
   * different data set (per the brief: "Tabs... the same, built separately
   * for each route").
   */
  #switchRoute(route: PageRoute): void {
    if (!this.#draft || route === this.#activeRoute) return;
    const currentSlice = extractRouteSlice(this.#draft);
    if (this.#activeRoute === 'npc') this.#npcRouteSlice = currentSlice;
    else this.#playerCharacterRouteSlice = currentSlice;

    const targetSlice = (route === 'npc' ? this.#npcRouteSlice : this.#playerCharacterRouteSlice) ?? emptyRouteSlice();
    applyRouteSlice(this.#draft, targetSlice);
    this.#activeRoute = route;
    this.#deriveActivePatternSlotsFromDraft();
    this.#resetEphemeralBuildState();
    void this.render();
  }

  static #onSwitchRoute(this: ProfileStudio, _ev: Event, target: HTMLElement): void {
    const route = target.dataset['route'] as PageRoute | undefined;
    if (!route || !ROUTE_OPTIONS.includes(route)) return;
    this.#switchRoute(route);
  }

  #routeLabel(route: PageRoute): string {
    return game.i18n!.localize((route === 'npc' ? 'BINDERY.studio.routeNpc' : 'BINDERY.studio.routePlayerCharacter') as never);
  }

  /**
   * [Step 39 Z2] Input for `validateActorProfileFile`/saving — MERGES both
   * routes into ONE profile object, exactly in the shape of
   * `profileV2Schema` (`schema.ts`): metadata + the `npc` patterns at the
   * root (`patterns`/`entityAssembly`), the `playerCharacter` patterns (if
   * configured — a NON-EMPTY `patterns` list) in the optional
   * `playerCharacter` field. Unlike `draftToProfileInput(this.#draft)`,
   * which is used for single, NARROW actions (a click measuring a note, a
   * single pattern's preview — see `#refreshNotePreview`/`#onNoteTokenClick`,
   * which DELIBERATELY operate ONLY on the active route), this method is the
   * single source of truth for the FULL scan (`#applyDraftAndScan`) and for
   * saving to a file (`#onSaveProfileJson`) — both MUST see BOTH routes at
   * once, so `classifyPageRoute` (`@bindery/core`) can correctly route EVERY
   * page of the document, not just the one currently being edited.
   */
  #buildMergedProfileInput(): unknown {
    if (!this.#draft) return null;
    const currentSlice = extractRouteSlice(this.#draft);
    const npcSlice = this.#activeRoute === 'npc' ? currentSlice : (this.#npcRouteSlice ?? emptyRouteSlice());
    const pcSlice = this.#activeRoute === 'playerCharacter' ? currentSlice : this.#playerCharacterRouteSlice;

    const npcDraft: ProfileDraft = { ...this.#draft, ...npcSlice };
    const base = draftToProfileInput(npcDraft) as Record<string, unknown>;
    if (pcSlice && pcSlice.patterns.length > 0) {
      const pcDraft: ProfileDraft = { ...this.#draft, ...pcSlice };
      const pcInput = draftToProfileInput(pcDraft) as { patterns: unknown; entityAssembly: unknown };
      base['playerCharacter'] = { patterns: pcInput.patterns, entityAssembly: pcInput.entityAssembly };
    }
    return base;
  }

  /** [Correction] "Each pattern tab has an explicit slot" — after loading/building the draft, work out WHICH existing pattern belongs to WHICH slot, so the tabs immediately show the correct state (Edit profile) instead of appearing empty. Patterns outside these five slots (e.g. from manually edited raw JSON) do NOT get lost — they stay in `draft.patterns`, they're just not reachable from any pattern tab (still exported correctly on save). */
  #deriveActivePatternSlotsFromDraft(): void {
    if (!this.#draft) {
      this.#resetBuildPointers();
      return;
    }
    const draft = this.#draft;
    this.#activeGridPatternId = draft.anchor || null;
    this.#activeSkillsPatternId = draft.skillsPattern || null;
    this.#activeTypeLabelPatternId = draft.typeLabelPattern || null;
    this.#activeNamePatternId = draft.patterns.find((e) => e.pattern.kind === 'fontRoleCandidate' && e.id !== draft.typeLabelPattern)?.id ?? null;
    this.#activeDerivedPatternId = draft.patterns.find((e) => e.pattern.kind === 'labelledPairs' && e.id !== draft.anchor)?.id ?? null;
    this.#activeAttackPatternId = draft.patterns.find((e) => e.pattern.kind === 'sectionList' && e.id !== draft.skillsPattern)?.id ?? null;
  }

  async #onPdfFileSelected(file: File): Promise<void> {
    this.#state.pdfFileName = file.name;
    this.#state.analyzeError = null;
    this.#docAnalysis = null;
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    this.#pageImageCache.clear();
    this.#pageImageOrder = [];
    this.#buildTokensCache.clear();
    await this.#previewDocument?.destroy();
    this.#previewDocument = null;
    this.#pdfBuffer = await file.arrayBuffer();
    await this.render();

    try {
      const { openPreviewDocument } = await import('@bindery/core');
      this.#previewDocument = await openPreviewDocument(this.#pdfBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#state.pageCount = this.#previewDocument.pageCount;
      this.#state.currentPageNumber = 1;
    } catch (err) {
      console.warn('Bindery | Profile Studio: failed to open the PDF:', err);
      this.#state.analyzeError = game.i18n!.localize('BINDERY.studio.errorOpenPdf' as never);
      await this.render();
      return;
    }
    await this.#maybeEnterBuildScreen();
  }

  async #onProfileFileSelected(file: File): Promise<void> {
    this.#state.profileFileName = file.name;
    this.#state.profileSummary = null;
    this.#state.profileIssues = null;
    this.#profile = null;
    await this.render();

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.#state.profileIssues = [game.i18n!.localize('BINDERY.studio.profileErrorNotJson' as never)];
      await this.render();
      return;
    }

    const result = await validateActorProfileFile(parsed);
    if (!result.ok) {
      this.#state.profileIssues = result.issues;
      await this.render();
      return;
    }

    this.#profile = result.profile;
    this.#state.profileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length + Object.keys(result.profile.playerCharacter?.patterns ?? {}).length,
    };
    await this.#maybeEnterBuildScreen();
  }

  /**
   * [Correction] "New profile" -> choose PDF -> build screen. "Edit profile" -> choose PDF AND PROFILE FILE -> the same screen, pre-filled. The transition happens automatically once all required files for the chosen path have been loaded — the author doesn't click a separate "Next".
   * [user report] "The same screen" NOW means the metadata screen
   * (`'metadata'`) — not building right away. For Edit profile the fields
   * are already filled in (the loaded file passed `validateActorProfileFile`,
   * which enforces exactly the same 5 fields), so this step is ONLY for
   * review/correction before entering the build screen -- "Next" proceeds
   * immediately if the author hasn't changed anything.
   */
  async #maybeEnterBuildScreen(): Promise<void> {
    if (!this.#pdfBuffer) {
      await this.render();
      return;
    }
    if (this.#state.entryMode === 'edit' && !this.#profile) {
      await this.render();
      return;
    }
    if (this.#state.entryMode === 'edit' && this.#profile) {
      this.#loadProfileIntoDraft(this.#profile);
    } else {
      this.#draft = createEmptyProfileDraft();
      this.#npcRouteSlice = null;
      this.#playerCharacterRouteSlice = null;
      this.#activeRoute = 'npc';
    }
    this.#deriveActivePatternSlotsFromDraft();
    this.#state.screen = 'metadata';
    this.#state.buildTab = 'grid';
    await this.render();
  }

  /**
   * [user report] The five fields required by `profileV2Schema`
   * (`id`/`gameLine`/`language`/`title`/`publication`, see `schema.ts` —
   * the SAME five as `#friendlyMetadataValidationMessage` above) — they
   * don't matter for matching, but without them the save/full validation
   * will reject the whole file anyway. Returns the LABELS shown in the form
   * (not the raw keys) for the human-readable "please fill in: ..." message.
   */
  #missingMetadataFieldLabels(): string[] {
    const draft = this.#draft;
    if (!draft) return [];
    const missing: string[] = [];
    if (draft.id.trim().length < 1) missing.push('id');
    if (draft.title.trim().length < 1) missing.push(game.i18n!.localize('BINDERY.studio.fieldTitle' as never));
    if (draft.gameLine.trim().length < 1) missing.push('gameLine');
    if (draft.language.trim().length < 2) missing.push('language');
    if (draft.publication.trim().length < 1) missing.push('publication');
    return missing;
  }

  /** [user report] "Next" on the metadata screen — only lets you through to building once all 5 fields are filled in; otherwise it shows which ones are missing, instead of a silent "nothing happens". */
  static #onContinueFromMetadataStep(this: ProfileStudio): void {
    if (!this.#draft) return;
    const missing = this.#missingMetadataFieldLabels();
    if (missing.length > 0) {
      ui.notifications?.warn(`${game.i18n!.localize('BINDERY.studio.metadataStepMissingFields' as never)} ${missing.join(', ')}`);
      return;
    }
    this.#state.screen = 'build';
    void this.render();
  }

  static #onSwitchBuildTab(this: ProfileStudio, _ev: Event, target: HTMLElement): void {
    const tab = target.dataset['tab'] as BuildTab | undefined;
    if (!tab || !BUILD_TABS.includes(tab)) return;
    this.#state.buildTab = tab;
    // Leaving the tab cancels both pointing modes (S4-like: never leave implicit state lingering in the background).
    this.#pickTarget = null;
    this.#state.isSelectAreaMode = false;
    this.#selectionProposal = null;
    this.#pendingValueChoice = null;
    void this.render();
  }

  /** [Step 24 Z1] Toggles "draw an area with the mouse" mode. */
  static #onToggleSelectArea(this: ProfileStudio): void {
    this.#state.isSelectAreaMode = !this.#state.isSelectAreaMode;
    this.#selectionProposal = null;
    this.#pickTarget = null;
    void this.render();
  }

  // ---- [Step 28 correction] Build screen's persistent toolbar -------------------

  static async #onRunFullScan(this: ProfileStudio): Promise<void> {
    await this.#applyDraftAndScan();
  }

  /**
   * [Correction] The "Check" tab has ONE button — replacing the former
   * two-step "Apply and check" (Editor) + "Check all pages" (a separate
   * tab). It validates the CURRENT draft (Zod, never trusted without
   * checking — the same requirement as when loading a file), and on success
   * immediately runs a full scan with the NEWLY validated profile.
   */
  async #applyDraftAndScan(): Promise<void> {
    if (!this.#draft || !this.#pdfBuffer) return;

    let input: unknown;
    if (this.#state.rawJsonMode) {
      try {
        input = JSON.parse(this.#rawJsonText);
      } catch {
        this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
        await this.render();
        return;
      }
      this.#state.rawJsonError = null;
    } else {
      // [Step 39 Z2] MERGE both routes (not just `#draft`, the active one)
      // — "Check" has to route EVERY page of the document, so the input
      // profile must carry BOTH pattern sections at once, see
      // `#buildMergedProfileInput`.
      input = this.#buildMergedProfileInput();
    }

    const result = await validateActorProfileFile(input);
    if (!result.ok) {
      this.#state.editorIssues = result.issues;
      await this.render();
      return;
    }

    this.#profile = result.profile;
    // Refresh the draft from the CANONICAL form normalized by Zod — so the
    // pattern tabs and the saved .json stay CONSISTENT with what actually
    // drives the diagnostics. Pattern identifiers are preserved by
    // `profileToDraft`/`draftToProfileInput`, so the slots do NOT get lost.
    // [Step 39 Z2] `#refreshDraftFromValidatedProfile`, NOT `#loadProfileIntoDraft`
    // — the latter resets `#activeRoute` back to `'npc'`, which would switch
    // the author back to the NPC tabs on EVERY "Check" run while the Player
    // Characters route was active (flagged as an obvious UX regression during
    // review).
    this.#refreshDraftFromValidatedProfile(result.profile);
    this.#deriveActivePatternSlotsFromDraft();
    this.#state.editorIssues = null;
    this.#state.rawJsonMode = false;
    this.#state.profileFileName = this.#state.profileFileName ?? `${result.profile.id || 'profil'}.json`;
    this.#state.profileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length + Object.keys(result.profile.playerCharacter?.patterns ?? {}).length,
    };

    await this.#runFullScan();
  }

  async #runFullScan(): Promise<void> {
    if (!this.#pdfBuffer || !this.#profile) return;
    this.#state.isAnalyzing = true;
    this.#state.analyzeError = null;
    this.#state.analyzeProgress = null;
    await this.render();

    this.#scanController = new AbortController();
    try {
      const { analyzeProfileDocument } = await import('@bindery/core');
      this.#docAnalysis = await analyzeProfileDocument(this.#pdfBuffer, this.#profile, {
        assetBaseUrl: ASSET_BASE_URL,
        signal: this.#scanController.signal,
        onProgress: (done, total) => {
          this.#state.analyzeProgress = { done, total };
          void this.render();
        },
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.warn('Bindery | Profile Studio: analysis failed:', err);
        this.#state.analyzeError = game.i18n!.localize('BINDERY.studio.errorAnalyze' as never);
      }
    } finally {
      this.#state.isAnalyzing = false;
      this.#scanController = null;
      await this.render();
    }
  }

  static #onExportDiagnostics(this: ProfileStudio): void {
    if (!this.#docAnalysis) return;
    void (async () => {
      const { buildDiagnosticsExport } = await import('@bindery/core');
      const report = buildDiagnosticsExport(this.#docAnalysis!);
      const withMeta = { generatedAt: new Date().toISOString(), profileFile: this.#state.profileFileName, pdfFile: this.#state.pdfFileName, ...report };
      const blob = new Blob([JSON.stringify(withMeta, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bindery-profile-studio-${(this.#state.profileFileName ?? 'diagnostics').replace(/\.json$/i, '')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  }

  static #onSaveProfileJson(this: ProfileStudio): void {
    if (!this.#draft) return;
    let input: unknown;
    if (this.#state.rawJsonMode) {
      try {
        input = JSON.parse(this.#rawJsonText);
      } catch {
        this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
        void this.render();
        return;
      }
    } else {
      // [Step 39 Z2] MERGE both routes — saving to a file must carry the
      // WHOLE profile, not just the route currently open on screen, see
      // `#buildMergedProfileInput`.
      input = this.#buildMergedProfileInput();
    }
    const idPart = (this.#draft.id || 'profile').trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'profile';
    const blob = new Blob([JSON.stringify(input, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${idPart}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  static #onToggleRawJsonMode(this: ProfileStudio): void {
    if (!this.#draft) return;
    if (!this.#state.rawJsonMode) {
      // [Step 39 Z2] MERGE both routes — raw JSON mode shows/edits the
      // WHOLE profile at once (both pattern sections), not just the route
      // currently open.
      this.#rawJsonText = JSON.stringify(this.#buildMergedProfileInput(), null, 2);
      this.#state.rawJsonMode = true;
      this.#state.rawJsonError = null;
      void this.render();
      return;
    }
    try {
      const parsed = JSON.parse(this.#rawJsonText);
      // [Step 39 Z2] `#loadProfileIntoDraft`, not bare `profileToDraft` —
      // the raw JSON could have changed BOTH pattern sections (or added/
      // removed `playerCharacter` entirely), so both route slices need to be
      // re-split, not just `#draft` alone. Resets `#activeRoute` to `'npc'`
      // — after leaving raw JSON mode there's no longer a reliable signal of
      // which route was "active" in the arbitrarily edited text.
      this.#loadProfileIntoDraft(parsed);
      this.#deriveActivePatternSlotsFromDraft();
      this.#state.rawJsonMode = false;
      this.#state.rawJsonError = null;
    } catch {
      this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
    }
    void this.render();
  }

  static async #onPrevPage(this: ProfileStudio): Promise<void> {
    if (this.#state.currentPageNumber > 1) {
      this.#state.currentPageNumber -= 1;
      await this.render();
    }
  }

  static async #onNextPage(this: ProfileStudio): Promise<void> {
    if (this.#state.currentPageNumber < this.#state.pageCount) {
      this.#state.currentPageNumber += 1;
      await this.render();
    }
  }

  async #ensurePageImage(pageNumber: number): Promise<void> {
    if (!this.#previewDocument || this.#pageImageCache.has(pageNumber)) return;
    const token = ++this.#pageRenderToken;
    try {
      const encoded = await this.#previewDocument.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' });
      if (token !== this.#pageRenderToken) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded.bytes)], { type: 'image/webp' }));
      this.#pageImageCache.set(pageNumber, url);
      this.#pageImageOrder.push(pageNumber);
      while (this.#pageImageOrder.length > ProfileStudio.#PAGE_CACHE_SIZE) {
        const evict = this.#pageImageOrder.shift()!;
        const evictUrl = this.#pageImageCache.get(evict);
        if (evictUrl) URL.revokeObjectURL(evictUrl);
        this.#pageImageCache.delete(evict);
      }
      if (this.#state.screen === 'build' && this.#state.buildTab !== 'check') await this.render();
    } catch (err) {
      console.warn('Bindery | Profile Studio: renderPage failed:', err);
    }
  }

  // ---- Page panel (region overlay, entities, overlaps) --------------

  static readonly #REGION_LABEL_KEYS: Readonly<Record<StudioRegionKind, string>> = {
    grid: 'BINDERY.studio.regionGrid',
    derived: 'BINDERY.studio.regionDerived',
    attacks: 'BINDERY.studio.regionAttacks',
    skills: 'BINDERY.studio.regionSkills',
    name: 'BINDERY.studio.regionName',
    typeLabel: 'BINDERY.studio.regionTypeLabel',
    notes: 'BINDERY.studio.regionNotes',
  };

  static #regionLabel(kind: StudioRegionKind): string {
    return game.i18n!.localize(ProfileStudio.#REGION_LABEL_KEYS[kind] as never);
  }

  /** [user report, "warning 'id: String must ...'"] Profile-as-file fields that don't affect matching itself, only the profile's identity (see `.min(...)` in `profileV2Schema`, `schema.ts`) — filled in via the collapsible "Metadata and page range" header. */
  static readonly #METADATA_ISSUE_FIELDS: ReadonlySet<string> = new Set(['id', 'gameLine', 'language', 'title', 'publication']);

  /**
   * [user report, "I get warnings 'id: String must contain at least 1
   * character(s)'"] `result.issues` are strings in the format
   * `"<path>: <Zod message>"` (see `schema.ts`, `parseProfileV2`) — when
   * EVERY current error concerns one of the five file-metadata fields (which
   * don't matter for the note/anchor matching), the author DOESN'T NEED to
   * see the raw Zod syntax — they need to know where to click. When even one
   * error concerns something else (e.g. an actually broken pattern), it
   * returns `null` — the caller falls back to the raw first error, so as NOT
   * to hide the real cause behind a misleadingly reassuring metadata message.
   */
  static #friendlyMetadataValidationMessage(issues: readonly string[]): string | null {
    if (issues.length === 0) return null;
    const allMetadata = issues.every((issue) => ProfileStudio.#METADATA_ISSUE_FIELDS.has(issue.split(':')[0]?.trim() ?? ''));
    if (!allMetadata) return null;
    return game.i18n!.localize('BINDERY.studio.notesPickFailedMissingMetadata' as never);
  }

  /** A simple intersection test for two PDF rectangles — ONLY for warning about overlap WHILE dragging a section boundary; not exported from `@bindery/core` (UI geometry, not the matching engine). */
  static #rectsOverlap(a: Rect, b: Rect): boolean {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  }

  /**
   * [Step 29 Z5] Reverses `escapeSectionBoundaryLiteral` (`^Jørgen$` ->
   * `Jørgen`) to display the ACTUAL boundary text and to check whether it's
   * a whole token rather than a single character. ALSO strips the optional
   * trailing colon (`:?$`, appended by `escapeSectionBoundaryLiteral` — see
   * its comment) BEFORE attempting to strip the plain `$`, so the displayed
   * text doesn't show raw regex syntax ("Skills:?" instead of "Skills").
   */
  static #unescapeBoundaryText(pattern: string): string {
    return pattern
      .replace(/^\^/, '')
      .replace(/:\?\$$/, '')
      .replace(/\$$/, '')
      .replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
  }

  #mountEntityPanel(analysis: PageAnalysis | null): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="studio-page"]');
    if (!container) return;
    container.innerHTML = '';

    if (!this.#docAnalysis) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noAnalysisYet' as never);
      container.appendChild(p);
      return;
    }
    if (!analysis) return;

    // [Step 39 Z2] The page panel is anchored to the ACTIVE route (the
    // author is currently building/calibrating it) — but `analysis` comes
    // from the last full scan (`#docAnalysis`), which routes EVERY page
    // AUTOMATICALLY (`classifyPageRoute`, `@bindery/core`). When these two
    // routes differ, showing results from `analysis.route` (a DIFFERENT
    // route than the one the author is currently editing) would look like a
    // working match for the one they're editing — exactly the warning from
    // the Step 39 Z2 brief ("an author calibrating player characters must
    // not be able to see NPC results and conclude that something works").
    // An explicit message instead of a silent, misleading display.
    if (analysis.route !== this.#activeRoute) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.format('BINDERY.studio.routeMismatch' as never, { pageRoute: this.#routeLabel(analysis.route), activeRoute: this.#routeLabel(this.#activeRoute) });
      container.appendChild(p);
      return;
    }

    if (!analysis.routeSupported) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.routeUnsupported' as never);
      container.appendChild(p);
      return;
    }

    if (analysis.entities.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noEntitiesOnPage' as never);
      container.appendChild(p);
    }

    for (const entity of analysis.entities) container.appendChild(this.#buildEntityRow(entity));
    for (const overlap of analysis.overlaps) container.appendChild(this.#buildOverlapRow(overlap));
  }

  /**
   * [Step 29, bug reproduced live] `outOfRange` HAS TWO different reasons
   * (see `OutOfRangeCandidate` in `entityAssembly.ts`): the candidate is
   * actually farther than the limit (`'tooFar'`, the "distance > limit"
   * message makes sense here), OR the candidate was within range but
   * claimed by another anchor (`'claimedByOther'`) — for THIS case "87pt >
   * 400pt" is nonsensical (87 < 400), so it gets its OWN, honest message
   * instead of the same arithmetic formula.
   */
  #buildAttachStatus<TMatch>(label: string, result: { match: TMatch | null; outOfRange: { distance: number; maxDistancePt: number; reason: 'tooFar' | 'claimedByOther' } | null }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-studio-attach-status';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'bindery-studio-attach-label';
    labelSpan.textContent = label;
    row.appendChild(labelSpan);
    const valueSpan = document.createElement('span');
    if (result.match) {
      valueSpan.className = 'bindery-studio-attach-ok';
      valueSpan.textContent = '✔';
    } else if (result.outOfRange?.reason === 'tooFar') {
      valueSpan.className = 'bindery-studio-attach-outofrange';
      valueSpan.textContent = `⚠ ${Math.round(result.outOfRange.distance)}pt > ${result.outOfRange.maxDistancePt}pt`;
    } else if (result.outOfRange) {
      valueSpan.className = 'bindery-studio-attach-outofrange';
      valueSpan.textContent = `⚠ ${Math.round(result.outOfRange.distance)}pt — ${game.i18n!.localize('BINDERY.studio.attachClaimedByOther' as never)}`;
    } else {
      valueSpan.className = 'bindery-studio-attach-missing';
      valueSpan.textContent = '—';
    }
    row.appendChild(valueSpan);
    return row;
  }

  #buildEntityRow(entity: EntityAnalysis): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-studio-entity-row';

    const line1 = document.createElement('div');
    line1.className = 'bindery-studio-entity-line1';
    const nameSpan = document.createElement('span');
    nameSpan.className = entity.name.kind === 'confident' ? 'bindery-studio-name-confident' : 'bindery-studio-name-placeholder';
    nameSpan.textContent = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
    line1.appendChild(nameSpan);
    row.appendChild(line1);

    if (entity.name.kind === 'placeholder' && entity.name.candidates.length > 0) {
      const cand = document.createElement('p');
      cand.className = 'hint bindery-studio-candidates';
      cand.textContent = `${game.i18n!.localize('BINDERY.studio.nameCandidatesLabel' as never)}: ${entity.name.candidates.join(' | ')}`;
      row.appendChild(cand);
    }

    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('derived'), entity.derived));
    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('attacks'), entity.attacks));
    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('skills'), entity.skills));

    row.addEventListener('click', () => {
      this.#highlighted = { entityOrdinal: entity.ordinal, kind: 'grid' };
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
    });

    return row;
  }

  #buildOverlapRow(overlap: OverlapWarning): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-diagnostic-row bindery-diagnostic-error bindery-studio-overlap-row';
    row.textContent = `${game.i18n!.localize('BINDERY.studio.overlapLabel' as never)}: #${overlap.entityOrdinalA + 1} (${ProfileStudio.#regionLabel(overlap.regionKindA)}) × #${overlap.entityOrdinalB + 1} (${ProfileStudio.#regionLabel(overlap.regionKindB)})`;
    row.addEventListener('click', () => {
      this.#highlighted = { entityOrdinal: overlap.entityOrdinalA, kind: overlap.regionKindA };
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
    });
    return row;
  }

  async #mountOverlay(analysis: PageAnalysis | null): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img || !this.#previewDocument || !analysis) {
      if (svg) svg.innerHTML = '';
      return;
    }

    const { pdfRectToScreen } = await import('@bindery/core');
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';

      for (const entity of analysis.entities) {
        for (const region of entity.regions) {
          const screen = pdfRectToScreen(region.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(screen.minX));
          rect.setAttribute('y', String(screen.minY));
          rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
          rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
          const classes = [`bindery-studio-region`, `bindery-studio-region-${region.kind}`];
          if (this.#highlighted && this.#highlighted.entityOrdinal === entity.ordinal) classes.push('bindery-studio-region-highlighted');
          rect.setAttribute('class', classes.join(' '));
          svg.appendChild(rect);
        }
      }
      for (const overlap of analysis.overlaps) {
        const screen = pdfRectToScreen(overlap.intersection, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        rect.setAttribute('class', 'bindery-studio-overlap');
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  // ---- [Step 28, correction] Panel for building the profile by pointing -----------

  /**
   * [Bug reproduced live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] pdf.js
   * sometimes splits ONE printed word into several `TextItem`s at a
   * font/glyph-encoding change (typically a diacritical character: "Jørgen"
   * -> "J"+"ørgen" as TWO touching tokens) — without `mergeTouchingTokens`,
   * clicking on what is visually one word could yield only a fragment of it
   * ("J"), and that fragment, used as `terminateSectionBefore`/a label/a
   * header, would then match RANDOMLY somewhere else in the book. Merging
   * happens HERE, ONCE, over the page's full token list — every consumer
   * (clicking a label/header/boundary, 📍 mode) already gets merged,
   * "whole word" tokens for free.
   */
  async #getBuildTokens(pageNumber: number): Promise<IndexedSelectionToken[]> {
    const cached = this.#buildTokensCache.get(pageNumber);
    if (cached) return cached;
    if (!this.#pdfBuffer) return [];
    const { getPageTextTokens, mergeTouchingTokens, splitMergedLabelValueTokens, stripStrayLeadingColonTokens } = await import('@bindery/core');
    const raw = await getPageTextTokens(this.#pdfBuffer, pageNumber, { assetBaseUrl: ASSET_BASE_URL });
    const merged = mergeTouchingTokens(raw);
    // [Step 42/43] The same fix as the production `tokenizePage.ts` — some
    // PDFs merge a trait-grid label and its value into ONE pdf.js token
    // ("S 40"), while others leave the colon at the START of the value
    // instead of at the end of the label (": None.") — see the comments on
    // `splitMergedLabelValueTokens`/`stripStrayLeadingColonTokens`.
    const split = splitMergedLabelValueTokens(stripStrayLeadingColonTokens(merged));
    const indexed: IndexedSelectionToken[] = split.map((t, i) => ({ ...t, tokenIndex: i }));
    this.#buildTokensCache.set(pageNumber, indexed);
    return indexed;
  }

  /** [U3] "The interface doesn't explain anything" — one line saying exactly what to do NEXT, per active pattern tab. */
  #computeBuildGuidance(): string {
    const loc = (key: string) => game.i18n!.localize(`BINDERY.studio.${key}` as never);
    if (!this.#draft) return loc('guidanceNoDraft');
    if (this.#pendingValueChoice) return loc('guidanceAmbiguousValue');
    if (this.#boundaryDrag) return loc('guidanceDraggingBoundary');

    switch (this.#state.buildTab) {
      case 'grid': {
        const n = this.#labelCount(this.#activeGridPatternId);
        return n === 0 ? loc('guidanceGridEmpty') : loc('guidanceHasRows');
      }
      case 'derived': {
        const n = this.#labelCount(this.#activeDerivedPatternId);
        return n === 0 ? loc('guidanceDerivedEmpty') : loc('guidanceHasRows');
      }
      case 'attacks':
        return this.#sectionGuidance(this.#activeAttackPatternId, 'guidanceAttacksEmpty');
      case 'skills':
        return this.#sectionGuidance(this.#activeSkillsPatternId, 'guidanceSkillsEmpty');
      case 'notes':
        if (this.#notesPickPatternId) return loc('guidanceNotesPicking');
        return (this.#draft?.notesPatterns.length ?? 0) === 0 ? loc('guidanceNotesEmpty') : loc('guidanceNotesHasBlocks');
      case 'name': {
        const currentId = this.#nameSubMode === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
        const entry = this.#findPattern(currentId);
        // [Live report after Step 39, "Age: still ends up matched into
        // name"] The same bug as "Occupation: -> Occupation:" (draft-12
        // without requireFontKeys loses to a closer label, see
        // spike/bohaterowie/15-repro-wrak-name.ts), BUT this time NOT fixed
        // point-wise on the profile file — because point fixes like that
        // don't survive the next save from the Studio itself (exactly the
        // author's complaint: "if you only fixed it in the file, the problem
        // will come back the next time I create a [profile]"). Instead: a
        // structural warning, VISIBLE IMMEDIATELY on opening the tab (not
        // only after "Check"/import), for EVERY profile that has a
        // Name/Occupation pattern without any required font — because the
        // font role alone has "terrible precision" (see the comment on
        // #onNameCandidateClick).
        if (entry?.pattern.kind === 'fontRoleCandidate' && entry.pattern.requireFontKeys.length === 0) {
          return loc(this.#nameSubMode === 'typeLabel' ? 'guidanceTypeLabelNoFontKey' : 'guidanceNameNoFontKey');
        }
        return loc(this.#nameSubMode === 'typeLabel' ? 'guidanceTypeLabel' : 'guidanceName');
      }
      case 'check':
        return loc('guidanceComplete');
    }
  }

  #labelCount(patternId: string | null): number {
    const entry = this.#findPattern(patternId);
    return entry?.pattern.kind === 'labelledPairs' ? entry.pattern.labels.length : 0;
  }

  #sectionGuidance(patternId: string | null, emptyKey: string): string {
    const loc = (key: string) => game.i18n!.localize(`BINDERY.studio.${key}` as never);
    const entry = this.#findPattern(patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return loc(emptyKey);
    if (!entry.pattern.terminateSectionBefore) return loc('guidanceSectionPicked');
    // [Step 29 Z1] Third phase — the boundary is already set, but the
    // author hasn't clicked any example item yet (`itemPattern` still empty).
    if (!entry.pattern.itemPattern) return loc('guidanceItemPatternExamples');
    return loc('guidanceComplete');
  }

  /**
   * Matches a clicked label's name against the canonical-key dictionary
   * (`CANONICAL_STATS`) — a suggestion ONLY, a single click can change it.
   *
   * [user report: "Pancerz" (Armor) wasn't getting the "armour" suggestion]
   * Labels in this and other CoC7 books often end with a colon
   * ("Pancerz:", "Krzepa:", "Ruch:" — "Armor:", "Build:", "Move:") — the
   * token clicked on the page CARRIES that colon, but `CANONICAL_STATS`'s
   * hints (`statKeys.ts`) do NOT have it (they're language
   * variants/abbreviations, not literal tokens straight from the PDF), so an
   * exact comparison never matched for any label with a trailing colon —
   * the author always had to type the key in by hand, even for well-known
   * fields.
   */
  async #suggestCanonicalKey(labelText: string): Promise<string> {
    const { CANONICAL_STATS } = await import('@bindery/core');
    const needle = labelText.trim().replace(/:$/, '').toLowerCase();
    if (!needle) return '';
    for (const [key, def] of Object.entries(CANONICAL_STATS)) {
      if (def.hints.some((hint: string) => hint.toLowerCase() === needle)) return key;
    }
    return '';
  }

  static readonly #DEFAULT_ATTACH_MAX_DISTANCE_PT = 400;

  /**
   * [Correction] Adds (or refreshes) one label-value pair in the `'grid'`
   * slot (Traits, anchor) or the `'derived'` slot (Derived, the second
   * labelledPairs) — the SAME logic as before, but parameterized by slot
   * instead of one shared "active pattern", so clicking on each of these two
   * tabs lands in the RIGHT pattern (exactly the reported problem: "from the
   * page view you can only add traits").
   */
  async #addOrUpdateGridPair(slot: 'grid' | 'derived', labelText: string, value: string): Promise<void> {
    if (!this.#draft) return;
    const currentId = slot === 'grid' ? this.#activeGridPatternId : this.#activeDerivedPatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId);
    if (!entry || entry.pattern.kind !== 'labelledPairs') {
      entry = createPatternDraft(
        'labelledPairs',
        this.#draft.patterns.map((e) => e.id),
      );
      this.#draft.patterns.push(entry);
      if (slot === 'grid') {
        this.#activeGridPatternId = entry.id;
        if (!this.#draft.anchor) this.#draft.anchor = entry.id;
        // [Step 28, discovery] `createEmptyProfileDraft` doesn't create ANY
        // `fontRoleCandidate` pattern (the entity's name) — without it the
        // author would have to go back to raw JSON to get one, breaking
        // "zero tab-switching". Sensible default values (the same ones both
        // existing CoC7 profiles use) are created together with the FIRST
        // grid.
        if (!this.#draft.patterns.some((e) => e.pattern.kind === 'fontRoleCandidate' && e.id !== this.#draft!.typeLabelPattern)) {
          const nameEntry = createPatternDraft(
            'fontRoleCandidate',
            this.#draft.patterns.map((e) => e.id),
          );
          this.#draft.patterns.push(nameEntry);
          this.#activeNamePatternId = nameEntry.id;
          this.#draft.attach.push({ pattern: nameEntry.id, strategy: 'nearestAbove', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
        }
      } else {
        this.#activeDerivedPatternId = entry.id;
        if (this.#draft.anchor && !this.#draft.attach.some((a) => a.pattern === entry!.id)) {
          this.#draft.attach.push({ pattern: entry.id, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
        }
      }
    }
    if (entry.pattern.kind !== 'labelledPairs') return;
    const canonicalKey = await this.#suggestCanonicalKey(labelText);
    const existing = entry.pattern.labels.find((l) => l.label === labelText);
    if (existing) {
      if (!existing.canonicalKey && canonicalKey) existing.canonicalKey = canonicalKey;
    } else {
      entry.pattern.labels.push({ label: labelText, canonicalKey });
    }
    this.#buildPairPreviewValues.set(`${entry.id}:${labelText}`, value);
    this.#refreshBuildPanel();
  }

  /**
   * [Correction] Clicking a section header in the `'attacks'` slot (Attacks)
   * or `'skills'` slot (Skills) — the tab already says WHICH section this
   * is, so (unlike the previous version) there's no need to guess it from
   * "no value candidate nearby". Creates (or reuses, if this slot already
   * has a pattern) a `sectionList`, adds an attach rule to the anchor, and
   * enters boundary-dragging "focus".
   */
  #startSectionFromHeader(slot: 'attacks' | 'skills', tok: IndexedSelectionToken): void {
    if (!this.#draft) return;
    const escaped = escapeSectionBoundaryLiteral(tok.text);
    const currentId = slot === 'attacks' ? this.#activeAttackPatternId : this.#activeSkillsPatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId && e.pattern.kind === 'sectionList');
    if (!entry) {
      entry = createPatternDraft(
        'sectionList',
        this.#draft.patterns.map((e) => e.id),
      );
      if (entry.pattern.kind === 'sectionList') entry.pattern.sectionHeader = escaped;
      this.#draft.patterns.push(entry);
      if (this.#draft.anchor) this.#draft.attach.push({ pattern: entry.id, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
      if (slot === 'attacks') this.#activeAttackPatternId = entry.id;
      else {
        this.#activeSkillsPatternId = entry.id;
        this.#draft.skillsPattern = entry.id;
      }
    } else if (entry.pattern.kind === 'sectionList') {
      entry.pattern.sectionHeader = escaped;
    }
    this.#sectionBoundaryFocus = { patternId: entry.id, page: this.#state.currentPageNumber, headerTokenIndex: tok.tokenIndex };
    this.#refreshBuildPanel();
  }

  /**
   * [Step 29 Z1, the crux of this step] A click in phase 3 (header +
   * boundary already set) — YOU POINT, the tool INFERS. `collectRowText`
   * gathers the text of the whole visual row around the click (usually
   * that's the full text of one token anyway — pdf.js more often than not
   * fuses a whole line into one `TextItem`, measured directly on p. 23 "Zew
   * Cthulhu 7ed. Wrak.pdf"), and `inferItemPatternFromExamples` picks and
   * tunes one of a LIMITED family of shapes (per the brief: never an
   * arbitrary regex from scratch) based on ALL the examples gathered so far
   * for THIS pattern — so a subsequent click can EXTEND the recognized shape
   * (measured: a percentage-based melee entry alone gives the
   * percentage shape, only a SECOND example — a weapon-plus-dice entry
   * without a percentage — adds a second alternative branch, and the
   * weapon starts being recognized as a separate item).
   */
  async #addItemPatternExample(slot: 'attacks' | 'skills', entry: PatternEntryDraft, tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    if (entry.pattern.kind !== 'sectionList') return;
    const { collectRowText, inferItemPatternFromExamples } = await import('@bindery/core');
    const rowIndex = allTokens.findIndex((t) => t.tokenIndex === tok.tokenIndex);
    // [user report, "boundary is set, but clicking an example (e.g. Melee)
    // does nothing"] The two earlier `return`s below were COMPLETELY
    // silent — the same shape of bug already fixed once for
    // `#onNoteTokenClick` (see `notesPickFailedNoToken` and its sibling
    // keys) — a click that, for whatever reason, doesn't add an example
    // MUST say why, instead of looking like a dead button. The exact cause
    // of this report hasn't been reproduced directly yet (no access to a
    // live Foundry instance in this session) — so these warnings are both a
    // UX fix (A3: nothing disappears silently) and diagnostics in case it
    // recurs (`rowText` empty = `collectRowText` found no text around the
    // click; no `inferred` = the example WAS accepted, but none of the known
    // itemPattern shapes matches it yet — unlike total silence, both states
    // are now visible).
    if (rowIndex === -1) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.itemExampleTokenNotFound' as never));
      return;
    }
    const rowText = collectRowText(allTokens, rowIndex).trim();
    if (!rowText) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.itemExampleEmptyRowText' as never));
      return;
    }
    const examples = this.#itemPatternExamples.get(entry.id) ?? [];
    if (!examples.includes(rowText)) examples.push(rowText);
    this.#itemPatternExamples.set(entry.id, examples);
    const inferred = inferItemPatternFromExamples(slot, examples);
    if (inferred) {
      entry.pattern.itemPattern = inferred.itemPattern;
      this.#itemPatternShape.set(entry.id, inferred.shape);
    } else {
      ui.notifications?.info(game.i18n!.format('BINDERY.studio.itemExampleAcceptedNoShapeYet' as never, { count: String(examples.length) }));
    }
    this.#refreshBuildPanel();
  }

  /** [Step 29 Z1] "Start over" for itemPattern examples — does NOT remove the boundary/header, ONLY the accumulated examples and the pattern generated from them (a pattern manually typed under "Advanced" is left untouched, if the author typed it in there themselves). */
  #clearItemPatternExamples(entry: PatternEntryDraft): void {
    this.#itemPatternExamples.delete(entry.id);
    this.#itemPatternShape.delete(entry.id);
    this.#refreshBuildPanel();
  }

  /**
   * [Step 28 Z1, critical requirement, unchanged from the previous version]
   * Refreshes ONLY the build panel's contents (and the SVG overlay) — NEVER
   * `this.render()`. A full ApplicationV2 render rebuilds the ENTIRE `.hbs`
   * template from scratch, which loses both columns' scroll position —
   * exactly the reported problem (U1).
   */
  #refreshBuildPanel(): void {
    this.#mountBuildPanel();
    void this.#mountPickableTokens();
    void this.#mountSectionBoundaryOverlay();
  }

  /** [Correction] Clicking a token on the PDF in the default build mode — the only way to build, NOW unambiguously routed by the active tab instead of guessed from geometry. */
  async #onBuildTokenClick(tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    if (!this.#draft) return;

    if (this.#pendingValueChoice) {
      const chosen = this.#pendingValueChoice.candidates.find((c) => c.tokenIndex === tok.tokenIndex);
      const { slot, labelText } = this.#pendingValueChoice;
      this.#pendingValueChoice = null;
      if (chosen) {
        await this.#addOrUpdateGridPair(slot, labelText, chosen.text);
        return;
      }
      // A click OUTSIDE the highlighted candidates = cancel — this click counts as a NEW click, below.
    }

    const tab = this.#state.buildTab;
    if (tab === 'grid' || tab === 'derived') {
      const { estimateTypicalRowGapPt, findValueCandidatesNearLabel } = await import('@bindery/core');
      const gap = estimateTypicalRowGapPt(allTokens);
      const candidates = findValueCandidatesNearLabel(allTokens, tok.bbox, gap);
      if (candidates.length === 1) {
        await this.#addOrUpdateGridPair(tab, tok.text, candidates[0]!.text);
        return;
      }
      if (candidates.length > 1) {
        this.#pendingValueChoice = { slot: tab, labelText: tok.text, labelBbox: tok.bbox, candidates };
        this.#refreshBuildPanel();
        return;
      }
      // No value candidate -- on this tab that no longer automatically means "so it must be a section header" (that was the source of ambiguity in the previous version) -- there's simply nothing here to pair.
      return;
    }
    if (tab === 'attacks' || tab === 'skills') {
      const currentId = tab === 'attacks' ? this.#activeAttackPatternId : this.#activeSkillsPatternId;
      const focus = this.#sectionBoundaryFocus;
      const entry = this.#draft.patterns.find((e) => e.id === currentId && e.pattern.kind === 'sectionList');
      // [User correction] Once this section's header is already "in focus"
      // on THIS page, a SUBSEQUENT click (on anything other than the header
      // token itself) is no longer a new header. Three phases, in this
      // order: (1) no header -> this click BECOMES it; (2) header exists but
      // `terminateSectionBefore` doesn't yet -> this click sets the boundary
      // (the first item OUTSIDE the section, simpler than dragging — which
      // remains available ALONGSIDE it, `#sectionBoundaryFocus` isn't
      // cleared, so the handle keeps drawing on the PDF); (3) boundary
      // ALREADY set -> [Step 29 Z1] this click is an EXAMPLE item to train
      // `itemPattern` — the brief says it directly: "Once the section
      // boundary is set, the panel says: Click 2-3 example items in this
      // section".
      if (entry?.pattern.kind === 'sectionList' && focus && focus.patternId === currentId && focus.page === this.#state.currentPageNumber && tok.tokenIndex !== focus.headerTokenIndex) {
        if (!entry.pattern.terminateSectionBefore) {
          entry.pattern.terminateSectionBefore = escapeSectionBoundaryLiteral(tok.text);
          this.#refreshBuildPanel();
          return;
        }
        await this.#addItemPatternExample(tab, entry, tok, allTokens);
        return;
      }
      this.#startSectionFromHeader(tab, tok);
      return;
    }
    if (tab === 'notes') {
      await this.#onNoteTokenClick(tok, allTokens);
      return;
    }
    if (tab === 'name') {
      await this.#onNameCandidateClick(this.#nameSubMode, tok);
    }
  }

  /**
   * [Correction, "Name: points to a creature-name candidate"] `fontRoleCandidate`
   * matches by FONT ROLE, not by literal text (unlike `labelledPairs`/
   * `sectionList`) — so a click CANNOT insert this exact text as an
   * "accepted value" the way it can for labels. Instead: the click serves as
   * a TEST against REAL data (if a full scan already exists for this page,
   * show whether THIS token was recognized as a candidate) and as a hint for
   * the only parameter that can literally be derived from a click without
   * changing the engine: `maxLength` (if the clicked text is longer than the
   * current limit, it raises it).
   *
   * [Step 29 Z3] A second parameter derivable from a click: the clicked
   * token's `fontKey`, appended to `requireFontKeys` (if not already there).
   * The font role alone has terrible precision (H2 from step 12: 2401
   * candidates for 15 entities) — the font key narrows this by an order of
   * magnitude, because unlike the role (a ranking per DOCUMENT) it
   * identifies the SPECIFIC typeface used for names. Subsequent clicks ADD
   * alternatives (several typefaces used for names within the same book),
   * never replace. The rest (`excludeRoles` and others) stays under
   * "Advanced settings" — we deliberately do NOT change the matching engine
   * (per the brief, explicitly).
   *
   * [Report after step 30, "Separating the name from the type/occupation"]
   * Parameterized by `slot`, the same way as `#startSectionFromHeader` for
   * Attacks/Skills — one "Name" tab, TWO independent `fontRoleCandidate`
   * slots (name + occupation/type), each with its OWN `requireFontKeys`
   * (e.g. "John Calhoun," bold, "yacht captain" italic — two different
   * typefaces in the same book distinguish fields that used to share one
   * pattern and compete for the same field). The `typeLabel` slot
   * additionally saves `draft.typeLabelPattern`, the same way
   * `#startSectionFromHeader` saves `draft.skillsPattern` for Skills.
   */
  async #onNameCandidateClick(slot: 'name' | 'typeLabel', tok: IndexedSelectionToken): Promise<void> {
    if (!this.#draft) return;
    const currentId = slot === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId);
    if (!entry || entry.pattern.kind !== 'fontRoleCandidate') {
      entry = createPatternDraft(
        'fontRoleCandidate',
        this.#draft.patterns.map((e) => e.id),
      );
      this.#draft.patterns.push(entry);
      if (this.#draft.anchor && !this.#draft.attach.some((a) => a.pattern === entry!.id)) {
        this.#draft.attach.push({ pattern: entry.id, strategy: 'nearestAbove', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
      }
      if (slot === 'typeLabel') {
        this.#activeTypeLabelPatternId = entry.id;
        this.#draft.typeLabelPattern = entry.id;
      } else {
        this.#activeNamePatternId = entry.id;
      }
    }
    if (entry.pattern.kind !== 'fontRoleCandidate') return;
    if (tok.text.length > entry.pattern.maxLength) entry.pattern.maxLength = tok.text.length;
    if (tok.fontKey && !entry.pattern.requireFontKeys.includes(tok.fontKey)) entry.pattern.requireFontKeys.push(tok.fontKey);
    if (slot === 'typeLabel') this.#typeLabelPreviewText = tok.text;
    else this.#namePreviewText = tok.text;
    this.#refreshBuildPanel();
    this.#warnIfClickedTextLooksLikeFieldLabel(tok);
    await this.#warnIfClickedRoleIsExcluded(entry.pattern, tok);
  }

  /**
   * [Live report after the draft-12 fix, "Occupation: gets Age:"] A separate
   * bug from the same family as `#warnIfClickedRoleIsExcluded`: the author
   * clicked the field's LABEL ITSELF ("Occupation:"), not its value — the
   * label's role (`accent`) is NOT excluded, so THAT warning doesn't fire,
   * but the fontRoleCandidate pattern will still never catch the RIGHT
   * label: every field label in the same book shares the same
   * typeface/role ("Age:", "Occupation:", the trait abbreviations
   * "STR"/"CON"/...), so `nearestAbove` will always win with whichever is
   * GEOMETRICALLY closest to the anchor, not the one the author clicked.
   * `fontRoleCandidate` is designed to catch STANDALONE headers (a name, a
   * monster's title) — not colon-terminated labels, which by definition
   * belong to `labelledPairs`. The check is PURELY structural (ends with ":"
   * OR an exact match against a label already used in ANY `labelledPairs`
   * in this draft) — zero PDF cost, since we already have this in memory.
   */
  #warnIfClickedTextLooksLikeFieldLabel(tok: IndexedSelectionToken): void {
    if (!this.#draft) return;
    const text = tok.text.trim();
    const looksLikeLabel =
      /[:：]\s*$/.test(text) ||
      this.#draft.patterns.some((e) => e.pattern.kind === 'labelledPairs' && e.pattern.labels.some((l) => l.label.trim().toLowerCase() === text.toLowerCase()));
    if (looksLikeLabel) ui.notifications?.warn(game.i18n!.format('BINDERY.studio.nameClickLooksLikeLabel' as never, { text }));
  }

  /**
   * [Step 39, live report, "Occupation: ends up matching the Occupation
   * field"] `fontRoleCandidate` ALWAYS rejects roles listed in
   * `excludeRoles` (default `['body']`) — BEFORE checking
   * `requireFontKeys`. Clicking an example whose OWN font role is on that
   * list (e.g. the value of the "Occupation:" field in this book, plain
   * `body` style, not a distinguishing mark like NPCs have) creates a
   * pattern that will NEVER find ANYTHING — not just this one example,
   * EVERY token with the same role, regardless of `requireFontKeys`. This
   * same bug was only diagnosed AFTER a full import (Wrak.pdf, the
   * Investigators' "Occupation" field) — instead of waiting for
   * "Check"/import, it warns IMMEDIATELY after the click, while the author
   * still remembers exactly what they clicked.
   *
   * [Cost] `getFontRoleAwareTokensForPage` computes a FULL document
   * inventory (the same cost as `#refreshNotePreview`) — but clicking a
   * Name/Occupation example is a rare, deliberate author action (not
   * per-render/per-frame), so it's the same cost tradeoff as notes.
   */
  async #warnIfClickedRoleIsExcluded(pattern: FontRoleCandidatePatternDraft, tok: IndexedSelectionToken): Promise<void> {
    if (!this.#pdfBuffer) return;
    const { getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });
    const tcx = (tok.bbox.minX + tok.bbox.maxX) / 2;
    const tcy = (tok.bbox.minY + tok.bbox.maxY) / 2;
    let bestDist = Infinity;
    let matchedRole: string | undefined;
    for (const t of tokens) {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      const d = Math.hypot(cx - tcx, cy - tcy);
      if (d < bestDist) {
        bestDist = d;
        matchedRole = t.fontRole;
      }
    }
    if (matchedRole && pattern.excludeRoles.includes(matchedRole)) {
      ui.notifications?.warn(game.i18n!.format('BINDERY.studio.nameClickExcludedRole' as never, { role: matchedRole }));
    }
  }

  /** [Correction] The last clicked token on the Name tab (mode "Point to name") — panel preview ONLY, never saved into the draft. */
  #namePreviewText: string | null = null;
  /** [Report after step 30] As above, but for "Point to occupation / type" mode — a separate field, so switching between modes doesn't overwrite the other one's preview. */
  #typeLabelPreviewText: string | null = null;

  #mountBuildPanel(): void {
    const container = this.element.querySelector<HTMLElement>('[data-build-panel]');
    if (!container) return;
    container.innerHTML = '';
    if (!this.#draft) return;

    const guidance = document.createElement('p');
    guidance.className = 'bindery-studio-build-guidance';
    guidance.textContent = this.#computeBuildGuidance();
    container.appendChild(guidance);

    switch (this.#state.buildTab) {
      case 'grid':
        container.appendChild(this.#buildPairTabContent('grid', this.#activeGridPatternId));
        break;
      case 'derived':
        container.appendChild(this.#buildPairTabContent('derived', this.#activeDerivedPatternId));
        break;
      case 'attacks':
        container.appendChild(this.#buildSectionTabContent('attacks', this.#activeAttackPatternId));
        break;
      case 'skills':
        container.appendChild(this.#buildSectionTabContent('skills', this.#activeSkillsPatternId));
        break;
      case 'notes':
        container.appendChild(this.#buildNotesTabContent());
        break;
      case 'name':
        container.appendChild(this.#buildNameTabContent());
        break;
      case 'check':
        break;
    }

    if (this.#pendingValueChoice) {
      const hint = document.createElement('p');
      hint.className = 'notification bindery-studio-build-ambiguous-hint';
      hint.textContent = `${game.i18n!.localize('BINDERY.studio.guidanceAmbiguousValue' as never)} (${this.#pendingValueChoice.candidates.length})`;
      container.appendChild(hint);
    }

    void this.#populateCanonicalKeyDatalist();
  }

  #buildPairTabContent(slot: 'grid' | 'derived', patternId: string | null): HTMLElement {
    const wrap = document.createElement('div');
    const entry = this.#findPattern(patternId);
    wrap.appendChild(this.#buildGridSummary(entry, patternId));
    if (entry?.pattern.kind === 'labelledPairs') {
      const details = document.createElement('details');
      details.className = 'bindery-studio-advanced-details';
      const summary = document.createElement('summary');
      summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
      details.appendChild(summary);
      details.appendChild(this.#buildLabelledPairsForm(entry.pattern, entry.id));
      if (slot === 'derived') details.appendChild(this.#buildSingleAttachEditor(entry.id));
      wrap.appendChild(details);
    }
    return wrap;
  }

  #buildGridSummary(entry: PatternEntryDraft | undefined, patternId: string | null): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section';
    if (!entry || entry.pattern.kind !== 'labelledPairs') return section;
    const p = entry.pattern;
    for (const labelEntry of p.labels) {
      const row = document.createElement('div');
      row.className = 'bindery-studio-build-pair-row';
      const text = document.createElement('span');
      const preview = this.#buildPairPreviewValues.get(`${patternId}:${labelEntry.label}`);
      text.textContent = preview ? `${labelEntry.label} → ${preview}` : labelEntry.label;
      row.appendChild(text);
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input';
      keyInput.value = labelEntry.canonicalKey;
      keyInput.setAttribute('list', 'bindery-canonical-keys');
      keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
      keyInput.addEventListener('change', () => (labelEntry.canonicalKey = keyInput.value));
      row.appendChild(keyInput);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        p.labels = p.labels.filter((l) => l !== labelEntry);
        this.#refreshBuildPanel();
      });
      row.appendChild(delBtn);
      section.appendChild(row);
    }
    return section;
  }

  #buildSectionTabContent(slot: 'attacks' | 'skills', patternId: string | null): HTMLElement {
    const wrap = document.createElement('div');
    const entry = this.#findPattern(patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return wrap;
    const pattern = entry.pattern;

    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section bindery-studio-build-section-active';
    const h = document.createElement('h4');
    h.textContent = ProfileStudio.#unescapeBoundaryText(pattern.sectionHeader);
    section.appendChild(h);
    // [Step 37 Z2] The section header itself is ALSO a literal token taken
    // from ONE page of material — the same class of risk as
    // `terminateSectionBefore` (see `#checkBoundaryGenericity`/
    // `#checkLiteralGenericity`): if it occurs only where the author clicked
    // it, the section won't be recognized for any other character in the
    // book.
    if (pattern.sectionHeader) {
      const headerGenericityWarn = document.createElement('p');
      headerGenericityWarn.className = 'notification error';
      headerGenericityWarn.hidden = true;
      section.appendChild(headerGenericityWarn);
      void this.#checkLiteralGenericity(`sectionHeader:${entry.id}`, pattern.sectionHeader, headerGenericityWarn, 'BINDERY.studio.buildValueTooSpecific', () =>
        entry.pattern.kind === 'sectionList' ? entry.pattern.sectionHeader : undefined,
      );
    }
    const status = document.createElement('p');
    status.className = 'hint';
    const boundaryText = pattern.terminateSectionBefore ? ProfileStudio.#unescapeBoundaryText(pattern.terminateSectionBefore) : null;
    status.textContent = boundaryText ? `${game.i18n!.localize('BINDERY.studio.buildSectionEndsAt' as never)}: ${boundaryText}` : game.i18n!.localize('BINDERY.studio.buildSectionNoBoundary' as never);
    section.appendChild(status);
    // [Step 29 Z5, bug reproduced live] A boundary that ended up as a single
    // character ("^J$" instead of "^Jørgen$") will match RANDOMLY anywhere
    // in the whole book -- warn instead of silently saving it (per the
    // step's brief, explicitly).
    if (boundaryText && boundaryText.trim().length < 2) {
      const warn = document.createElement('p');
      warn.className = 'notification error';
      warn.textContent = `${game.i18n!.localize('BINDERY.studio.buildSectionBoundarySuspicious' as never)} ("${boundaryText}")`;
      section.appendChild(warn);
    }
    // [Bug reproduced live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] A boundary
    // that matches a token OUTSIDE the header's column (typically: a dozen
    // or so lines of prose from the neighboring column, sucked into the
    // section) is a signal that something is wrong, even when the boundary
    // text's length alone is fine (Z5 catches ONLY the single-character
    // case). The check needs the page's tokens (`#getBuildTokens`,
    // asynchronous) — appended to a warning row that's ALREADY rendered,
    // the same pattern as `#populateCanonicalKeyDatalist` further down in
    // this file.
    if (boundaryText) {
      const columnWarn = document.createElement('p');
      columnWarn.className = 'notification error';
      columnWarn.hidden = true;
      section.appendChild(columnWarn);
      void this.#checkBoundaryColumnMismatch(entry, columnWarn);

      // [user report, "boundary set on the Sciapod broke Calhoun's/Hansen's
      // Attacks"] The same rendering pattern as the column warning above —
      // a hidden <p>, filled in asynchronously.
      const genericityWarn = document.createElement('p');
      genericityWarn.className = 'notification error';
      genericityWarn.hidden = true;
      section.appendChild(genericityWarn);
      void this.#checkBoundaryGenericity(entry, genericityWarn);
    }
    if (!pattern.itemPattern) {
      const warn = document.createElement('p');
      warn.className = 'hint bindery-studio-build-itempattern-hint';
      warn.textContent = game.i18n!.localize('BINDERY.studio.buildSectionNeedsItemPattern' as never);
      section.appendChild(warn);
    }
    // [Step 29 Z1] "Shape shown in a human-readable way, not as a raw
    // regex" — ONLY when the author actually clicked examples (for a
    // pattern typed by hand under "Advanced" there's nothing to infer the
    // shape from, so nothing shows here — the field itself stays available
    // there).
    const shape = this.#itemPatternShape.get(entry.id);
    if (shape) {
      const shapeRow = document.createElement('div');
      shapeRow.className = 'bindery-studio-itempattern-shape';
      const shapeText = document.createElement('p');
      shapeText.className = 'hint';
      shapeText.textContent = `${game.i18n!.localize('BINDERY.studio.itemShapeRecognized' as never)}: ${game.i18n!.localize(`BINDERY.studio.itemShape.${shape}` as never)}`;
      shapeRow.appendChild(shapeText);
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'bindery-btn bindery-btn--secondary';
      clearBtn.textContent = game.i18n!.localize('BINDERY.studio.itemShapeClearButton' as never);
      clearBtn.addEventListener('click', () => this.#clearItemPatternExamples(entry));
      shapeRow.appendChild(clearBtn);
      section.appendChild(shapeRow);
    }
    wrap.appendChild(section);

    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
    details.appendChild(summary);
    details.appendChild(this.#buildSectionListForm(pattern));
    details.appendChild(this.#buildSingleAttachEditor(entry.id));
    if (slot === 'skills') {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = game.i18n!.localize('BINDERY.studio.skillsPatternAutoNote' as never);
      details.appendChild(hint);
    }
    wrap.appendChild(details);
    return wrap;
  }

  /**
   * [Bug reproduced live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] A boundary that
   * matches a token OUTSIDE the column of the header it was set for almost
   * certainly means the section sucked in content from the neighboring
   * column — warn instead of showing the result as correct (per the brief:
   * "the tool could notice this"). Uses `focus.page` (the page where the
   * header was clicked), NOT the page currently being viewed —
   * `terminateSectionBefore` is a SHARED regex for the whole book, but the
   * check must happen against the KNOWN, concrete geometry of one page.
   */
  async #checkBoundaryColumnMismatch(entry: PatternEntryDraft, warnEl: HTMLElement): Promise<void> {
    if (entry.pattern.kind !== 'sectionList' || !entry.pattern.terminateSectionBefore) return;
    const focus = this.#sectionBoundaryFocus;
    if (!focus || focus.patternId !== entry.id) return;
    const allTokens = await this.#getBuildTokens(focus.page);
    const headerToken = allTokens.find((t) => t.tokenIndex === focus.headerTokenIndex);
    if (!headerToken) return;
    let re: RegExp;
    try {
      re = new RegExp(entry.pattern.terminateSectionBefore, 'u');
    } catch {
      return;
    }
    const boundaryToken = allTokens.find((t) => t.tokenIndex > headerToken.tokenIndex && re.test(t.text));
    if (!boundaryToken) return;
    const { findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const band = findColumnBand(allTokens, headerToken.bbox);
    if (!isWithinColumnBand(boundaryToken.bbox, band)) {
      warnEl.hidden = false;
      warnEl.textContent = game.i18n!.localize('BINDERY.studio.buildSectionBoundaryWrongColumn' as never);
    }
  }

  /**
   * [user report, "Wrak.pdf": the Attacks section boundary calibrated on the
   * Sciapod ("Grapple and crush (maneuver):" — a subheading unique to
   * ITS OWN attack description) broke Calhoun's/Hansen's Attacks — for
   * them that text never occurs, so the section had nowhere to stop and
   * swallowed their whole Skills list as fake attack items]
   * `terminateSectionBefore` is ONE regex shared by ALL characters in the
   * whole book (not just the one the author happens to be dragging the
   * boundary on) — a token hit by a drag on ONE page can be a perfect match
   * for THAT entity while also being completely unique to it (a subheading
   * of its OWN description, rather than a generic header like "Skills:",
   * which repeats identically after every character). Checks whether the
   * set boundary matches AT LEAST ONCE on ANY other page of the document —
   * if it matches NOWHERE outside the page it was calibrated on, that's a
   * strong signal it's too specific, before the author saves the profile and
   * only discovers it after importing a different character. Cached by
   * (pattern id + boundary text) — without this, every panel re-render
   * (every click on this tab) would repeat the pass over the WHOLE document
   * from scratch.
   */
  #literalGenericityCache = new Map<string, boolean>();

  /**
   * [Step 37 Z2, an extension of Step 36] A generalized version of the first
   * version of this check (`terminateSectionBefore` ONLY) — the SAME
   * mechanism (scan the whole book, cache by value) applied to EVERY pattern
   * field that stores a literal token taken from the material, not just the
   * section boundary: `sectionHeader`, `trailingWordsStopBefore`, and any
   * future field of this kind. Counts on how many DIFFERENT pages of the
   * document the given regex matches at least one token — fewer than two
   * (only the one page the author set it on, or none at all) is a signal
   * that it's "probably too specific to a single entity/page".
   *
   * [simplification relative to the first version] Doesn't need to know the
   * "calibration page" (in Step 36 that was `#sectionBoundaryFocus.page`,
   * excluded from the search) — counting ALL matches (>=2, instead of "a
   * match ANYWHERE OTHER THAN one known page") gives the SAME result for
   * fields that came from a click (the calibration page always matches
   * itself, so you need >=1 more = >=2 total), and ADDITIONALLY works for
   * fields typed in by hand with no trace of which page was the source
   * (`trailingWordsStopBefore` — a plain `<input>` under "Advanced", not a
   * click on the PDF).
   *
   * `getCurrentValue` is checked AFTER the asynchronous scan of the whole
   * document — the author might have changed the value / switched tabs /
   * removed the pattern in the meantime; a result from a STALE scan must not
   * overwrite the panel's current state.
   */
  async #checkLiteralGenericity(cacheKeyPrefix: string, source: string, warnEl: HTMLElement, messageKey: string, getCurrentValue: () => string | undefined): Promise<void> {
    if (!this.#previewDocument || this.#previewDocument.pageCount <= 1) return;
    const cacheKey = `${cacheKeyPrefix}::${source}`;
    const cached = this.#literalGenericityCache.get(cacheKey);
    if (cached !== undefined) {
      warnEl.hidden = cached;
      if (!cached) warnEl.textContent = game.i18n!.localize(messageKey as never);
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(source, 'u');
    } catch {
      return;
    }
    let matchingPages = 0;
    for (let page = 1; page <= this.#previewDocument.pageCount; page++) {
      const tokens = await this.#getBuildTokens(page);
      if (tokens.some((t) => re.test(t.text))) {
        matchingPages++;
        if (matchingPages >= 2) break;
      }
    }
    if (getCurrentValue() !== source) return;
    const generic = matchingPages >= 2;
    this.#literalGenericityCache.set(cacheKey, generic);
    warnEl.hidden = generic;
    if (!generic) warnEl.textContent = game.i18n!.localize(messageKey as never);
  }

  /** [Step 36] `terminateSectionBefore` — its own message text (speaks directly about the "boundary"), everything else delegates to `#checkLiteralGenericity`. */
  async #checkBoundaryGenericity(entry: PatternEntryDraft, warnEl: HTMLElement): Promise<void> {
    if (entry.pattern.kind !== 'sectionList' || !entry.pattern.terminateSectionBefore) return;
    await this.#checkLiteralGenericity(`terminateSectionBefore:${entry.id}`, entry.pattern.terminateSectionBefore, warnEl, 'BINDERY.studio.buildSectionBoundaryTooSpecific', () =>
      entry.pattern.kind === 'sectionList' ? entry.pattern.terminateSectionBefore : undefined,
    );
  }

  // ---- [Step 34 Z2] "Notes" tab — prose blocks attached geometrically ----

  /**
   * [Step 34 Z2] Unlike the rest of the tabs (one pattern per slot), Notes
   * shows a LIST of independent blocks (`draft.notesPatterns`) plus a button
   * to add another — "The author can point to more than one [block], each
   * with its own label" (step 34's brief).
   */
  #buildNotesTabContent(): HTMLElement {
    const draft = this.#draft!;
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-notes-tab';

    for (const patternId of draft.notesPatterns) {
      const entry = draft.patterns.find((e) => e.id === patternId);
      if (!entry || entry.pattern.kind !== 'proseBlock') continue;
      wrap.appendChild(this.#buildNoteBlockRow(entry));
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-notes-add-button';
    addBtn.textContent = game.i18n!.localize('BINDERY.studio.notesAddButton' as never);
    addBtn.addEventListener('click', () => {
      const newEntry = createPatternDraft(
        'proseBlock',
        draft.patterns.map((e) => e.id),
      );
      if (newEntry.pattern.kind === 'proseBlock') newEntry.pattern.label = game.i18n!.localize('BINDERY.studio.notesDefaultLabel' as never);
      draft.patterns.push(newEntry);
      draft.notesPatterns.push(newEntry.id);
      // [Correction modeled on the other tabs] A new block starts directly
      // in pointing mode — the author doesn't have to click "Point to
      // example" separately right after adding it.
      this.#notesPickPatternId = newEntry.id;
      this.#refreshBuildPanel();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  /** [Step 34 Z2] One row = one note block: label, pointing button, delete, measurement status, per-entity preview on the current page, "Advanced" (length limit/search radius). */
  #buildNoteBlockRow(entry: PatternEntryDraft): HTMLElement {
    const row = document.createElement('div');
    if (entry.pattern.kind !== 'proseBlock') return row;
    const pattern = entry.pattern;
    const draft = this.#draft!;
    row.className = 'bindery-studio-note-block-row';

    const header = document.createElement('div');
    header.className = 'bindery-studio-note-block-header';
    header.appendChild(this.#textInput(pattern.label, (v) => (pattern.label = v), game.i18n!.localize('BINDERY.studio.notesLabelPlaceholder' as never)));

    const isPicking = this.#notesPickPatternId === entry.id;
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-note-pick-button';
    pickBtn.classList.toggle('active', isPicking);
    pickBtn.textContent = game.i18n!.localize('BINDERY.studio.notesPickButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#notesPickPatternId = isPicking ? null : entry.id;
      this.#refreshBuildPanel();
    });
    header.appendChild(pickBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'bindery-btn bindery-btn--icon';
    delBtn.textContent = '×';
    delBtn.title = game.i18n!.localize('BINDERY.studio.notesRemoveButton' as never);
    delBtn.addEventListener('click', () => {
      draft.patterns = draft.patterns.filter((e) => e.id !== entry.id);
      draft.notesPatterns = draft.notesPatterns.filter((id) => id !== entry.id);
      if (this.#notesPickPatternId === entry.id) this.#notesPickPatternId = null;
      this.#notesPreview.delete(entry.id);
      this.#refreshBuildPanel();
    });
    header.appendChild(delBtn);
    row.appendChild(header);

    const status = document.createElement('p');
    status.className = 'hint';
    status.textContent = pattern.measured
      ? `${game.i18n!.localize('BINDERY.studio.notesMeasuredPrefix' as never)} dx=${pattern.offsetDxPt.toFixed(1)}pt, dy=${pattern.offsetDyPt.toFixed(1)}pt`
      : game.i18n!.localize('BINDERY.studio.notesNotMeasuredYet' as never);
    row.appendChild(status);

    row.appendChild(this.#buildNotePreviewSection(entry.id, pattern));

    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
    details.appendChild(summary);
    details.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.notesMaxLengthLabel' as never),
        this.#numberInput(pattern.maxLengthChars, (v) => (pattern.maxLengthChars = v), { min: 1 }),
      ),
    );
    details.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.notesSearchRadiusLabel' as never),
        this.#numberInput(pattern.searchRadiusPt, (v) => (pattern.searchRadiusPt = v), { min: 1 }),
      ),
    );
    // [Live report after Step 39, "Wrak.pdf" Investigators] Turn on when the
    // note fields stack one under another with a VARIABLE gap between them
    // (e.g. a biography of different length per character shifts ALL
    // subsequent fields) — see the comment on `chainFromPrevious` in
    // `schema.ts`. Changing this toggle requires clicking AGAIN
    // (`#onNoteTokenClick` computes the offset relative to a DIFFERENT
    // reference point depending on this value), so it resets `measured`
    // instead of leaving the old measurement, which would point to the
    // wrong place after toggling.
    details.appendChild(
      this.#checkboxInput(
        pattern.chainFromPrevious,
        (v) => {
          pattern.chainFromPrevious = v;
          pattern.measured = false;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesChainFromPrevious' as never),
      ),
    );
    // [Live report, "I only select these two, and all the information from
    // those paragraphs gets written into them"] Turn on when THIS block
    // should collect MORE than just up to the nearest subheading — all the
    // way to the NEXT header of the SAME style as the clicked example (see
    // `stopAtSameFontRole` in `schema.ts`). Doesn't require re-measuring
    // (doesn't change the reference POINT, only the stop condition), so
    // `measured` is left as-is.
    details.appendChild(
      this.#checkboxInput(
        pattern.stopAtSameFontRole,
        (v) => {
          pattern.stopAtSameFontRole = v;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesStopAtSameFontRole' as never),
      ),
    );
    // [Live report, "Wrak.pdf" Investigators, "Your friends" in a separate
    // column] Turn on when this block sits in a column INDEPENDENT of the
    // attacks/skills length — see `anchorGridOnly` in `schema.ts`. Changes
    // the reference point, so (like `chainFromPrevious`) it resets `measured`.
    details.appendChild(
      this.#checkboxInput(
        pattern.anchorGridOnly,
        (v) => {
          pattern.anchorGridOnly = v;
          pattern.measured = false;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesAnchorGridOnly' as never),
      ),
    );
    row.appendChild(details);

    return row;
  }

  /** [Step 34 Z2] Preview of the text THIS note block finds for each entity on the CURRENT page — computed ONLY on request (never automatically on every redraw, to avoid a rendering loop), through the REAL engine (`analyzeProfilePage`, the same one that drives the full scan), not our own copy of the matching logic that could potentially drift out of sync. */
  // [Live report, "Investigator History only catches the first paragraph,
  // Your friends is empty" — despite a correctly measured offset] Both
  // symptoms had the SAME cause: `stopAtSameFontRole` wasn't checked — a
  // block starting at its OWN header (`heading`) stops at the FIRST smaller
  // subheading (`accent`) partway through (e.g. "Appearance:"/the next
  // acquaintance entry), instead of flying past it. The preview already
  // SHOWED the real (truncated/empty) result since step 34 — the problem was
  // ONLY that nothing explained to the author WHY the result was so short,
  // or where to look to fix it. Heuristic: when the found text is barely
  // longer than the label itself (i.e. practically just the header, nothing
  // after it) AND `stopAtSameFontRole` is still off — hint at it directly,
  // instead of relying on the author to guess. Shared between the per-block
  // preview and the tab badge (`#computeTabBadge`), so both agree on what
  // "looks truncated" means.
  static readonly #NOTE_TRUNCATION_MARGIN_CHARS = 15;
  #noteLooksTruncated(pattern: Extract<PatternDraft, { kind: 'proseBlock' }>, preview: { ordinal: number; text: string | null }[] | 'loading' | undefined): boolean {
    if (pattern.stopAtSameFontRole || !preview || preview === 'loading') return false;
    const labelLength = pattern.label.trim().length;
    return preview.some((item) => item.text !== null && item.text.trim().length <= labelLength + ProfileStudio.#NOTE_TRUNCATION_MARGIN_CHARS);
  }

  #buildNotePreviewSection(patternId: string, pattern: Extract<PatternDraft, { kind: 'proseBlock' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-note-preview';
    const preview = this.#notesPreview.get(patternId);
    if (preview === 'loading') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.notesPreviewLoading' as never);
      wrap.appendChild(p);
    } else if (preview) {
      if (preview.length === 0) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = game.i18n!.localize('BINDERY.studio.notesPreviewNoEntities' as never);
        wrap.appendChild(p);
      }
      for (const item of preview) {
        const p = document.createElement('p');
        p.className = item.text ? 'bindery-studio-note-preview-hit' : 'hint';
        const prefix = `${game.i18n!.localize('BINDERY.studio.notesPreviewEntityPrefix' as never)} ${item.ordinal + 1}:`;
        p.textContent = `${prefix} ${item.text ?? game.i18n!.localize('BINDERY.studio.notesPreviewNoMatch' as never)}`;
        wrap.appendChild(p);
      }
    }
    if (this.#noteLooksTruncated(pattern, preview)) {
      const hint = document.createElement('p');
      hint.className = 'notification warning';
      hint.textContent = game.i18n!.localize('BINDERY.studio.notesLooksTruncatedHint' as never);
      wrap.appendChild(hint);
    }
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'bindery-btn bindery-btn--secondary';
    refreshBtn.textContent = game.i18n!.localize('BINDERY.studio.notesRefreshPreviewButton' as never);
    refreshBtn.disabled = !pattern.measured || !this.#pdfBuffer || preview === 'loading';
    refreshBtn.addEventListener('click', () => void this.#refreshNotePreview(patternId));
    wrap.appendChild(refreshBtn);
    return wrap;
  }

  /**
   * [Step 34 Z2] Validates the CURRENT draft and runs `analyzeProfilePage`
   * ONLY for the current page — the REAL engine, but without running the
   * full, multi-page scan (`#runFullScan`) just to see one preview. Silently
   * returns on an invalid draft — validation errors are visible on the
   * "Check" tab anyway.
   *
   * [Bug reproduced live] `#getBuildTokens` (Step 23 Z6) DELIBERATELY
   * doesn't compute `fontRole` — `proseBlock`/Step 33 Z4 need it to
   * recognize subheadings, so the preview here uses
   * `getFontRoleAwareTokensForPage` (more expensive — a full document
   * inventory — but computed ONLY for this click, not on every redraw), see
   * its documentation.
   */
  async #refreshNotePreview(patternId: string): Promise<void> {
    if (!this.#draft || !this.#pdfBuffer) return;
    this.#notesPreview.set(patternId, 'loading');
    this.#refreshBuildPanel();

    const result = await validateActorProfileFile(draftToProfileInput(this.#draft));
    if (!result.ok) {
      this.#notesPreview.delete(patternId);
      this.#refreshBuildPanel();
      return;
    }
    const notePattern = result.profile.patterns[patternId];
    if (!notePattern || notePattern.kind !== 'proseBlock') {
      this.#notesPreview.delete(patternId);
      this.#refreshBuildPanel();
      return;
    }

    const { analyzeProfilePage, getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });
    // [Step 39 Z1/Z2] `result.profile` comes from
    // `draftToProfileInput(this.#draft)` (ONLY the active route, at the
    // root) — FORCE the `'npc'` route, so `resolvePatternSetForRoute`
    // resolves it to THESE patterns, regardless of which route is actually
    // active in the editor (`#activeRoute`).
    const analysis = analyzeProfilePage(tokens, result.profile, this.#state.currentPageNumber, 'npc');
    const label = notePattern.label;
    this.#notesPreview.set(
      patternId,
      analysis.entities.map((e, i) => ({ ordinal: i, text: e.notes.find((n) => n.label === label)?.text ?? null })),
    );
    this.#refreshBuildPanel();
  }

  /**
   * [Step 34 Z2] A click on the "Notes" tab, ONLY when some block is waiting
   * to be pointed at (`#notesPickPatternId`) — otherwise clicks on this tab
   * do nothing. Computes `offset` (the shift RELATIVE to the end of the
   * OWNING entity's OWN content — `lastClaimedTokenBbox`, the same function
   * the real engine uses, see `proseBlock.ts`) and saves it into the draft;
   * NEVER remembers the literal text (R2).
   *
   * [Bug reproduced live, "Wrak.pdf" p. 24] `tok`/`allTokens` (this
   * function's parameters) come from `#getBuildTokens` (the clickable
   * rectangles on the PDF) — DELIBERATELY without `fontRole` (Step 23 Z6),
   * so `matchSectionList`'s subheading recognition (`fontRole === 'accent'`)
   * and, through it, the WHOLE Step-33 Z4 mechanism (descriptions under
   * attacks) stayed silent, despite a correct `offset` — measured directly:
   * a Node verification script (Step 34, `tokenizePage` with a full
   * inventory) found the Sciapod's note correctly, the SAME function in
   * Profile Studio (`#getBuildTokens`) did not. Fix: `allTokens` (the
   * parameter) is used ONLY to locate the clicked token's bbox (fontRole
   * doesn't matter for that) — the ENTIRE geometry matching is computed on
   * FRESHLY fetched, fontRole-aware tokens (`getFontRoleAwareTokensForPage`),
   * matching the clicked token BY BBOX (not by `tok.tokenIndex` — two
   * different tokenizations can split/merge tokens DIFFERENTLY, so the same
   * indices could point to different tokens in each list).
   */
  async #onNoteTokenClick(tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    void allTokens;
    if (!this.#draft || !this.#notesPickPatternId || !this.#pdfBuffer) return;
    const patternId = this.#notesPickPatternId;
    const entry = this.#draft.patterns.find((e) => e.id === patternId);
    if (!entry || entry.pattern.kind !== 'proseBlock') return;

    // Validates through the REAL schema (`@bindery/core`), to get the
    // patterns in the shape `matchLabelledPairs`/`matchSectionList` expect
    // (labels as a Record, not the draft's list) — one source of truth
    // instead of our own parallel conversion.
    // [Problem reproduced live, user report "I click, nothing happens"] All
    // the early returns below used to be COMPLETELY silent — copied from
    // `#refreshNotePreview` (where a silent return is intentional, since
    // validation errors are visible on the "Check" tab anyway), but HERE, in
    // the actual click that measures the offset, having no message at all
    // looks like a completely broken button — the author has no way to find
    // out that, say, the draft has a validation error elsewhere, or that the
    // current page simply has no matching trait grid. Every branch now gets
    // its own, specific message (`ui.notifications`).
    const result = await validateActorProfileFile(draftToProfileInput(this.#draft));
    if (!result.ok) {
      // [Problem reproduced live, user report: the error occurred on a
      // draft that — saved IMMEDIATELY through this same
      // `draftToProfileInput` ("Save as .json", zero validation/
      // normalization along the way) — validates CLEANLY after being
      // reloaded. The root cause remains unreproduced; instead of
      // guessing further, the message now CARRIES the actual Zod error text
      // (the first of `result.issues`) plus the full list in the console
      // (F12) — next time it'll be possible to diagnose from the FIRST
      // occurrence, without having to reproduce it by guesswork.
      //
      // [Problem reproduced live, user report: "I get warnings 'id: String
      // must contain at least 1 character(s)'"] This RAW Zod message means
      // nothing to an author building a new profile from scratch —
      // `id`/`gameLine`/`language`/`title`/`publication` (the 5 fields with
      // `.min(...)` in `profileV2Schema`, see `schema.ts`) default to empty
      // (`createEmptyProfileDraft`) and DON'T matter for the note matching
      // itself — they're just file metadata. When ALL current errors belong
      // to this set of five, the message points directly to where to fill
      // them in (the collapsible "Metadata and page range" header above the
      // tabs), instead of the raw validator text.
      const metadataIssue = ProfileStudio.#friendlyMetadataValidationMessage(result.issues);
      console.warn('Bindery | Profile Studio: notes, draft validation error while attempting to measure:', result.issues);
      ui.notifications?.warn(metadataIssue ?? `${game.i18n!.localize('BINDERY.studio.notesPickFailedInvalidProfile' as never)} (${result.issues[0] ?? '?'})`);
      return;
    }
    const anchorPattern = result.profile.patterns[result.profile.entityAssembly.anchor];
    if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoAnchor' as never));
      return;
    }

    const { matchLabelledPairs, matchSectionList, matchProseBlock, lastClaimedTokenBbox, lastClaimedTokenIndex, getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });

    // Matches the clicked token in the NEWLY fetched list BY BBOX (nearest
    // center) — see the comment on this function for why not by index.
    let clickedIndex = -1;
    let bestDist = Infinity;
    const tcx = (tok.bbox.minX + tok.bbox.maxX) / 2;
    const tcy = (tok.bbox.minY + tok.bbox.maxY) / 2;
    tokens.forEach((t, i) => {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      const d = Math.hypot(cx - tcx, cy - tcy);
      if (d < bestDist) {
        bestDist = d;
        clickedIndex = i;
      }
    });
    if (clickedIndex === -1) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoToken' as never));
      return;
    }
    const clickedToken = tokens[clickedIndex]!;

    const grids = matchLabelledPairs(tokens, anchorPattern);
    if (grids.length === 0) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoGridOnPage' as never));
      return;
    }

    // The click's "owner": the anchor CLOSEST to the clicked token IN THE
    // STREAM that isn't AFTER it (the same rule as the rest of the engine —
    // an entity "owns" everything from its OWN anchor to the start of the
    // NEXT one).
    const owningGrid = [...grids].reverse().find((g) => g.startIndex <= clickedIndex) ?? grids[0]!;
    const hardStopTokenIndices = grids.map((g) => g.startIndex);

    const attackPattern = this.#activeAttackPatternId ? result.profile.patterns[this.#activeAttackPatternId] : undefined;
    const skillsPattern = this.#activeSkillsPatternId ? result.profile.patterns[this.#activeSkillsPatternId] : undefined;
    const attacksMatches = attackPattern?.kind === 'sectionList' ? matchSectionList(tokens, attackPattern, hardStopTokenIndices) : [];
    const skillsMatches = skillsPattern?.kind === 'sectionList' ? matchSectionList(tokens, skillsPattern, hardStopTokenIndices) : [];
    const ownAttacks = attacksMatches.filter((m) => m.headerTokenIndex >= owningGrid.startIndex).sort((a, b) => a.headerTokenIndex - b.headerTokenIndex)[0] ?? null;
    const ownSkills = skillsMatches.filter((m) => m.headerTokenIndex >= owningGrid.startIndex).sort((a, b) => a.headerTokenIndex - b.headerTokenIndex)[0] ?? null;

    const fixedReferenceBbox = lastClaimedTokenBbox(tokens, { grid: owningGrid, attacks: ownAttacks, skills: ownSkills }, hardStopTokenIndices);
    // [Live report, "Wrak.pdf" Investigators, "Your friends" in a separate
    // column, `anchorGridOnly`] The same principle as `chainFromPrevious`
    // below: the click has to compute the SAME way the engine will. The
    // variant WITHOUT attacks/skills in the reference point — see the
    // comment on `anchorGridOnly` in `schema.ts`.
    const fixedReferenceBboxGridOnly = lastClaimedTokenBbox(tokens, { grid: owningGrid }, hardStopTokenIndices);
    const fixedReferenceFor = (p: { anchorGridOnly?: boolean }) => (p.anchorGridOnly ? fixedReferenceBboxGridOnly : fixedReferenceBbox);
    // [Live report after Step 39, "Wrak.pdf" Investigators, `chainFromPrevious`]
    // The click MUST compute the offset RELATIVE TO THE SAME point the
    // engine will use on import (`assembleStatblocksOnPage`) — otherwise the
    // saved value would work on this page (where it happened to be clicked),
    // but nowhere else. When THIS pattern has `chainFromPrevious`, this code
    // therefore replays EXACTLY the same chain the engine uses: it matches,
    // in order, EVERY earlier `notesPatterns` pattern on this page (each
    // relative to ITS OWN fixed/chained point, depending on ITS OWN flag),
    // and the end bbox of the last successful match is the reference point.
    const referenceTokenIndex = lastClaimedTokenIndex(tokens, { grid: owningGrid, attacks: ownAttacks, skills: ownSkills }, hardStopTokenIndices);
    let referenceBbox = fixedReferenceFor(entry.pattern);
    if (entry.pattern.chainFromPrevious) {
      const notePatternIds = result.profile.entityAssembly.notesPatterns ?? [];
      const priorIds = notePatternIds.slice(0, notePatternIds.indexOf(patternId));
      const claimedForChain = new Set<number>();
      let chainBbox = fixedReferenceBbox;
      for (const priorId of priorIds) {
        const priorPattern = result.profile.patterns[priorId];
        if (!priorPattern || priorPattern.kind !== 'proseBlock') continue;
        const priorMatch = matchProseBlock(tokens, priorPattern, priorPattern.chainFromPrevious ? chainBbox : fixedReferenceFor(priorPattern), {
          hardStopTokenIndices,
          excludedTokenIndices: claimedForChain,
          referenceTokenIndex,
        });
        if (priorMatch) {
          for (let t = priorMatch.startIndex; t < priorMatch.endIndex; t++) claimedForChain.add(t);
          chainBbox = tokens[priorMatch.endIndex - 1]!.bbox;
        }
      }
      referenceBbox = chainBbox;
    }
    entry.pattern.offsetDxPt = Math.round((clickedToken.bbox.minX - referenceBbox.minX) * 100) / 100;
    entry.pattern.offsetDyPt = Math.round((clickedToken.bbox.minY - referenceBbox.minY) * 100) / 100;
    entry.pattern.measured = true;
    // [user report, "I click on Invisibility and it picks the name itself"]
    // The block's label is FREE, DISPLAYED TEXT (it doesn't participate in
    // the geometric matching — R2 applies ONLY to the offset), so suggesting
    // it from the clicked token doesn't break the "never literal content"
    // rule (that rule protects the MATCHING MECHANISM, not a cosmetic name
    // visible only to the profile's author). We suggest it ONLY when the
    // author hasn't named the block themselves yet (empty, or still the
    // default "Description") — it doesn't overwrite a manually typed name on
    // a REPEATED click (e.g. an offset correction).
    const defaultLabel = game.i18n!.localize('BINDERY.studio.notesDefaultLabel' as never);
    if (!entry.pattern.label.trim() || entry.pattern.label === defaultLabel) {
      const suggested = clickedToken.text.replace(/:\s*$/, '').trim();
      if (suggested) entry.pattern.label = suggested;
    }
    this.#notesPickPatternId = null;
    this.#refreshBuildPanel();
    void this.#refreshNotePreview(patternId);
  }

  /**
   * [Report after step 30, "Separating the name from the type/occupation"]
   * One tab, TWO independent pointing modes — "Name" and "Occupation/type"
   * are two aspects of THE SAME entity, usually pointed at in a single
   * sequence of clicks (e.g. "John Calhoun" -> "yacht captain"), so they
   * stay on one tab instead of two separate ones — unlike Attacks/Skills
   * (two SEPARATE sections on the page, each deserving its own tab).
   */
  #buildNameTabContent(): HTMLElement {
    const wrap = document.createElement('div');

    const modeRow = document.createElement('div');
    modeRow.className = 'bindery-studio-name-submode-row';
    const nameModeBtn = document.createElement('button');
    nameModeBtn.type = 'button';
    nameModeBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-name-submode-toggle';
    nameModeBtn.classList.toggle('active', this.#nameSubMode === 'name');
    nameModeBtn.textContent = game.i18n!.localize('BINDERY.studio.nameSubModeName' as never);
    nameModeBtn.addEventListener('click', () => {
      this.#nameSubMode = 'name';
      // A full render (not `#refreshBuildPanel`) — switching modes ALSO
      // affects the "Name" tab's badge on the bar (`#computeTabBadge`),
      // computed in `_prepareContext`, not just the build panel itself.
      void this.render();
    });
    modeRow.appendChild(nameModeBtn);

    const typeLabelModeBtn = document.createElement('button');
    typeLabelModeBtn.type = 'button';
    typeLabelModeBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-name-submode-toggle';
    typeLabelModeBtn.classList.toggle('active', this.#nameSubMode === 'typeLabel');
    typeLabelModeBtn.textContent = game.i18n!.localize('BINDERY.studio.nameSubModeTypeLabel' as never);
    typeLabelModeBtn.addEventListener('click', () => {
      this.#nameSubMode = 'typeLabel';
      void this.render();
    });
    modeRow.appendChild(typeLabelModeBtn);
    wrap.appendChild(modeRow);

    const isTypeLabel = this.#nameSubMode === 'typeLabel';
    const entry = this.#findPattern(isTypeLabel ? this.#activeTypeLabelPatternId : this.#activeNamePatternId);
    const previewText = isTypeLabel ? this.#typeLabelPreviewText : this.#namePreviewText;

    if (previewText) {
      const preview = document.createElement('p');
      preview.className = 'bindery-studio-build-name-preview';
      const previewLabelKey = isTypeLabel ? 'BINDERY.studio.buildTypeLabelPreviewLabel' : 'BINDERY.studio.buildNamePreviewLabel';
      preview.textContent = `${game.i18n!.localize(previewLabelKey as never)}: „${previewText}”`;
      wrap.appendChild(preview);
    }

    if (entry?.pattern.kind === 'fontRoleCandidate') {
      const details = document.createElement('details');
      details.className = 'bindery-studio-advanced-details';
      const summary = document.createElement('summary');
      summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
      details.appendChild(summary);
      details.appendChild(this.#buildFontRoleCandidateForm(entry.pattern));
      // `nameConfidenceThreshold`/`namePlaceholder` concern ONLY name
      // resolution (`resolveEntityNames`) — `typeLabel` uses `attachNearest`,
      // with no notion of confidence/placeholder (see `assembleStatblocks.ts`).
      if (!isTypeLabel) details.appendChild(this.#buildNameAssemblyFields());
      wrap.appendChild(details);
    }
    return wrap;
  }

  /** [Correction] `nameConfidenceThreshold`/`namePlaceholder` have no natural "click" equivalent — they stay under the Name tab's Advanced section, since that's where they belong thematically (formerly: a separate `entityAssembly` section in the Editor). */
  #buildNameAssemblyFields(): HTMLElement {
    const wrap = document.createElement('div');
    const draft = this.#draft!;
    wrap.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.fieldNameConfidence' as never),
        this.#numberInput(draft.nameConfidenceThreshold, (v) => (draft.nameConfidenceThreshold = v), { min: 0, max: 1, step: 0.05 }),
      ),
    );
    wrap.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldNamePlaceholder' as never), this.#textInput(draft.namePlaceholder, (v) => (draft.namePlaceholder = v))));
    return wrap;
  }

  /** [Correction] One attach-rule row (strategy/distance/Measure) for the GIVEN pattern — no "which pattern" list/dropdown (the old `#buildAttachRuleRow`), because in the new architecture every slot has EXACTLY one, automatically created rule. */
  #buildSingleAttachEditor(patternId: string): HTMLElement {
    const draft = this.#draft!;
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-attach-rule-wrap';
    let rule = draft.attach.find((r) => r.pattern === patternId);
    if (!rule) {
      rule = { pattern: patternId, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT };
      draft.attach.push(rule);
    }

    const row = document.createElement('div');
    row.className = 'bindery-studio-attach-rule-row';
    row.appendChild(
      this.#selectInput(
        rule.strategy,
        [
          { value: 'nearestBelow', label: 'nearestBelow' },
          { value: 'nearestAbove', label: 'nearestAbove' },
          { value: 'nearest', label: 'nearest' },
        ],
        (v) => (rule!.strategy = v as AttachRuleDraft['strategy']),
      ),
    );
    row.appendChild(this.#numberInput(rule.maxDistancePt, (v) => (rule!.maxDistancePt = v), { min: 0 }));
    wrap.appendChild(row);

    const anchorEntry = this.#findPattern(draft.anchor);
    const candidateEntry = this.#findPattern(patternId);
    // [Step 29 Z3, "while we're at it"] `fontRoleCandidate` (Name) included
    // as of this step — `measureAttachGeometry` (core) already supports it,
    // the exclusion was only here (discovery #3 from step 28: the attach
    // rule for the name used to be created automatically with a FIXED,
    // unmeasured `maxDistancePt`).
    const canMeasure =
      this.#pdfBuffer !== null &&
      anchorEntry?.pattern.kind === 'labelledPairs' &&
      (candidateEntry?.pattern.kind === 'labelledPairs' || candidateEntry?.pattern.kind === 'sectionList' || candidateEntry?.pattern.kind === 'fontRoleCandidate');
    if (canMeasure) wrap.appendChild(this.#buildMeasureSection(draft, rule));
    return wrap;
  }

  // ---- Whole-document panel (the "Check" tab) -----------------------

  #mountDocumentPanel(doc: DocumentAnalysis | null): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="studio-document"]');
    if (!container) return;
    container.innerHTML = '';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'bindery-btn bindery-btn--primary';
    runBtn.textContent = game.i18n!.localize('BINDERY.studio.runFullScanButton' as never);
    runBtn.disabled = !this.#pdfBuffer || !this.#draft || this.#state.isAnalyzing;
    runBtn.addEventListener('click', () => ProfileStudio.#onRunFullScan.call(this));
    container.appendChild(runBtn);

    if (this.#state.isAnalyzing) {
      const p = document.createElement('span');
      p.className = 'hint';
      p.textContent = `${game.i18n!.localize('BINDERY.studio.analyzing' as never)}${this.#state.analyzeProgress ? ` (${this.#state.analyzeProgress.done}/${this.#state.analyzeProgress.total})` : ''}`;
      container.appendChild(p);
    }
    if (this.#state.analyzeError) {
      const p = document.createElement('span');
      p.className = 'notification error';
      p.textContent = this.#state.analyzeError;
      container.appendChild(p);
    }
    if (this.#state.editorIssues) {
      const list = document.createElement('ul');
      list.className = 'bindery-actor-profile-issues';
      for (const issue of this.#state.editorIssues) {
        const li = document.createElement('li');
        li.textContent = issue;
        list.appendChild(li);
      }
      container.appendChild(list);
    }

    if (!doc) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noAnalysisYet' as never);
      container.appendChild(p);
      return;
    }

    const summary = document.createElement('p');
    summary.className = 'bindery-studio-summary-bar';
    summary.textContent = `${game.i18n!.localize('BINDERY.studio.summaryEntities' as never)}: ${doc.totalEntities} · ${game.i18n!.localize('BINDERY.studio.summaryWarnings' as never)}: ${doc.totalWarnings} · ${game.i18n!.localize('BINDERY.studio.summaryPlaceholders' as never)}: ${doc.totalPlaceholderNames}`;
    container.appendChild(summary);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'bindery-btn bindery-btn--secondary';
    exportBtn.textContent = game.i18n!.localize('BINDERY.studio.exportButton' as never);
    exportBtn.addEventListener('click', () => ProfileStudio.#onExportDiagnostics.call(this));
    container.appendChild(exportBtn);

    const zeroPatterns = doc.patternMatchTotals.filter((p) => p.matchCount === 0);
    if (zeroPatterns.length > 0) {
      const warn = document.createElement('div');
      warn.className = 'bindery-diagnostic-row bindery-diagnostic-warning';
      warn.textContent = `${game.i18n!.localize('BINDERY.studio.zeroMatchPatterns' as never)}: ${zeroPatterns.map((p) => this.#patternDisplayName(p.patternId)).join(', ')}`;
      container.appendChild(warn);
    }

    const table = document.createElement('table');
    table.className = 'bindery-result bindery-studio-pattern-table';
    const tbody = document.createElement('tbody');
    for (const p of doc.patternMatchTotals) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = this.#patternDisplayName(p.patternId);
      const td = document.createElement('td');
      td.textContent = String(p.matchCount);
      if (p.matchCount === 0) td.classList.add('bindery-studio-zero-count');
      // [Step 29 Z4, O3] "549 matches for three entities shown just as
      // neutrally as 3" — a `sectionList` pattern (itemPattern) matching
      // MANY TIMES more often than the entity count is SUSPICIOUS, not
      // effective (typically an itemPattern that's too loose and also
      // catches content outside the items). `sectionList` ONLY:
      // `fontRoleCandidate` by design has many token candidates (H2 from
      // step 12 — that's the INPUT to geometric pairing, not the result), a
      // high count there is NORMAL, not suspicious.
      if (this.#isSuspiciousMatchCount(p)) {
        td.classList.add('bindery-studio-suspicious-count');
        td.title = game.i18n!.localize('BINDERY.studio.suspiciousMatchCountHint' as never);
      }
      tr.append(th, td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);

    container.appendChild(this.#buildMechanicalCheckSection(doc));
    container.appendChild(this.#buildDocEntityList(doc));
  }

  /**
   * [Step 29 Z4] `draft-1`…`draft-5` -> the names of the tabs they were
   * built with ("Traits"/"Attacks"/...) — the same identifiers the author
   * ALREADY sees on the tab cards. A pattern outside the five slots
   * (shouldn't occur in this UI) simply falls back to its raw id — a safe
   * no-op, not a bug.
   *
   * [Report after step 30] Name/occupation are checked SEPARATELY, BEFORE
   * the loop over `BUILD_TABS`, DIRECTLY via
   * `#activeNamePatternId`/`#activeTypeLabelPatternId` —
   * `#patternIdForTab('name')` returns ONLY whichever slot is the currently
   * active mode (`#nameSubMode`), so using it here would incorrectly fail to
   * recognize one of the two patterns, depending on which mode the author
   * happened to be viewing at the moment this function was called.
   */
  #patternDisplayName(patternId: string): string {
    if (patternId === this.#activeNamePatternId) return game.i18n!.localize('BINDERY.studio.nameSubModeName' as never);
    if (patternId === this.#activeTypeLabelPatternId) return game.i18n!.localize('BINDERY.studio.nameSubModeTypeLabel' as never);
    for (const tab of BUILD_TABS) {
      if (tab !== 'check' && tab !== 'name' && this.#patternIdForTab(tab) === patternId) return game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never);
    }
    return patternId;
  }

  static readonly #SUSPICIOUS_MATCH_RATIO = 20;

  #isSuspiciousMatchCount(p: PatternMatchCount): boolean {
    const entry = this.#findPattern(p.patternId);
    if (entry?.pattern.kind !== 'sectionList') return false;
    if (!this.#docAnalysis || this.#docAnalysis.totalEntities === 0) return false;
    return p.matchCount > this.#docAnalysis.totalEntities * ProfileStudio.#SUSPICIOUS_MATCH_RATIO;
  }

  /** [Step 29 Z4, O3/O4] A list of entities found across the WHOLE document — for each: name or placeholder, page, category (complete/with gaps/unnamed), what's missing, jump to the page with one click. Replaces the old per-page aggregates ("3 · 1 warning"), where you had to figure out yourself WHICH three entities were meant. */
  #buildDocEntityList(doc: DocumentAnalysis): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-entity-list';
    for (const page of doc.pages) {
      // [Step 39 Z1] The old `page.isPregen` (a binary "skip") replaced by
      // `route`+`routeSupported` — a page CAN be skipped for TWO reasons
      // other than before (the `playerCharacter` route without a pattern
      // section IN THIS profile), so the message now names DIRECTLY which
      // route it concerns.
      if (!page.routeSupported) {
        const row = document.createElement('div');
        row.className = 'bindery-diagnostic-row';
        row.textContent = `${game.i18n!.localize('BINDERY.studio.pageLabel' as never)} ${page.page} (${this.#routeLabel(page.route)}): ${game.i18n!.localize('BINDERY.studio.routeUnsupportedSkipped' as never)}`;
        wrap.appendChild(row);
        continue;
      }
      for (const entity of page.entities) {
        wrap.appendChild(this.#buildDocEntityRow(page.page, page.route, entity));
      }
    }
    return wrap;
  }

  static readonly #ENTITY_CATEGORY_LABEL_KEYS = {
    complete: 'entityCategoryComplete',
    partial: 'entityCategoryPartial',
    unnamed: 'entityCategoryUnnamed',
  } as const;

  /** [Step 29 Z4] Separate from `#buildEntityRow` (the entity panel on the page tab, a COMPLETELY different row shape) — the `Doc` name emphasizes that this is a view of the WHOLE document (the "Check" tab), not a single page. */
  #buildDocEntityRow(page: number, route: PageRoute, entity: EntityAnalysis): HTMLElement {
    // [Step 29 Z4] The same "has gaps" definition as the already-existing
    // `pageSummaries.warningCount`/`fullCount` (`aggregateDocumentAnalysis`,
    // `@bindery/core`) — `outOfRange`, NOT `match === null` — so the numbers
    // in the summary bar and the categories in this list NEVER contradict
    // each other. `match === null` WITHOUT `outOfRange` (the pattern isn't
    // configured for this profile at all — e.g. no `skillsPattern`) is NOT a
    // gap, it's simply "this part doesn't apply to this profile".
    const hasGap = Boolean(entity.derived.outOfRange || entity.attacks.outOfRange || entity.skills.outOfRange);
    const category: 'complete' | 'partial' | 'unnamed' = entity.name.kind !== 'confident' ? 'unnamed' : hasGap ? 'partial' : 'complete';

    const row = document.createElement('div');
    row.className = `bindery-diagnostic-row bindery-studio-entity-row bindery-studio-entity-row-${category}`;

    const nameText = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
    // [Step 29 Z4] Conceptual roles (Derived/Attacks/Skills), NOT literal
    // pattern ids — `entity.derived`/`.attacks`/`.skills` are the RESULTS of
    // attach rules, they don't carry the `patternId` of the pattern used,
    // and ids in this UI are usually generated "draft-N", not named keys —
    // `#patternDisplayName` would have nothing to find here.
    const missing: BuildTab[] = [];
    if (entity.derived.match === null) missing.push('derived');
    if (entity.attacks.match === null) missing.push('attacks');
    if (entity.skills.match === null) missing.push('skills');

    const header = document.createElement('div');
    header.className = 'bindery-studio-entity-row-header';
    const nameEl = document.createElement('span');
    nameEl.textContent = nameText;
    header.appendChild(nameEl);
    const pageEl = document.createElement('span');
    pageEl.className = 'hint';
    pageEl.textContent = `${game.i18n!.localize('BINDERY.studio.pageLabel' as never)} ${page}`;
    header.appendChild(pageEl);
    // [Step 39 Z2] Route tag — "Check" mixes entities from BOTH routes in
    // one list (auto-routed per page), so every row must DIRECTLY name
    // which route it concerns (per the brief: "Preview and Check must show
    // which route they concern").
    const routeEl = document.createElement('span');
    routeEl.className = `bindery-studio-route-tag bindery-studio-route-tag-${route}`;
    routeEl.textContent = this.#routeLabel(route);
    header.appendChild(routeEl);
    const categoryEl = document.createElement('span');
    categoryEl.className = `bindery-studio-entity-category bindery-studio-entity-category-${category}`;
    categoryEl.textContent = game.i18n!.localize(`BINDERY.studio.${ProfileStudio.#ENTITY_CATEGORY_LABEL_KEYS[category]}` as never);
    header.appendChild(categoryEl);
    row.appendChild(header);

    if (missing.length > 0) {
      const missingEl = document.createElement('p');
      missingEl.className = 'hint';
      missingEl.textContent = `${game.i18n!.localize('BINDERY.studio.entityMissingLabel' as never)}: ${missing.map((tab) => game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never)).join(', ')}`;
      row.appendChild(missingEl);
    }

    row.addEventListener('click', () => {
      this.#state.currentPageNumber = page;
      this.#state.buildTab = 'grid';
      // [Step 39 Z2] Switch to THIS entity's route — without this, jumping
      // from the whole-document list to a page on a route other than the
      // one currently being edited would immediately show a "route
      // mismatch" message (`#mountEntityPanel`) instead of the entity the
      // author JUST clicked.
      this.#switchRoute(route);
      void this.render();
    });
    return row;
  }

  // ---- [Step 24 Z3] Mechanic-mapping verification ------------------------

  #buildMechanicalCheckSection(doc: DocumentAnalysis): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-mechanical-section';
    const h = document.createElement('h3');
    h.textContent = game.i18n!.localize('BINDERY.studio.mechanicalSectionTitle' as never);
    section.appendChild(h);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = game.i18n!.localize('BINDERY.studio.mechanicalHint' as never);
    section.appendChild(hint);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'bindery-studio-relation-rows';
    this.#mechanicalRelations.forEach((text, i) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-relation-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bindery-input';
      input.value = text;
      input.placeholder = game.i18n!.localize('BINDERY.studio.relationPlaceholder' as never);
      input.addEventListener('change', () => (this.#mechanicalRelations[i] = input.value));
      row.appendChild(input);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        this.#mechanicalRelations.splice(i, 1);
        if (this.#mechanicalRelations.length === 0) this.#mechanicalRelations.push('');
        this.#mechanicalResults = null;
        void this.render();
      });
      row.appendChild(delBtn);
      rowsWrap.appendChild(row);
    });
    section.appendChild(rowsWrap);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bindery-btn bindery-btn--secondary';
    addBtn.textContent = game.i18n!.localize('BINDERY.studio.addRelationButton' as never);
    addBtn.addEventListener('click', () => {
      this.#mechanicalRelations.push('');
      void this.render();
    });
    section.appendChild(addBtn);

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'bindery-btn bindery-btn--primary';
    checkBtn.textContent = game.i18n!.localize('BINDERY.studio.checkRelationsButton' as never);
    checkBtn.addEventListener('click', () => void this.#runMechanicalCheck(doc));
    section.appendChild(checkBtn);

    if (this.#mechanicalResults) section.appendChild(this.#buildMechanicalResults(this.#mechanicalResults));

    return section;
  }

  async #runMechanicalCheck(doc: DocumentAnalysis): Promise<void> {
    const texts = this.#mechanicalRelations.filter((t) => t.trim().length > 0);
    if (texts.length === 0) {
      this.#mechanicalResults = null;
      await this.render();
      return;
    }
    const { extractCanonicalValues, checkRelations } = await import('@bindery/core');
    const entities = doc.pages.flatMap((p) => p.entities).map((e) => extractCanonicalValues(e));
    this.#mechanicalResults = checkRelations(texts, entities);
    await this.render();
  }

  #buildMechanicalResults(results: readonly RelationCheckResult[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-relation-results';
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'bindery-diagnostic-row';
      if (!r.ok) {
        row.classList.add('bindery-diagnostic-error');
        row.textContent = `${r.text}: ${game.i18n!.localize('BINDERY.studio.relationErrorUnparseable' as never)}`;
        wrap.appendChild(row);
        continue;
      }
      if (r.warning) row.classList.add('bindery-diagnostic-warning');
      const warningText =
        r.warning === 'low-match-rate'
          ? ` ⚠ ${game.i18n!.localize('BINDERY.studio.relationWarningLowMatch' as never)}`
          : r.warning === 'suspiciously-perfect-equality'
            ? ` ⚠ ${game.i18n!.localize('BINDERY.studio.relationWarningPerfect' as never)}`
            : '';
      row.textContent = `${r.text}: ${r.matchCount}/${r.totalChecked}${warningText}`;
      wrap.appendChild(row);
      if (r.mismatches.length > 0) {
        const list = document.createElement('ul');
        list.className = 'bindery-studio-relation-mismatches';
        for (const m of r.mismatches) {
          const li = document.createElement('li');
          li.textContent = `${m.label}: ${r.lhsKey}=${m.actual}, ${game.i18n!.localize('BINDERY.studio.relationExpected' as never)} ${r.op}${m.expected}`;
          list.appendChild(li);
        }
        wrap.appendChild(list);
      }
    }
    return wrap;
  }

  async #populateCanonicalKeyDatalist(): Promise<void> {
    let datalist = this.element.querySelector<HTMLDataListElement>('#bindery-canonical-keys');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'bindery-canonical-keys';
      this.element.appendChild(datalist);
    }
    if (datalist.childElementCount > 0) return;
    const { CANONICAL_STAT_KEYS } = await import('@bindery/core');
    for (const key of CANONICAL_STAT_KEYS) {
      const opt = document.createElement('option');
      opt.value = key;
      datalist.appendChild(opt);
    }
  }

  // ---- Form elements — small helper builders ----------------

  #formRow(labelText: string, input: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'bindery-studio-form-row';
    const span = document.createElement('span');
    span.textContent = labelText;
    row.append(span, input);
    return row;
  }

  #textInput(value: string, onChange: (v: string) => void, placeholder?: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bindery-input';
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  /**
   * [Step 29 Z2, O2/O2-continued] Shared construction of a regex field
   * (input or textarea) — SYNTAX validation live (`input`), saved to the
   * draft only on `change` (losing focus/Enter). Stops "staying silent": an
   * invalid regex gets a READABLE message BELOW the field (not just a red
   * border — the author doesn't have a DevTools console), and `\\d` (text
   * copied from a JSON file, where every backslash is doubled) gets a direct
   * hint with a fix button, instead of a silent `Nothing to repeat` somewhere
   * else. Returns `{ el, input }` instead of JUST the field — `el` (input +
   * messages) goes to `#formRow`, `input` remains for cases where the caller
   * has to set the value programmatically (the 📍 button).
   */
  #buildRegexField(value: string, onChange: (v: string) => void, opts: { multiline: boolean }): { el: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement } {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-regex-field';
    const input = opts.multiline ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = 'text';
    else input.rows = 3;
    input.className = 'bindery-input bindery-studio-regex-input';
    input.value = value;

    const errorEl = document.createElement('p');
    errorEl.className = 'notification error bindery-studio-regex-error';
    errorEl.hidden = true;

    const jsonHint = document.createElement('p');
    jsonHint.className = 'hint bindery-studio-regex-json-hint';
    jsonHint.hidden = true;
    const jsonHintText = document.createElement('span');
    jsonHintText.textContent = game.i18n!.localize('BINDERY.studio.regexJsonHint' as never);
    const fixBtn = document.createElement('button');
    fixBtn.type = 'button';
    fixBtn.className = 'bindery-btn bindery-btn--secondary';
    fixBtn.textContent = game.i18n!.localize('BINDERY.studio.regexJsonFixButton' as never);
    jsonHint.append(jsonHintText, fixBtn);

    const validate = (): void => {
      const raw = input.value;
      if (!raw) {
        input.classList.remove('bindery-studio-regex-invalid');
        errorEl.hidden = true;
        jsonHint.hidden = true;
        return;
      }
      try {
        new RegExp(raw, opts.multiline ? 'gu' : 'u');
        input.classList.remove('bindery-studio-regex-invalid');
        errorEl.hidden = true;
      } catch (err) {
        input.classList.add('bindery-studio-regex-invalid');
        errorEl.hidden = false;
        errorEl.textContent = err instanceof Error ? err.message : String(err);
      }
      jsonHint.hidden = !/\\\\/.test(raw);
    };
    fixBtn.addEventListener('click', () => {
      input.value = input.value.replace(/\\\\/g, '\\');
      onChange(input.value);
      validate();
    });
    validate();
    input.addEventListener('input', validate);
    input.addEventListener('change', () => onChange(input.value));

    wrap.append(input, errorEl, jsonHint);
    return { el: wrap, input };
  }

  #regexInput(value: string, onChange: (v: string) => void): { el: HTMLElement; input: HTMLInputElement } {
    return this.#buildRegexField(value, onChange, { multiline: false }) as { el: HTMLElement; input: HTMLInputElement };
  }

  #regexTextarea(value: string, onChange: (v: string) => void): { el: HTMLElement; input: HTMLTextAreaElement } {
    return this.#buildRegexField(value, onChange, { multiline: true }) as { el: HTMLElement; input: HTMLTextAreaElement };
  }

  #numberInput(value: number, onChange: (v: number) => void, opts?: { min?: number; max?: number; step?: number }): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'bindery-input bindery-input--narrow';
    input.value = String(value);
    if (opts?.min !== undefined) input.min = String(opts.min);
    if (opts?.max !== undefined) input.max = String(opts.max);
    if (opts?.step !== undefined) input.step = String(opts.step);
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (!Number.isNaN(n)) onChange(n);
    });
    return input;
  }

  #checkboxInput(checked: boolean, onChange: (v: boolean) => void, labelText: string): HTMLElement {
    const wrapper = document.createElement('label');
    wrapper.className = 'bindery-studio-checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'bindery-check';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = labelText;
    wrapper.append(input, span);
    return wrapper;
  }

  #selectInput(value: string, options: { value: string; label: string }[], onChange: (v: string) => void): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'bindery-select';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  // ---- [Correction] Persistent header: metadata and page range ----------------

  /** [Correction] "Page range and metadata don't deserve their own tab — they go into a collapsible header above the tabs." The metadata form is literally reused as-is from before the correction. */
  #mountMetadataHeader(): void {
    const container = this.element.querySelector<HTMLElement>('[data-metadata-header]');
    if (!container || !this.#draft) return;
    container.innerHTML = '';
    container.appendChild(this.#buildMetadataSection());
  }

  /** [user report] The same form as `#mountMetadataHeader` (`#buildMetadataSection` — one source of truth for the fields/validation), mounted in the metadata screen's container instead of the build screen's collapsible header. */
  #mountMetadataScreen(): void {
    const container = this.element.querySelector<HTMLElement>('[data-metadata-screen]');
    if (!container || !this.#draft) return;
    container.innerHTML = '';
    container.appendChild(this.#buildMetadataSection());
  }

  #buildMetadataSection(): HTMLElement {
    const draft = this.#draft!;
    const section = document.createElement('div');

    section.appendChild(this.#formRow('id', this.#textInput(draft.id, (v) => (draft.id = v))));
    section.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldTitle' as never), this.#textInput(draft.title, (v) => (draft.title = v))));
    section.appendChild(this.#formRow('gameLine', this.#textInput(draft.gameLine, (v) => (draft.gameLine = v))));
    section.appendChild(this.#formRow('language', this.#textInput(draft.language, (v) => (draft.language = v))));
    section.appendChild(this.#formRow('publication', this.#textInput(draft.publication, (v) => (draft.publication = v))));
    section.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldAuthor' as never), this.#textInput(draft.author ?? '', (v) => (draft.author = v || undefined))));
    section.appendChild(
      this.#formRow(game.i18n!.localize('BINDERY.studio.fieldMinScore' as never), this.#numberInput(draft.fingerprintMinScore, (v) => (draft.fingerprintMinScore = v), { min: 0, max: 1, step: 0.05 })),
    );

    // [Step 37 Z3, a discovery from step 36] The `provides` checkboxes
    // (Actors/Scenes/Images/Journals) are DELIBERATELY hidden — the field
    // exists in the schema and is still saved to the file
    // (`draftToProfileInput`, `draft.provides` below is DELIBERATELY left
    // untouched: defaults to `['actors']` from `createEmptyProfileDraft`, or
    // the value loaded from the file for existing profiles), but it isn't
    // wired up to ANY import path — `resolve()`/`buildCompatibilityBanner`
    // (§6.8, `@bindery/core`) exist and are tested, but aren't called
    // anywhere in `packages/module`. A checkbox that does nothing teaches
    // the author that the interface lies — they'll uncheck "Scenes", see
    // that scenes get created anyway, and stop trusting the other settings.
    // Restore the form (it used to be here: a span+row of four checkboxes
    // over `draft.provides`) once `resolve()` is actually wired up in the
    // review screen — a separate, larger scope (the incompatibility banner,
    // §6.5, four `reason` variants), do NOT do this as a side effect of
    // this step.

    section.appendChild(
      this.#checkboxInput(
        draft.treatFullBleedAsContent,
        (v) => (draft.treatFullBleedAsContent = v),
        game.i18n!.localize('BINDERY.studio.fieldTreatFullBleedAsContent' as never),
      ),
    );
    const treatFullBleedHint = document.createElement('p');
    treatFullBleedHint.className = 'hint';
    treatFullBleedHint.textContent = game.i18n!.localize('BINDERY.studio.fieldTreatFullBleedAsContentHint' as never);
    section.appendChild(treatFullBleedHint);

    section.appendChild(
      this.#checkboxInput(
        draft.autoCropUniformMargins,
        (v) => (draft.autoCropUniformMargins = v),
        game.i18n!.localize('BINDERY.studio.fieldAutoCropUniformMargins' as never),
      ),
    );
    const autoCropHint = document.createElement('p');
    autoCropHint.className = 'hint';
    autoCropHint.textContent = game.i18n!.localize('BINDERY.studio.fieldAutoCropUniformMarginsHint' as never);
    section.appendChild(autoCropHint);

    section.appendChild(
      this.#checkboxInput(
        draft.brightenAutoCroppedImages,
        (v) => (draft.brightenAutoCroppedImages = v),
        game.i18n!.localize('BINDERY.studio.fieldBrightenAutoCroppedImages' as never),
      ),
    );
    const brightenHint = document.createElement('p');
    brightenHint.className = 'hint';
    brightenHint.textContent = game.i18n!.localize('BINDERY.studio.fieldBrightenAutoCroppedImagesHint' as never);
    section.appendChild(brightenHint);

    section.appendChild(
      this.#checkboxInput(
        draft.removeTokenBackgroundDefault,
        (v) => (draft.removeTokenBackgroundDefault = v),
        game.i18n!.localize('BINDERY.studio.fieldRemoveTokenBackgroundDefault' as never),
      ),
    );
    const removeTokenBgHint = document.createElement('p');
    removeTokenBgHint.className = 'hint';
    removeTokenBgHint.textContent = game.i18n!.localize('BINDERY.studio.fieldRemoveTokenBackgroundDefaultHint' as never);
    section.appendChild(removeTokenBgHint);

    const rangesWrap = document.createElement('div');
    rangesWrap.className = 'bindery-studio-page-ranges';
    const rangesLabel = document.createElement('span');
    rangesLabel.textContent = game.i18n!.localize('BINDERY.studio.fieldPageRanges' as never);
    rangesWrap.appendChild(rangesLabel);
    draft.pageRanges.forEach((range, i) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-page-range-row';
      // [Step 28 Z5, "Never -1 in the interface"] Internally `-1` means "to
      // the end of the document" — in the form that's simply an EMPTY "to"
      // field.
      const fromInput = this.#numberInput(range[0], (v) => (draft.pageRanges[i]![0] = Math.max(1, Math.trunc(v))), { min: 1 });
      row.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.pageRangeFrom' as never), fromInput));
      const toInput = document.createElement('input');
      toInput.type = 'number';
      toInput.className = 'bindery-input bindery-input--narrow';
      toInput.min = '1';
      toInput.placeholder = game.i18n!.localize('BINDERY.studio.pageRangeToLast' as never);
      toInput.value = range[1] === -1 ? '' : String(range[1]);
      toInput.addEventListener('change', () => {
        const trimmed = toInput.value.trim();
        draft.pageRanges[i]![1] = trimmed === '' ? -1 : Math.max(1, Math.trunc(Number(trimmed)));
      });
      row.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.pageRangeTo' as never), toInput));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bindery-btn bindery-btn--icon';
      del.textContent = '×';
      del.addEventListener('click', () => {
        draft.pageRanges.splice(i, 1);
        void this.render();
      });
      row.appendChild(del);
      rangesWrap.appendChild(row);
    });
    const addRange = document.createElement('button');
    addRange.type = 'button';
    addRange.className = 'bindery-btn bindery-btn--secondary';
    addRange.textContent = game.i18n!.localize('BINDERY.studio.addPageRangeButton' as never);
    addRange.addEventListener('click', () => {
      draft.pageRanges.push([1, -1]);
      void this.render();
    });
    rangesWrap.appendChild(addRange);
    section.appendChild(rangesWrap);

    return section;
  }

  #buildLabelledPairsForm(p: Extract<PatternDraft, { kind: 'labelledPairs' }>, patternId: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';

    wrap.appendChild(this.#formRow('valuePattern', this.#regexInput(p.valuePattern, (v) => (p.valuePattern = v)).el));
    wrap.appendChild(this.#formRow('minPairs', this.#numberInput(p.minPairs, (v) => (p.minPairs = Math.max(1, Math.trunc(v))), { min: 1 })));
    wrap.appendChild(this.#formRow('maxPairs', this.#numberInput(p.maxPairs ?? 12, (v) => (p.maxPairs = Math.trunc(v)), { min: 1 })));
    wrap.appendChild(this.#checkboxInput(p.onRepeatedLabel, (v) => (p.onRepeatedLabel = v), game.i18n!.localize('BINDERY.studio.fieldOnRepeatedLabel' as never)));
    wrap.appendChild(this.#checkboxInput(p.allowTrailingWords, (v) => (p.allowTrailingWords = v), game.i18n!.localize('BINDERY.studio.fieldAllowTrailingWords' as never)));
    wrap.appendChild(this.#formRow('trailingWordsStopBefore', this.#regexInput(p.trailingWordsStopBefore ?? '', (v) => (p.trailingWordsStopBefore = v || undefined)).el));
    // [Step 37 Z2] `trailingWordsStopBefore` is typed in by hand (no click
    // on the PDF, so no known "calibration page"), but it's STILL a literal
    // token taken from the material — the same check as
    // `sectionHeader`/`terminateSectionBefore` applies here identically,
    // because `#checkLiteralGenericity` counts MATCHES across the WHOLE
    // document, and doesn't need to know which page was the source.
    if (p.trailingWordsStopBefore) {
      const trailingWarn = document.createElement('p');
      trailingWarn.className = 'notification error';
      trailingWarn.hidden = true;
      wrap.appendChild(trailingWarn);
      void this.#checkLiteralGenericity(`trailingWordsStopBefore:${patternId}`, p.trailingWordsStopBefore, trailingWarn, 'BINDERY.studio.buildValueTooSpecific', () => p.trailingWordsStopBefore);
    }

    const labelsWrap = document.createElement('div');
    labelsWrap.className = 'bindery-studio-labels-list';
    const labelsHeader = document.createElement('span');
    labelsHeader.textContent = game.i18n!.localize('BINDERY.studio.fieldLabels' as never);
    labelsWrap.appendChild(labelsHeader);
    p.labels.forEach((entry, i) => labelsWrap.appendChild(this.#buildLabelRow(p, entry, i)));
    const addLabelBtn = document.createElement('button');
    addLabelBtn.type = 'button';
    addLabelBtn.className = 'bindery-btn bindery-btn--secondary';
    addLabelBtn.textContent = game.i18n!.localize('BINDERY.studio.addLabelButton' as never);
    addLabelBtn.addEventListener('click', () => {
      p.labels.push({ label: '', canonicalKey: '' });
      void this.render();
    });
    labelsWrap.appendChild(addLabelBtn);
    wrap.appendChild(labelsWrap);

    return wrap;
  }

  #buildLabelRow(p: Extract<PatternDraft, { kind: 'labelledPairs' }>, entry: LabelEntryDraft, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-studio-label-row';

    const labelInput = this.#textInput(entry.label, (v) => {
      entry.label = v;
    });
    labelInput.placeholder = game.i18n!.localize('BINDERY.studio.labelPlaceholder' as never);
    row.appendChild(labelInput);

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    pickBtn.textContent = '📍';
    pickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickLabelHint' as never),
        // [user report, "the field gets added but without a name... the
        // armor field is empty"] This pin (the "Advanced" form) used to set
        // ONLY `entry.label`, NEVER `entry.canonicalKey` — unlike the
        // default build mode (`#onBuildTokenClick` -> `#addOrUpdateGridPair`),
        // which suggests a key right away. The author saw a correctly
        // filled-in label ("Armor:"), but an EMPTY canonical key — without a
        // key the engine never writes a value into any field on the sheet,
        // so armor stayed empty despite the label being added correctly.
        // The same suggestion mechanism as there, ONLY when the key is still
        // empty (doesn't overwrite the author's manual choice).
        apply: (text) => {
          entry.label = text;
          labelInput.value = text;
          if (!entry.canonicalKey) {
            void this.#suggestCanonicalKey(text).then((key) => {
              if (key && !entry.canonicalKey) {
                entry.canonicalKey = key;
                keyInput.value = key;
              }
            });
          }
        },
      };
      void this.render();
    });
    row.appendChild(pickBtn);

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'bindery-input';
    keyInput.value = entry.canonicalKey;
    keyInput.setAttribute('list', 'bindery-canonical-keys');
    keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
    keyInput.addEventListener('change', () => {
      entry.canonicalKey = keyInput.value;
    });
    row.appendChild(keyInput);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'bindery-btn bindery-btn--icon';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
      p.labels.splice(index, 1);
      void this.render();
    });
    row.appendChild(delBtn);

    return row;
  }

  #buildSectionListForm(p: Extract<PatternDraft, { kind: 'sectionList' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';

    const headerRow = document.createElement('div');
    headerRow.className = 'bindery-studio-label-row';
    const headerField = this.#regexInput(p.sectionHeader, (v) => (p.sectionHeader = v));
    headerRow.appendChild(this.#formRow('sectionHeader', headerField.el));
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    pickBtn.textContent = '📍';
    pickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickSectionHeaderHint' as never),
        apply: (text) => {
          const escaped = escapeSectionBoundaryLiteral(text);
          p.sectionHeader = escaped;
          headerField.input.value = escaped;
        },
      };
      void this.render();
    });
    headerRow.appendChild(pickBtn);
    wrap.appendChild(headerRow);

    wrap.appendChild(this.#formRow('itemPattern', this.#buildItemPatternField(p)));
    wrap.appendChild(this.#checkboxInput(p.rejoinHyphenated, (v) => (p.rejoinHyphenated = v), game.i18n!.localize('BINDERY.studio.fieldRejoinHyphenated' as never)));
    wrap.appendChild(this.#formRow('skipAfterHeader', this.#regexInput(p.skipAfterHeader ?? '', (v) => (p.skipAfterHeader = v || undefined)).el));
    wrap.appendChild(this.#formRow('terminateSectionBefore', this.#regexInput(p.terminateSectionBefore ?? '', (v) => (p.terminateSectionBefore = v || undefined)).el));

    const rangedRow = document.createElement('div');
    rangedRow.className = 'bindery-studio-label-row';
    rangedRow.appendChild(
      this.#formRow(
        'rangedKeywords',
        this.#textInput(p.rangedKeywords.join(','), (v) => (p.rangedKeywords = v.split(',').map((s) => s.trim()).filter(Boolean))),
      ),
    );
    const rangedPickBtn = document.createElement('button');
    rangedPickBtn.type = 'button';
    rangedPickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    rangedPickBtn.textContent = '📍';
    rangedPickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    rangedPickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickRangedExampleHint' as never),
        apply: (text) => {
          const keyword = this.#extractRangedKeyword(p, text);
          if (!keyword) {
            ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.rangedKeywordEmpty' as never));
            return;
          }
          if (!p.rangedKeywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) p.rangedKeywords = [...p.rangedKeywords, keyword];
        },
      };
      void this.render();
    });
    rangedRow.appendChild(rangedPickBtn);
    wrap.appendChild(rangedRow);

    return wrap;
  }

  /**
   * [Step 40 Z2, at the user's request after fixing "pistol matches as
   * melee"] Clicking a ranged-weapon example (📍 next to `rangedKeywords`)
   * -> a keyword to save in the profile, instead of typing it by hand.
   * `text` is the WHOLE clicked token (`PickTarget.apply` only gets text,
   * no `collectRowText`/token index — the same limitation as the other 📍
   * buttons in this file, see `pickSectionHeaderHint` above) — in this book
   * (and usually in layouts of this kind, see the comment on
   * `PICKABLE_MAX_LENGTH`/`isAttacksOrSkillsTab` in `#mountPickableTokens`)
   * that's the WHOLE attack item in one pdf.js token anyway. If
   * `itemPattern` already recognizes something, it extracts JUST the `name`
   * group from it (exactly the way a real import would) instead of the
   * whole row with the percentage and damage; then it strips a
   * parenthesized caliber/subtype suffix ("Firearm (.22 pistol)" ->
   * "Firearm"), so the keyword matches EVERY weapon of that category, not
   * just the clicked example.
   */
  #extractRangedKeyword(pattern: Extract<PatternDraft, { kind: 'sectionList' }>, text: string): string {
    let keyword = text.trim();
    if (pattern.itemPattern) {
      try {
        const m = new RegExp(pattern.itemPattern, 'u').exec(keyword);
        if (m?.groups?.['name']) keyword = m.groups['name'];
      } catch {
        // itemPattern is not yet valid (mid-edit) -- use the whole click as-is, below.
      }
    }
    return keyword
      .replace(/\([^()]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** [Step 29 Z2] `itemPattern` with a live preview of the match count in the section on the CURRENTLY VIEWED page — the only field the author has to be able to read on their own (Z1), so it gets the most immediate feedback. */
  #buildItemPatternField(p: Extract<PatternDraft, { kind: 'sectionList' }>): HTMLElement {
    const field = this.#regexTextarea(p.itemPattern, (v) => (p.itemPattern = v));
    const countEl = document.createElement('p');
    countEl.className = 'hint bindery-studio-itempattern-count';
    field.el.appendChild(countEl);
    const recount = (): void => void this.#updateItemPatternMatchCount(field.input.value, p, countEl);
    recount();
    field.input.addEventListener('input', recount);
    return field.el;
  }

  /** Counts matches of `candidateItemPattern` (the VALUE FROM THE FIELD, not yet saved to the draft) within section `p` on the currently viewed page — `matchSectionList` from `@bindery/core`, the same function the real scan uses, so the count is REAL, not approximate. */
  async #updateItemPatternMatchCount(candidateItemPattern: string, p: Extract<PatternDraft, { kind: 'sectionList' }>, countEl: HTMLElement): Promise<void> {
    if (!candidateItemPattern || !p.sectionHeader) {
      countEl.textContent = '';
      return;
    }
    try {
      new RegExp(candidateItemPattern, 'gu');
    } catch {
      countEl.textContent = '';
      return;
    }
    const tokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const { matchSectionList } = await import('@bindery/core');
    try {
      const tempPattern = {
        kind: 'sectionList' as const,
        sectionHeader: p.sectionHeader,
        itemPattern: candidateItemPattern,
        rejoinHyphenated: p.rejoinHyphenated,
        skipAfterHeader: p.skipAfterHeader,
        terminateSectionBefore: p.terminateSectionBefore,
        rangedKeywords: p.rangedKeywords,
      };
      const matches = matchSectionList(tokens, tempPattern);
      const count = matches.reduce((sum, m) => sum + m.items.length, 0);
      countEl.textContent = `${game.i18n!.localize('BINDERY.studio.itemPatternMatchCount' as never)}: ${count}`;
    } catch {
      countEl.textContent = '';
    }
  }

  #buildFontRoleCandidateForm(p: Extract<PatternDraft, { kind: 'fontRoleCandidate' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';
    wrap.appendChild(
      this.#formRow(
        'excludeRoles',
        this.#textInput(p.excludeRoles.join(','), (v) => (p.excludeRoles = v.split(',').map((s) => s.trim()).filter(Boolean))),
      ),
    );
    wrap.appendChild(this.#formRow('maxLength', this.#numberInput(p.maxLength, (v) => (p.maxLength = Math.max(1, Math.trunc(v))), { min: 1 })));
    wrap.appendChild(this.#checkboxInput(p.excludeRepeatedAcrossPages, (v) => (p.excludeRepeatedAcrossPages = v), game.i18n!.localize('BINDERY.studio.fieldExcludeRepeated' as never)));
    wrap.appendChild(this.#checkboxInput(p.excludeHyphenContinuations, (v) => (p.excludeHyphenContinuations = v), game.i18n!.localize('BINDERY.studio.fieldExcludeHyphen' as never)));
    wrap.appendChild(this.#buildRequireFontKeysList(p));
    return wrap;
  }

  /** [Step 29 Z3] The list of font keys learned by clicking (the "Name" tab) — editable and removable, like any other "Advanced" field. Empty = no entries, no change to the field's description (DoD: "optional field"). */
  #buildRequireFontKeysList(p: Extract<PatternDraft, { kind: 'fontRoleCandidate' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section';
    const label = document.createElement('p');
    label.className = 'hint';
    label.textContent = 'requireFontKeys';
    section.appendChild(label);
    p.requireFontKeys.forEach((key, index) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-build-pair-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input bindery-studio-regex-input';
      keyInput.value = key;
      keyInput.addEventListener('change', () => (p.requireFontKeys[index] = keyInput.value));
      row.appendChild(keyInput);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        p.requireFontKeys = p.requireFontKeys.filter((_, i) => i !== index);
        this.#refreshBuildPanel();
      });
      row.appendChild(delBtn);
      section.appendChild(row);
    });
    return section;
  }

  #renderMeasurementResult(box: HTMLElement, rule: AttachRuleDraft): void {
    box.innerHTML = '';
    const state = this.#measurements.get(rule);
    if (!state) return;
    if (state.state === 'measuring') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.measuring' as never);
      box.appendChild(p);
      return;
    }
    if (state.state === 'error') {
      const p = document.createElement('p');
      p.className = 'notification error';
      p.textContent = state.message;
      box.appendChild(p);
      return;
    }
    const r = state.result;
    if (r.measuredPairCount === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = `${game.i18n!.localize('BINDERY.studio.measureNoData' as never)} (${r.pagesWithBoth} ${game.i18n!.localize('BINDERY.studio.pages' as never)})`;
      box.appendChild(p);
      return;
    }
    const summary = document.createElement('p');
    summary.className = 'bindery-studio-measure-summary';
    summary.textContent = `${r.pagesWithBoth} ${game.i18n!.localize('BINDERY.studio.pages' as never)} · ${r.measuredPairCount} par · ${game.i18n!.localize('BINDERY.studio.measureBelow' as never)} ${r.belowCount} / ${game.i18n!.localize('BINDERY.studio.measureAbove' as never)} ${r.aboveCount} / ${game.i18n!.localize('BINDERY.studio.measureBeside' as never)} ${r.besideCount}`;
    box.appendChild(summary);

    const min = r.distances[0]!;
    const max = r.distances.at(-1)!;
    const median = r.distances[Math.floor(r.distances.length / 2)]!;
    const distText = document.createElement('p');
    distText.className = 'hint';
    distText.textContent = `${game.i18n!.localize('BINDERY.studio.measureDistances' as never)}: min ${min.toFixed(0)}pt · median ${median.toFixed(0)}pt · max ${max.toFixed(0)}pt`;
    box.appendChild(distText);

    const suggestion = document.createElement('p');
    suggestion.textContent = `${game.i18n!.localize('BINDERY.studio.measureSuggestion' as never)}: ${r.suggestedStrategy}, maxDistancePt ≈ ${r.suggestedMaxDistancePt}`;
    box.appendChild(suggestion);

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'bindery-btn bindery-btn--ghost';
    applyBtn.textContent = game.i18n!.localize('BINDERY.studio.measureApplyButton' as never);
    applyBtn.addEventListener('click', () => {
      rule.strategy = r.suggestedStrategy;
      if (r.suggestedMaxDistancePt !== null) rule.maxDistancePt = r.suggestedMaxDistancePt;
      void this.render();
    });
    box.appendChild(applyBtn);
  }

  #buildMeasureSection(draft: ProfileDraft, rule: AttachRuleDraft): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-measure-section';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bindery-btn bindery-btn--secondary';
    btn.textContent = game.i18n!.localize('BINDERY.studio.measureButton' as never);
    const resultBox = document.createElement('div');
    resultBox.className = 'bindery-studio-measure-result';

    btn.addEventListener('click', () => void this.#runMeasurement(draft, rule, resultBox));
    section.append(btn, resultBox);
    this.#renderMeasurementResult(resultBox, rule);
    return section;
  }

  async #runMeasurement(draft: ProfileDraft, rule: AttachRuleDraft, resultBox: HTMLElement): Promise<void> {
    if (!this.#pdfBuffer) return;
    this.#measurements.set(rule, { state: 'measuring' });
    this.#renderMeasurementResult(resultBox, rule);

    try {
      const input = draftToProfileInput(draft);
      const validated = await validateActorProfileFile(input);
      if (!validated.ok) {
        this.#measurements.set(rule, { state: 'error', message: validated.issues.join('; ') });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      const anchorPattern = validated.profile.patterns[draft.anchor];
      const candidatePattern = validated.profile.patterns[rule.pattern];
      if (anchorPattern?.kind !== 'labelledPairs') {
        this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureBadPatterns' as never) });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      if (candidatePattern?.kind !== 'labelledPairs' && candidatePattern?.kind !== 'sectionList' && candidatePattern?.kind !== 'fontRoleCandidate') {
        this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureBadPatterns' as never) });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      const { measureAttachGeometryForDocument } = await import('@bindery/core');
      const result = await measureAttachGeometryForDocument(this.#pdfBuffer, anchorPattern, candidatePattern, { assetBaseUrl: ASSET_BASE_URL });
      this.#measurements.set(rule, { state: 'done', result });
    } catch (err) {
      console.warn('Bindery | Profile Studio: geometry measurement failed:', err);
      this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureFailed' as never) });
    }
    this.#renderMeasurementResult(resultBox, rule);
  }

  // ---- [Step 23 Z6] Anchor point: a click on the page fills in a field -----

  /**
   * [Step 23 Z6, Step 28] Two modes for clicking a token on the PDF: (1) an
   * explicit `#pickTarget` (📍 from the advanced form) — the click fills in
   * THAT SPECIFIC field; (2) the default build mode (`#draft` exists, no
   * (1), select-area OFF) — the click is the ONLY way to build the profile,
   * routed by the ACTIVE TAB (`#onBuildTokenClick`).
   */
  async #mountPickableTokens(): Promise<void> {
    const buildModeActive = !this.#pickTarget && this.#draft !== null && !this.#state.isSelectAreaMode && this.#state.buildTab !== 'check';
    if (!this.#pickTarget && !buildModeActive) return;
    if (!this.#pdfBuffer || !this.#previewDocument) return;
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    const { pdfRectToScreen } = await import('@bindery/core');
    const [tokens, box] = await Promise.all([this.#getBuildTokens(this.#state.currentPageNumber), this.#previewDocument.getPageBox(this.#state.currentPageNumber)]);

    // [Problem observed live] Fields to point at are ALWAYS a short, single
    // token — no real pointing target is a whole sentence of prose. The
    // threshold is counted in ACTUAL characters, generous relative to the
    // longest real-world targets.
    //
    // [Bug reproduced live, p. 23 "Wrak.pdf", Calhoun] EXCEPTION: when
    // picking itemPattern examples (the Attacks/Skills tab) a single item
    // can genuinely be ONE token longer than this threshold — "Melee
    // (Brawl) 30% (15/6), damage 1d3+1d4 or" was MEASURED DIRECTLY at 56
    // characters (a one-off Node script replicating
    // `getPageTextTokens`+`mergeTouchingTokens`, the same tokenization as
    // the production `#getBuildTokens`, removed after use); pdf.js did NOT
    // split this line into more tokens. A length threshold would hide SUCH
    // a token completely from the overlay — it wouldn't provide a
    // secondary, shorter fragment to click instead, there simply would be
    // nothing to click for that item (reported live: "I click Melee,
    // nothing happens" — exactly this symptom: no rectangle = the click
    // never reaches ANY listener, so even the warnings in
    // `#addItemPatternExample` stay silent, since they're never triggered).
    //
    // [Fix for the narrowing] The previous version limited this exception to
    // a NARROW "phase 3" (header+boundary already set, on THIS SAME page,
    // with an exact `patternId` match) — four independent conditions on
    // LIVE, mutable state, none of which could be verified live in this
    // session (no access to a running Foundry instance). Each of them, if it
    // happened NOT to hold at the moment of the redraw (not just at the
    // moment the boundary was clicked — these two moments are separated by
    // an asynchronous `await`), would silently restore the length filter and
    // wipe out the only clickable rectangle for the very item that needed to
    // be clicked. The exception now applies to the WHOLE Attacks/Skills tab,
    // regardless of phase — the cost is a few more clickable (longer)
    // candidates already visible while pointing at the header/boundary
    // (phases 1-2), the payoff is no dependency on four conditions racing
    // against an asynchronous redraw.
    const isAttacksOrSkillsTab = this.#state.buildTab === 'attacks' || this.#state.buildTab === 'skills';
    // [Step 34 Z2, the same class of bug as PICKABLE_MAX_LENGTH above —
    // step 32] The start of a note block can be a WHOLE sentence of prose
    // ("Invisibility: the ability stops working..." is one token longer
    // than 40 characters) — a length threshold would hide exactly the
    // tokens the author IS SUPPOSED to click.
    const PICKABLE_MAX_LENGTH = 40;
    // [Bug reproduced live, user report: "More than one possible value...
    // but I don't have any highlighted"] A value candidate for Derived can
    // be a LONG token merged by pdf.js — a number PLUS a description in one
    // ("5, unusually thick skin. Remember that damage..." — exactly the
    // shape Step 34 Z1 was supposed to handle) — longer than
    // `PICKABLE_MAX_LENGTH`. Without the exception, this token used to be
    // completely removed from the overlay (zero rectangle to click), even
    // though the `#pendingValueChoice` message said outright "click the
    // highlighted one" — there was nothing to highlight. The same bug
    // already fixed for the itemPattern-examples phase and the Notes tab
    // (`isAttacksOrSkillsTab`/`buildTab === 'notes'` below) — now the
    // exception ALSO covers the duration of choosing an ambiguous value,
    // regardless of the active tab.
    const lengthFilterExempt = isAttacksOrSkillsTab || this.#state.buildTab === 'notes' || !!this.#pendingValueChoice;
    const pickableTokens = lengthFilterExempt ? tokens : tokens.filter((t) => t.text.length <= PICKABLE_MAX_LENGTH);
    const pendingCandidateIndices = new Set(this.#pendingValueChoice?.candidates.map((c) => c.tokenIndex) ?? []);

    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      for (const tok of pickableTokens) {
        const screen = pdfRectToScreen(tok.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const classes = ['bindery-studio-pickable-token'];
        if (pendingCandidateIndices.has(tok.tokenIndex)) classes.push('bindery-studio-pickable-candidate');
        rect.setAttribute('class', classes.join(' '));
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = tok.text;
        rect.appendChild(title);
        rect.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.#pickTarget) {
            this.#pickTarget.apply(tok.text);
            this.#pickTarget = null;
            void this.render();
            return;
          }
          void this.#onBuildTokenClick(tok, tokens);
        });
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  /**
   * [Step 28 Z3, unchanged from the previous version] The active section's
   * extent as an area on the PDF, with a draggable lower edge. Draws ONLY
   * when the page being viewed is the page where the header was clicked.
   */
  async #mountSectionBoundaryOverlay(): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img || !this.#draft || !this.#previewDocument) return;
    const existing = svg.querySelector('[data-section-boundary]');
    if (existing) existing.remove();
    const focus = this.#sectionBoundaryFocus;
    if (!focus || focus.page !== this.#state.currentPageNumber) return;
    const entry = this.#draft.patterns.find((e) => e.id === focus.patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return;
    const pattern = entry.pattern;

    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const headerToken = allTokens.find((t) => t.tokenIndex === focus.headerTokenIndex);
    if (!headerToken) return;

    const { pdfRectToScreen, screenRectToPdf, matchSectionList, findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const unionRect = (a: Rect, b: Rect): Rect => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) });
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    // [Bug reproduced live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] The section's
    // area, drawn at the FULL page width (`box.box.minX`/`maxX`), used to
    // span BOTH columns at once on a two-column page (O5 from step 29,
    // confirmed to affect EVERY two-column page, not only "two characters
    // side by side") — narrowed to the header's column.
    const columnBand = findColumnBand(allTokens, headerToken.bbox);
    const extentMinX = columnBand?.minX ?? box.box.minX;
    const extentMaxX = columnBand?.maxX ?? box.box.maxX;

    const gridRegionsOnPage: Rect[] =
      this.#docAnalysis?.pages[this.#state.currentPageNumber - 1]?.entities.flatMap((e) => e.regions.filter((r) => r.kind === 'grid').map((r) => r.bbox)) ?? [];

    /**
     * [Step 29 Z1, "instant preview on the PDF"] Which items in the section
     * `itemPattern` caught, and which it didn't — computed by the REAL
     * matching engine (`matchSectionList`, the same function the production
     * scan uses), not our own, potentially drifting copy of the section
     * boundary logic. An empty/invalid `itemPattern` (the author hasn't
     * clicked any example yet, or is editing it by hand under "Advanced")
     * simply draws nothing here — it doesn't interrupt the rest of the
     * overlay.
     */
    let matchedItemRects: Rect[] = [];
    const unmatchedItemRects: Rect[] = [];
    if (pattern.itemPattern) {
      try {
        const matches = matchSectionList(allTokens, pattern);
        const match = matches.find((m) => m.headerTokenIndex === headerToken.tokenIndex);
        if (match) {
          matchedItemRects = match.items.map((it) => it.bbox);
          const covered = new Set<number>();
          for (const it of match.items) for (let idx = it.startTokenIndex; idx <= it.endTokenIndex; idx++) covered.add(idx);
          const tokenByIndex = new Map(allTokens.map((t) => [t.tokenIndex, t] as const));
          let runBbox: Rect | null = null;
          const flushRun = (): void => {
            if (runBbox) unmatchedItemRects.push(runBbox);
            runBbox = null;
          };
          for (let idx = headerToken.tokenIndex + 1; idx < match.endIndex; idx++) {
            const t = tokenByIndex.get(idx);
            if (!t) continue;
            if (covered.has(idx)) {
              flushRun();
              continue;
            }
            runBbox = runBbox ? unionRect(runBbox, t.bbox) : t.bbox;
          }
          flushRun();
        }
      } catch {
        /* itemPattern is invalid (edited by hand) -- no preview, the rest of the overlay draws normally */
      }
    }

    const draw = (): void => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;

      // [Bug reproduced live] `Rect` in this project lives in PDF space (Y
      // INCREASES TOWARD THE TOP of the page — confirmed directly in
      // `directionalDistance`, `entityAssembly.ts`: a "below" candidate has a
      // SMALLER Y than the anchor). The previous version confused this with
      // screen convention (Y increases downward) — the effect, measured on
      // p. 23 "Zew Cthulhu 7ed. Wrak.pdf": the "Combat" section's area
      // rendered ABOVE the header (John Calhoun's trait grid) instead of
      // below it. `extentMinY` is the LOWER PDF boundary (smaller Y = lower
      // on the page) — defaults to the bottom of the page (`box.box.minY`),
      // or the TOP edge of the found boundary token (`found.bbox.maxY`) —
      // `headerToken.bbox.minY` (the header's OWN lower edge, a larger Y
      // than anything below it) is the UPPER boundary of the whole extent.
      let extentMinY = box.box.minY;
      if (pattern.terminateSectionBefore) {
        try {
          const re = new RegExp(pattern.terminateSectionBefore, 'u');
          // [Bug reproduced live] The same column range as the rest of this
          // preview — a token that MATCHES the boundary but lies in the
          // NEIGHBORING column (e.g. an accidental match within prose)
          // shouldn't "drag" the preview outside the header's own column.
          const found = allTokens.find((t) => t.tokenIndex > headerToken.tokenIndex && re.test(t.text) && isWithinColumnBand(t.bbox, columnBand));
          if (found) extentMinY = found.bbox.maxY;
        } catch {
          /* regex is invalid (edited by hand under "Advanced") -- draw to the end of the page, don't interrupt */
        }
      }

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-section-boundary', '1');

      const drawExtent = (candidateMinY: number, overlapping: boolean): { rect: SVGRectElement; handle: SVGLineElement } => {
        const pdfRect: Rect = { minX: extentMinX, maxX: extentMaxX, minY: candidateMinY, maxY: headerToken.bbox.minY };
        const screen = pdfRectToScreen(pdfRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        rect.setAttribute('class', `bindery-studio-section-extent${overlapping ? ' bindery-studio-section-extent-overlap' : ''}`);
        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        handle.setAttribute('x1', String(screen.minX));
        handle.setAttribute('x2', String(screen.maxX));
        handle.setAttribute('y1', String(screen.maxY));
        handle.setAttribute('y2', String(screen.maxY));
        handle.setAttribute('class', `bindery-studio-section-handle${overlapping ? ' bindery-studio-section-handle-overlap' : ''}`);
        return { rect, handle };
      };

      const { rect, handle } = drawExtent(extentMinY, false);
      g.append(rect, handle);

      const drawItemRect = (pdfRect: Rect, cssClass: string): void => {
        const screen = pdfRectToScreen(pdfRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const itemRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        itemRect.setAttribute('x', String(screen.minX));
        itemRect.setAttribute('y', String(screen.minY));
        itemRect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        itemRect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        itemRect.setAttribute('class', cssClass);
        g.appendChild(itemRect);
      };
      for (const r of matchedItemRects) drawItemRect(r, 'bindery-studio-item-matched');
      for (const r of unmatchedItemRects) drawItemRect(r, 'bindery-studio-item-unmatched');

      svg.appendChild(g);

      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        this.#boundaryDrag = {
          patternId: entry!.id,
          headerTokenIndex: headerToken.tokenIndex,
          startPdfY: extentMinY,
          pageWidthPx: width,
          pageHeightPx: height,
          overlapCheckBboxes: gridRegionsOnPage,
        };
        this.#mountBuildPanel();

        // [Bug reproduced live, the same cause as above] Dragging DOWN on
        // screen must PRODUCE A SMALLER Y in PDF space (Y increases toward
        // the top of the page) — the lower drag boundary is `box.box.minY`
        // (the very bottom of the page), the upper one is
        // `headerToken.bbox.minY` (the header's own lower edge — you can't
        // drag the boundary ABOVE the header).
        const onMove = (ev: PointerEvent): void => {
          const overlayPt = this.#svgToOverlayPoint(svg, ev.clientX, ev.clientY);
          const pdfPt = screenRectToPdf({ minX: overlayPt.x, maxX: overlayPt.x + 1, minY: overlayPt.y, maxY: overlayPt.y + 1 }, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const candidateY = Math.min(headerToken.bbox.minY, Math.max(pdfPt.minY, box.box.minY));
          const candidateRect: Rect = { minX: extentMinX, maxX: extentMaxX, minY: candidateY, maxY: headerToken.bbox.minY };
          const overlapping = gridRegionsOnPage.some((r) => ProfileStudio.#rectsOverlap(r, candidateRect));
          g.innerHTML = '';
          const redrawn = drawExtent(candidateY, overlapping);
          g.append(redrawn.rect, redrawn.handle);
        };
        // [Fix for a reported bug — a review of the whole design] `cleanup`
        // removes ALL THREE listeners (not just the ones "expected" for a
        // given path) — without this, an interrupted gesture
        // (`pointercancel` instead of `pointerup`) used to leave
        // `onMove`/`onUp` on `svg` FOREVER (the same `svg` survives multiple
        // overlay mounts), where they could later "fire" from a completely
        // unrelated event on the same element (e.g. finishing a different
        // drag) and silently move this section boundary.
        const cleanup = (): void => {
          svg.removeEventListener('pointermove', onMove);
          svg.removeEventListener('pointerup', onUp);
          svg.removeEventListener('pointercancel', onCancel);
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        const onUp = (ev: PointerEvent): void => {
          cleanup();
          const overlayPt = this.#svgToOverlayPoint(svg, ev.clientX, ev.clientY);
          const pdfPt = screenRectToPdf({ minX: overlayPt.x, maxX: overlayPt.x + 1, minY: overlayPt.y, maxY: overlayPt.y + 1 }, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const finalY = Math.min(headerToken.bbox.minY, Math.max(pdfPt.minY, box.box.minY));
          void this.#commitSectionBoundary(entry!, headerToken.tokenIndex, finalY);
        };
        const onCancel = (): void => {
          cleanup();
          this.#boundaryDrag = null;
          g.innerHTML = '';
          const restored = drawExtent(extentMinY, false);
          g.append(restored.rect, restored.handle);
          this.#mountBuildPanel();
        };
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
        svg.addEventListener('pointercancel', onCancel);
      });
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  /**
   * [Step 28 Z3] End of drag -> the token GEOMETRICALLY closest to the
   * released edge becomes `terminateSectionBefore`. No token below removes
   * the boundary -- the section reads to the end of the stream, a valid
   * answer, not a bug.
   *
   * [Bug reproduced live, p. 23 "Zew Cthulhu 7ed. Wrak.pdf"] "Geometrically
   * closest by Y" without knowing the columns on a two-column page often
   * means a PROSE token FROM THE NEIGHBORING COLUMN (same height, completely
   * different content) instead of the real header ending the section in ITS
   * OWN column — reported directly as a bug, not an edge case (O5 from step
   * 29 confirmed to affect EVERY two-column page). The search is narrowed to
   * the section header's `findColumnBand` — on a single-column page the band
   * covers all the content, zero change in behavior.
   */
  async #commitSectionBoundary(entry: PatternEntryDraft, headerTokenIndex: number, finalPdfY: number): Promise<void> {
    this.#boundaryDrag = null;
    if (entry.pattern.kind !== 'sectionList') return;
    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const { findTerminateTokenAtY, findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const headerToken = allTokens.find((t) => t.tokenIndex === headerTokenIndex);
    const band = headerToken ? findColumnBand(allTokens, headerToken.bbox) : null;
    const candidateTokens = band ? allTokens.filter((t) => isWithinColumnBand(t.bbox, band)) : allTokens;
    const found = findTerminateTokenAtY(candidateTokens, headerTokenIndex, finalPdfY);
    entry.pattern.terminateSectionBefore = found ? escapeSectionBoundaryLiteral(found.text) : undefined;
    this.#refreshBuildPanel();
  }

  // ---- [Step 24 Z1] Pattern inference from a mouse selection (Traits/Derived) ---

  /**
   * [Bug reproduced live, "I select an area, but I land much lower than the
   * statblock", made worse after a first (reverted) attempted fix via CSS]
   * `svg.getBoundingClientRect()` reflects the ACTUAL, RENDERED CSS size of
   * the `<svg>` element — which doesn't necessarily match the size of the
   * actually displayed page image (`.bindery-page-image`), because
   * `.bindery-page-overlay { width:100%; height:100% }` is computed relative
   * to `.bindery-page-canvas-wrap` (a `flex:1; overflow:auto` container —
   * its own size is the available space in the panel, NOT the image height
   * for a tall, scrollable PDF page). The rest of the code
   * (`#mountOverlay`/`#mountPickableTokens`) fixes this by OVERWRITING
   * `svg.style.width/height` with `img.clientWidth/clientHeight` BEFORE
   * drawing — but ONLY when it actually runs (e.g. `#mountPickableTokens`
   * explicitly draws NOTHING when `isSelectAreaMode` is on, which is
   * EXACTLY when the user is trying to use "Select area"). Fix: FORCE the
   * SAME override HERE, on EVERY point calculation — regardless of whether
   * any other drawing function has already done it. Safe (`img.clientWidth`
   * is always valid, independent of the parent's scroll position) and cheap
   * (assigning the same style value that's already there doesn't force an
   * extra layout pass beyond what will happen anyway when reading
   * `getBoundingClientRect()` below).
   *
   * [A second, deeper bug reproduced live] For the SAME reason
   * (`#mountPickableTokens` explicitly draws NOTHING in `isSelectAreaMode`),
   * `viewBox` could ALSO NEVER get set on a fresh `<svg>` element (after a
   * full render, which recreates it from scratch, with no attributes) —
   * `vb.width/height` would then be `0`, and `scaleX/scaleY` below silently
   * falls back to `1` instead of the real scale (~4-5x between CSS pixels
   * and native PDF pixels), causing ALMOST EVERY drag to map into a tight
   * area near the top-left corner of the page in PDF space — worse than a
   * regular offset, because this is a SCALE bug, not just an offset one.
   * Also set here, from the same, always-reliable
   * `img.naturalWidth/naturalHeight`.
   */
  #svgToOverlayPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
    }
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0 && (svg.viewBox.baseVal.width === 0 || svg.viewBox.baseVal.height === 0)) {
      svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    }
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const scaleX = rect.width > 0 && vb.width > 0 ? vb.width / rect.width : 1;
    const scaleY = rect.height > 0 && vb.height > 0 ? vb.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  #wireAreaSelectDrag(svg: SVGSVGElement): void {
    if (svg.dataset['areaSelectWired']) return;
    svg.dataset['areaSelectWired'] = '1';

    const toOverlayPoint = (clientX: number, clientY: number): { x: number; y: number } => this.#svgToOverlayPoint(svg, clientX, clientY);

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.#state.isSelectAreaMode || e.button !== 0) return;
      e.preventDefault();
      const start = toOverlayPoint(e.clientX, e.clientY);
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
      const cur = toOverlayPoint(e.clientX, e.clientY);
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });

    const MIN_DRAG_PX = 8;
    const finishDrag = (e: PointerEvent): void => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      this.#dragState = null;
      rectEl.remove();
      const cur = toOverlayPoint(e.clientX, e.clientY);
      const screenRect: Rect = {
        minX: Math.min(startScreen.x, cur.x),
        maxX: Math.max(startScreen.x, cur.x),
        minY: Math.min(startScreen.y, cur.y),
        maxY: Math.max(startScreen.y, cur.y),
      };
      if (screenRect.maxX - screenRect.minX < MIN_DRAG_PX || screenRect.maxY - screenRect.minY < MIN_DRAG_PX) return;
      void this.#onAreaSelected(screenRect);
    };
    svg.addEventListener('pointerup', finishDrag);
    // [Fix for a reported bug — a review of the whole design] This was
    // missing what `#wireSelectDrag` in ReviewScreen.ts has explicitly
    // (with a comment): an interrupted gesture (`pointercancel`, e.g. from a
    // system gesture) never triggered `finishDrag`, so `#dragState` and the
    // temporary `<rect>` were left orphaned in the DOM forever (the next
    // `pointerdown` would overwrite `#dragState` without removing the old
    // element).
    svg.addEventListener('pointercancel', finishDrag);
  }

  /**
   * [Correction] "Drawing an area works the same way, just in bulk" — ONLY
   * on the Traits/Derived tabs (sections are built geometrically, Z3, not
   * by bulk selection — see `canSelectArea` in `_prepareContext`). A
   * selection with no detected pair simply produces no proposal — sections
   * are NO LONGER guessed from "0 pairs" the way they were in the previous
   * version.
   */
  async #onAreaSelected(screenRect: Rect): Promise<void> {
    if (!this.#pdfBuffer || !this.#previewDocument) return;
    const slot = this.#state.buildTab;
    if (slot !== 'grid' && slot !== 'derived') return;
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    const width = img?.naturalWidth || img?.clientWidth || 0;
    const height = img?.naturalHeight || img?.clientHeight || 0;
    if (!width || !height) return;

    const { screenRectToPdf, inferLabelledPairsFromTokens } = await import('@bindery/core');
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    const pdfRect = screenRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });

    // [The same fix as #getBuildTokens] merged, "whole word" tokens -- bulk area selection shouldn't suffer from the same splitting as a single click.
    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const selected = allTokens.filter((t) => {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      return cx >= pdfRect.minX && cx <= pdfRect.maxX && cy >= pdfRect.minY && cy <= pdfRect.maxY;
    });

    const pairs = inferLabelledPairsFromTokens(selected);
    // [Gap reproduced live and reported] `pairs.length === 0` used to set
    // `null` -- the panel would simply clear without a trace, so the author
    // saw ONLY the drag rectangle disappearing, with no information about
    // WHAT went wrong (no tokens in the selection? tokens present, but not
    // in a "label-value" layout?). A proposal is now ALWAYS set (possibly
    // with an EMPTY list of pairs) — `#mountSelectionProposal` shows a
    // readable message instead of silence, along with a raw preview of the
    // selected text, so the author can immediately see whether they hit any
    // content at all.
    // [user report, "Armor" with no key suggestion in the selection panel]
    // The same suggestion as for a single label click (`#addOrUpdateGridPair`)
    // — previously ALWAYS `''`, the author had to type in even well-known
    // fields by hand (e.g. "Armor" -> "armour").
    const suggestedCanonicalKeys = await Promise.all(pairs.map((p) => this.#suggestCanonicalKey(p.label)));
    this.#selectionProposal = {
      slot,
      pairs: pairs.map((p, i) => ({ label: p.label, value: p.value, canonicalKey: suggestedCanonicalKeys[i]!, checked: true, confidence: p.confidence })),
      rawPreview: selected.map((t) => t.text).join(' '),
    };
    await this.render();
  }

  #mountSelectionProposal(): void {
    const container = this.element.querySelector<HTMLElement>('[data-selection-proposal]');
    if (!container) return;
    container.innerHTML = '';
    const proposal = this.#selectionProposal;
    if (!proposal || !this.#draft) return;

    const panel = document.createElement('div');
    panel.className = 'bindery-studio-selection-proposal';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bindery-btn bindery-btn--icon bindery-studio-proposal-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      this.#selectionProposal = null;
      void this.render();
    });

    const h = document.createElement('h4');
    h.textContent = `${game.i18n!.localize('BINDERY.studio.selectionFoundPairs' as never)}: ${proposal.pairs.length}`;
    panel.append(h, closeBtn);

    if (proposal.pairs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = proposal.rawPreview
        ? game.i18n!.localize('BINDERY.studio.selectionNoPairsFound' as never)
        : game.i18n!.localize('BINDERY.studio.selectionEmptyArea' as never);
      panel.appendChild(empty);
    }

    for (const pair of proposal.pairs) {
      const row = document.createElement('div');
      row.className = 'bindery-studio-proposal-pair-row';
      if (pair.confidence === 'low') row.classList.add('bindery-studio-proposal-low-confidence');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'bindery-check';
      cb.checked = pair.checked;
      cb.addEventListener('change', () => (pair.checked = cb.checked));
      row.appendChild(cb);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'bindery-studio-proposal-label';
      labelSpan.textContent = `${pair.label} → ${pair.value}`;
      row.appendChild(labelSpan);
      if (pair.confidence === 'low') {
        const badge = document.createElement('span');
        badge.className = 'bindery-studio-proposal-confidence-badge';
        badge.textContent = '?';
        badge.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.selectionLowConfidenceHint' as never);
        row.appendChild(badge);
      }
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input';
      keyInput.setAttribute('list', 'bindery-canonical-keys');
      keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
      keyInput.value = pair.canonicalKey;
      keyInput.addEventListener('change', () => (pair.canonicalKey = keyInput.value));
      row.appendChild(keyInput);
      panel.appendChild(row);
    }

    if (proposal.pairs.length > 0) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'bindery-btn bindery-btn--ghost';
      applyBtn.textContent = game.i18n!.localize('BINDERY.studio.selectionApplyButton' as never);
      applyBtn.addEventListener('click', () => this.#applySelectionProposal(proposal));
      panel.appendChild(applyBtn);
    }

    const preview = document.createElement('p');
    preview.className = 'hint bindery-studio-proposal-preview';
    preview.textContent = `${game.i18n!.localize('BINDERY.studio.selectionRawPreview' as never)}: „${proposal.rawPreview}”`;
    panel.appendChild(preview);

    container.appendChild(panel);
  }

  #applySelectionProposal(proposal: SelectionProposal): void {
    const checked = proposal.pairs.filter((p) => p.checked);
    this.#selectionProposal = null;
    this.#state.isSelectAreaMode = false;
    if (checked.length === 0) {
      void this.render();
      return;
    }
    void (async () => {
      for (const p of checked) await this.#addOrUpdateGridPair(proposal.slot, p.label, p.value);
      // `#addOrUpdateGridPair` suggests the canonical key automatically —
      // overwrite it ONLY if the author manually changed the suggestion in
      // the checklist.
      const entry = this.#findPattern(proposal.slot === 'grid' ? this.#activeGridPatternId : this.#activeDerivedPatternId);
      if (entry?.pattern.kind === 'labelledPairs') {
        for (const p of checked) {
          if (!p.canonicalKey) continue;
          const labelEntry = entry.pattern.labels.find((l) => l.label === p.label);
          if (labelEntry) labelEntry.canonicalKey = p.canonicalKey;
        }
      }
      await this.render();
    })();
  }
}
