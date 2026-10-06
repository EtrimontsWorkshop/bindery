import { formatDiagnostic } from '../../i18n.js';
import { ASSET_BASE_URL } from '../../settings.js';

/**
 * The profile-builder window — Deliberately thin: every real
 * decision (schema shape, extraction, detection, actor-data building) comes
 * from `packages/core`, imported here ONLY where
 * needed. This file's own job is state + DOM wiring, nothing else.
 *
 * `@bindery/core` (and everything under `../schema/`, `../profile/`, which
 * themselves import it) is loaded ONLY via dynamic `import()` inside
 * methods, never at module top level — the same discipline `ImportWizard.ts`
 * already established (risk I3/`check:size`): this class is registered via
 * `game.settings.registerMenu` in `settings.ts`, which makes it part of the
 * EAGER world-startup bundle, so a static top-level import here would pull
 * the whole core package (and pdf.js) into that budget.
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProfile = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyField = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCollection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDescriptor = any;

type BuilderPhase = 'list' | 'editor';
type BuilderTab = 'source' | 'fields' | 'collections' | 'detection';
type BuilderMode = 'simple' | 'advanced';

/** A text element on the page as the user clicked it: its text, how it is styled, and whether that styling is just the page's ordinary body text (then matching "by look" would match everything). */
interface ClickedElement {
  text: string;
  fontSize: number;
  bold: boolean;
  isBodyStyle: boolean;
  /** Another text element follows it on the same line — so it reads as a label and its value comes after, rather than being the value itself. */
  hasValueAfter: boolean;
}

/** What the user just marked on the page preview, waiting to be assigned to a field/name via a button click — never applied automatically (the profile author always picks WHICH field a selection belongs to). */
interface PendingCapture {
  kind: 'label' | 'region';
  pageNumber: number;
  labelText?: string;
  element?: ClickedElement;
  normalizedRect?: { minX: number; minY: number; maxX: number; maxY: number };
}

type FieldTarget = { scope: 'name' } | { scope: 'field'; fieldId: string } | { scope: 'collectionName'; collectionId: string } | { scope: 'collectionField'; collectionId: string; fieldId: string };

const TRANSFORM_KINDS_NO_PARAM = new Set(['trim', 'normalizeWhitespace', 'joinWrappedLines', 'stripLigaturesAndOddChars', 'parseNumber', 'textToHtml']);

export class ProfileBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-statblock-profile-builder',
    classes: ['bindery', 'bindery-profile-builder-app'],
    window: {
      title: 'BINDERY.statblockProfileBuilder.title',
      resizable: true,
      icon: 'fa-solid fa-dragon',
    },
    position: { width: 1180, height: 760 },
    actions: {
      newProfile: ProfileBuilderApp.#onNewProfile,
      editProfile: ProfileBuilderApp.#onEditProfile,
      duplicateProfile: ProfileBuilderApp.#onDuplicateProfileFromList,
      deleteProfile: ProfileBuilderApp.#onDeleteProfileFromList,
      exportProfile: ProfileBuilderApp.#onExportProfileFromList,
      importProfile: ProfileBuilderApp.#onImportProfile,
      backToList: ProfileBuilderApp.#onBackToList,
      switchTab: ProfileBuilderApp.#onSwitchTab,
      setMode: ProfileBuilderApp.#onSetMode,
      saveProfile: ProfileBuilderApp.#onSaveProfile,
      duplicateCurrentProfile: ProfileBuilderApp.#onDuplicateCurrent,
      deleteCurrentProfile: ProfileBuilderApp.#onDeleteCurrent,
      exportCurrentProfile: ProfileBuilderApp.#onExportCurrent,
      prevPage: ProfileBuilderApp.#onPrevPage,
      nextPage: ProfileBuilderApp.#onNextPage,
      selectSchemaTarget: ProfileBuilderApp.#onSelectSchemaTarget,
      selectNameTarget: ProfileBuilderApp.#onSelectNameTarget,
      selectCollectionNameTarget: ProfileBuilderApp.#onSelectCollectionNameTarget,
      selectCollectionFieldTarget: ProfileBuilderApp.#onSelectCollectionFieldTarget,
      addCollectionField: ProfileBuilderApp.#onAddCollectionField,
      assignCapture: ProfileBuilderApp.#onAssignCapture,
      clearCapture: ProfileBuilderApp.#onClearCapture,
      removeField: ProfileBuilderApp.#onRemoveField,
      addTransformStep: ProfileBuilderApp.#onAddTransformStep,
      removeTransformStep: ProfileBuilderApp.#onRemoveTransformStep,
      addCollection: ProfileBuilderApp.#onAddCollection,
      removeCollection: ProfileBuilderApp.#onRemoveCollection,
      addRequiredLabel: ProfileBuilderApp.#onAddRequiredLabel,
      removeRequiredLabel: ProfileBuilderApp.#onRemoveRequiredLabel,
      testDetection: ProfileBuilderApp.#onTestDetection,
      jumpToCandidate: ProfileBuilderApp.#onJumpToCandidate,
      anchorByLook: ProfileBuilderApp.#onAnchorByLook,
      anchorByText: ProfileBuilderApp.#onAnchorByText,
    },
  };

  static override PARTS = {
    main: { template: 'modules/bindery-pdf-importer/templates/statblock-profile-builder.hbs' },
  };

  #phase: BuilderPhase = 'list';
  #mode: BuilderMode = 'simple';
  #tab: BuilderTab = 'source';
  #busy: string | null = null;
  #validationIssues: string[] = [];

  #profiles: AnyProfile[] = [];
  #profile: AnyProfile | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #templateActor: any = null;
  #actorDescriptors: AnyDescriptor[] = [];
  #itemDescriptorsByCollectionId = new Map<string, AnyDescriptor[]>();
  #schemaSearch = '';
  #refocusSchemaSearch = false;

  #pdfFile: File | null = null;
  #pdfBuffer: ArrayBuffer | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #previewDoc: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #pagesForDetection: any[] | null = null;
  #currentPageNumber = 1;
  #pageRenderToken = 0;
  /** Rendered-page cache with LRU eviction — same pattern as `ReviewScreen.ts`'s `#pageImageCache`/`#ensurePageImage`, reused rather than reinvented: without it, every unrelated re-render (clicking a field, typing in a search box — ApplicationV2 replaces the whole DOM part on every `render()`) re-decoded and re-encoded the current PDF page from scratch, and every decode leaked its own `URL.createObjectURL` (never revoked) — both compounding badly on a large, many-page PDF (performance). */
  #pageImageCache = new Map<number, string>();
  #pageImageOrder: number[] = [];
  static readonly #PAGE_CACHE_SIZE = 5;

  #selectedTarget: FieldTarget | null = null;
  #pendingCapture: PendingCapture | null = null;
  /** Text of each overlay rectangle currently drawn (see `#wireRegionDrag`'s pointerup for why this isn't a per-rect click listener). */
  #rectLabels = new WeakMap<SVGRectElement, ClickedElement>();
  /** What the user last clicked on the Detection tab, kept so "by look" / "by text" can be switched without clicking again. */
  #anchorPick: { element: ClickedElement; mode: 'look' | 'text' } | null = null;
  #dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #detectionResults: any[] | null = null;

  async #core(): Promise<CoreModule> {
    return import('@bindery/core');
  }

  async #store(): Promise<CoreModule> {
    return import('../profile/store.js');
  }

  async #schema(): Promise<CoreModule> {
    return import('../schema/introspectActor.js');
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    if (this.#phase === 'list') {
      const store = await this.#store();
      this.#profiles = store.listProfiles();
      return {
        phase: 'list',
        isListPhase: true,
        profiles: this.#profiles.map((p: AnyProfile) => ({ id: p.id, name: p.name, actorType: p.actorType })),
      };
    }

    const profile = this.#profile!;
    const core = await this.#core();

    const validation = core.validateProfile(profile);
    this.#validationIssues = validation.ok ? [] : validation.issues;

    return {
      phase: 'editor',
      mode: this.#mode,
      isAdvanced: this.#mode === 'advanced',
      tab: this.#tab,
      isSourceTab: this.#tab === 'source',
      isFieldsTab: this.#tab === 'fields',
      isCollectionsTab: this.#tab === 'collections',
      isDetectionTab: this.#tab === 'detection',
      showPreview: this.#tab === 'fields' || this.#tab === 'detection',
      anchorSummary: this.#describeAnchor(profile),
      anchorPick: this.#anchorPick ? { isLook: this.#anchorPick.mode === 'look', isText: this.#anchorPick.mode === 'text' } : null,
      detectionFoundSummary: this.#detectionResults && this.#detectionResults.length > 0 ? game.i18n!.format('BINDERY.statblockProfileBuilder.detectionFound', { count: String(this.#detectionResults.length) }) : null,
      busy: this.#busy,
      validationIssues: this.#validationIssues,
      isValid: this.#validationIssues.length === 0,

      profileName: profile.name,
      actorType: profile.actorType,
      actorOptions: (game.actors!.contents as { id: string; uuid: string; name: string; type: string }[]).map((a) => ({ id: a.id, name: a.name, type: a.type, isSelected: a.uuid === profile.templateActorUuid })),
      templateActorName: this.#templateActor?.name ?? null,
      inheritUnmapped: profile.inheritUnmappedFromTemplate,

      pdfFileName: this.#pdfFile?.name ?? null,
      hasPdf: this.#previewDoc !== null,
      currentPageImageUrl: this.#pageImageCache.get(this.#currentPageNumber) ?? null,
      currentPageNumber: this.#currentPageNumber,
      pageCount: this.#previewDoc?.pageCount ?? 0,

      schemaSearch: this.#schemaSearch,
      schemaRows: this.#buildSchemaRows(profile),

      pendingCapture: this.#describePendingCapture(),
      selectedTargetLabel: this.#describeSelectedTarget(profile),
      selectedFieldPanel: await this.#buildSelectedFieldPanel(profile),

      fields: profile.fields.map((f: AnyField) => ({ id: f.id, actorSchemaPath: f.actorSchemaPath, hasSource: !!f.source, isSelected: this.#selectedTarget !== null && this.#selectedTarget.scope === 'field' && this.#selectedTarget.fieldId === f.id })),

      collections: profile.collections.map((c: AnyCollection) => this.#buildCollectionRow(c)),

      detection: this.#buildDetectionContext(profile),
      detectionNone: this.#detectionResults !== null && this.#detectionResults.length === 0,
      detectionResults: this.#detectionResults?.map((c) => ({
        id: c.id,
        page: c.regions[0]?.pageNumber ?? '?',
        confidencePercent: Math.round(c.confidence * 100),
        snippet: c.elements[0]?.text ?? '',
      })),
    };
  }

  // ---- display helpers (UI-only; no algorithmic decisions of their own) ----

  #buildSchemaRows(profile: AnyProfile): Array<{ path: string; label: string; depth: number; isGroup: boolean; isMapped: boolean; isSelected: boolean }> {
    const query = this.#schemaSearch.trim().toLowerCase();
    const rows: Array<{ path: string; label: string; depth: number; isGroup: boolean; isMapped: boolean; isSelected: boolean }> = [];
    const mappedPaths = new Set(profile.fields.filter((f: AnyField) => f.source).map((f: AnyField) => f.actorSchemaPath));
    const target = this.#selectedTarget;

    // A leaf is often labelled only by its own role ("Flat", "Max") while the name the user knows ("Armor Class") sits on a parent group — so the search, and the label shown while searching, include the ancestors' labels.
    const walk = (nodes: AnyDescriptor[], depth: number, trail: string[]): void => {
      for (const node of nodes) {
        const isLeaf = !node.children || node.children.length === 0;
        const fullLabel = [...trail, node.label].join(' › ');
        const matches = !query || node.path.toLowerCase().includes(query) || fullLabel.toLowerCase().includes(query);
        if (isLeaf) {
          if (matches) {
            rows.push({
              path: node.path,
              label: query ? fullLabel : node.label,
              depth,
              isGroup: false,
              isMapped: mappedPaths.has(node.path),
              isSelected: target !== null && target.scope === 'field' && profile.fields.find((f: AnyField) => f.id === target.fieldId)?.actorSchemaPath === node.path,
            });
          }
        } else {
          if (!query) rows.push({ path: node.path, label: node.label, depth, isGroup: true, isMapped: false, isSelected: false });
          walk(node.children, depth + 1, [...trail, node.label]);
        }
      }
    };
    walk(this.#actorDescriptors, 0, []);
    return rows;
  }

  #describePendingCapture(): { kind: string; text: string } | null {
    const capture = this.#pendingCapture;
    if (!capture) return null;
    if (capture.kind === 'label') return { kind: 'label', text: capture.labelText ?? '' };
    return { kind: 'region', text: 'region' };
  }

  #describeSelectedTarget(profile: AnyProfile): string | null {
    const target = this.#selectedTarget;
    if (!target) return null;
    if (target.scope === 'name') return 'name';
    if (target.scope === 'field') return profile.fields.find((f: AnyField) => f.id === target.fieldId)?.actorSchemaPath ?? null;
    if (target.scope === 'collectionName') return `${target.collectionId} → name`;
    return `${target.collectionId} → ${target.fieldId}`;
  }

  #resolveFieldForTarget(profile: AnyProfile, target: FieldTarget): { source?: unknown; sourceRef: 'name' | AnyField } | null {
    if (target.scope === 'name') return { source: profile.nameSource, sourceRef: 'name' };
    if (target.scope === 'field') {
      const field = profile.fields.find((f: AnyField) => f.id === target.fieldId);
      return field ? { source: field.source, sourceRef: field } : null;
    }
    if (target.scope === 'collectionName') {
      const collection = profile.collections.find((c: AnyCollection) => c.id === target.collectionId);
      return collection ? { source: collection.nameSource, sourceRef: 'name' } : null;
    }
    const collection = profile.collections.find((c: AnyCollection) => c.id === target.collectionId);
    const field = collection?.itemFields.find((f: AnyField) => f.id === target.fieldId);
    return field ? { source: field.source, sourceRef: field } : null;
  }

  /**
   * Built INLINE within `_prepareContext` (async, awaited by Foundry's own
   * render pipeline) rather than as a post-render side effect that calls
   * `this.render()` again — that would re-enter `_prepareContext` while
   * `#selectedTarget` is still set, re-triggering the same computation
   * forever. One render, one extraction, every time.
   */
  async #buildSelectedFieldPanel(profile: AnyProfile): Promise<Record<string, unknown> | null> {
    const target = this.#selectedTarget;
    if (!target) return null;
    const resolved = this.#resolveFieldForTarget(profile, target);
    if (!resolved) return null;
    const source = resolved.source as { kind?: string; labelPattern?: string; value?: string | number | boolean } | undefined;
    const field = resolved.sourceRef === 'name' ? null : (resolved.sourceRef as AnyField);

    return {
      isFieldTarget: field !== null,
      fieldId: field?.id ?? null,
      collectionId: target.scope === 'collectionField' ? target.collectionId : '',
      hasSource: !!source,
      isLabelSource: source?.kind === 'label',
      isRegionSource: source?.kind === 'region',
      isStyleSource: source?.kind === 'styleFilter',
      isLiteralSource: source?.kind === 'literal',
      showLabelPattern: !source || source.kind === 'label',
      literal: field ? this.#buildLiteralPanel(target, field, source) : null,
      sourceKind: source?.kind ?? null,
      labelPattern: source?.kind === 'label' ? source.labelPattern : '',
      canAssignCapture: this.#pendingCapture !== null,
      transforms: field
        ? field.transforms.map((step: { kind: string }, index: number) => ({
            index,
            kind: step.kind,
            summary: this.#summarizeTransformStep(step),
          }))
        : [],
      preview: await this.#computeLivePreview(profile, target, field),
    };
  }

  /** Controls for "set this field to a fixed value on every imported Actor": a list when the schema field has choices, true/false for a boolean, free text otherwise. */
  #buildLiteralPanel(target: FieldTarget, field: AnyField, source: { kind?: string; value?: string | number | boolean } | undefined): Record<string, unknown> {
    const descriptors = target.scope === 'collectionField' ? (this.#itemDescriptorsByCollectionId.get(target.collectionId) ?? []) : this.#actorDescriptors;
    const descriptor = this.#findDescriptorByPath(descriptors, field.actorSchemaPath);
    const current = source?.kind === 'literal' ? String(source.value) : '';
    const choices = (descriptor?.choices ?? []).map((c: { value: string | number; label: string }) => ({ value: String(c.value), label: c.label, selected: String(c.value) === current }));
    return {
      hasChoices: choices.length > 0,
      choices,
      isBoolean: choices.length === 0 && descriptor?.type === 'boolean',
      isText: choices.length === 0 && descriptor?.type !== 'boolean',
      isTrue: current === 'true',
      isFalse: current === 'false',
      value: current,
    };
  }

  /** Live preview: raw text -> after transforms -> target value with validation — the extraction engine, run against the CURRENT preview page's elements as the block. `null` when there's nothing to preview yet (no PDF loaded, no source configured on this target). */
  async #computeLivePreview(profile: AnyProfile, target: FieldTarget, field: AnyField | null): Promise<{ raw: string | null; value: string | null; found: boolean; diagnostics: string[] } | null> {
    if (!this.#pagesForDetection) return null;
    const resolved = this.#resolveFieldForTarget(profile, target);
    const source = resolved?.source as { kind?: string } | undefined;
    if (!source?.kind) return null;
    const page = this.#pagesForDetection.find((p: { pageNumber: number }) => p.pageNumber === this.#currentPageNumber);
    if (!page) return null;

    const core = await this.#core();
    const chainResult = field ? core.resolveTransformChain(field, profile) : { chain: [] };
    const constraints = { dataType: field?.dataType ?? 'string' };
    const block = { bbox: page.pageBox, elements: page.elements };
    const result = core.extractField(block, source, chainResult.chain, constraints);
    return {
      raw: result.raw,
      value: result.value === undefined ? null : String(result.value),
      found: result.found,
      diagnostics: result.diagnostics.map(formatDiagnostic),
    };
  }

  #summarizeTransformStep(step: { kind: string; pattern?: string; n?: number; separator?: string; value?: unknown }): string {
    const i18n = game.i18n!;
    switch (step.kind) {
      case 'regexExtract':
        return i18n.format('BINDERY.statblockProfileBuilder.summaryRegex', { value: step.pattern ?? '' });
      case 'nthNumber':
        return i18n.format('BINDERY.statblockProfileBuilder.summaryNthNumber', { value: String(step.n ?? '') });
      case 'split':
        return i18n.format('BINDERY.statblockProfileBuilder.summarySplit', { value: step.separator ?? '' });
      case 'join':
        return i18n.format('BINDERY.statblockProfileBuilder.summaryJoin', { value: step.separator ?? '' });
      case 'defaultValue':
        return i18n.format('BINDERY.statblockProfileBuilder.summaryDefault', { value: String(step.value ?? '') });
      default:
        return step.kind;
    }
  }

  #buildCollectionRow(collection: AnyCollection): Record<string, unknown> {
    const target = this.#selectedTarget;
    return {
      id: collection.id,
      itemType: collection.itemType,
      templateItemUuid: collection.templateItemUuid,
      splitKind: collection.splitRule.kind,
      isSplitRepeating: collection.splitRule.kind === 'repeatingLinePattern',
      isSplitSectionHeader: collection.splitRule.kind === 'sectionHeaderThenEntries',
      isSplitFixedDelimiter: collection.splitRule.kind === 'fixedDelimiter',
      sectionHeaderPattern: collection.splitRule.sectionHeaderPattern ?? '',
      entryBoundaryPattern: collection.splitRule.entryBoundaryPattern ?? '',
      itemFields: collection.itemFields.map((f: AnyField) => ({
        id: f.id,
        actorSchemaPath: f.actorSchemaPath,
        hasSource: !!f.source,
        isSelected: target !== null && target.scope === 'collectionField' && target.collectionId === collection.id && target.fieldId === f.id,
      })),
      isNameSelected: target !== null && target.scope === 'collectionName' && target.collectionId === collection.id,
    };
  }

  #buildDetectionContext(profile: AnyProfile): Record<string, unknown> {
    const anchor = profile.detection.anchor;
    const boundary = profile.detection.boundary;
    return {
      anchorKind: anchor.kind,
      isAnchorTextPattern: anchor.kind === 'textPattern',
      isAnchorHeadingStyle: anchor.kind === 'headingStyle',
      anchorStyleBold: anchor.styleFilter?.bold ?? false,
      anchorStyleLargest: anchor.styleFilter?.largestFontInBlock ?? false,
      anchorPattern: anchor.pattern ?? '',
      boundaryKind: boundary.kind,
      isBoundaryNextAnchor: boundary.kind === 'nextAnchor',
      isBoundaryVerticalGap: boundary.kind === 'verticalGap',
      isBoundaryEndOfColumnOrPage: boundary.kind === 'endOfColumnOrPage',
      isBoundaryEndLabel: boundary.kind === 'endLabel',
      gapThreshold: boundary.gapThreshold ?? '',
      endLabelPattern: boundary.endLabelPattern ?? '',
      requiredLabels: profile.detection.requiredLabels.map((l: { pattern: string }, index: number) => ({ index, pattern: l.pattern })),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    if (this.#phase !== 'editor') return;

    const pdfInput = this.element.querySelector<HTMLInputElement>('input[data-role="pdf-file"]');
    pdfInput?.addEventListener('change', () => void this.#onPdfSelected(pdfInput.files?.[0] ?? null));

    const actorSelect = this.element.querySelector<HTMLSelectElement>('select[name="templateActor"]');
    actorSelect?.addEventListener('change', () => void this.#onTemplateActorSelected(actorSelect.value));

    const searchInput = this.element.querySelector<HTMLInputElement>('input[data-role="schema-search"]');
    if (this.#refocusSchemaSearch && searchInput) {
      // ApplicationV2 replaces the DOM on every render, so the box the user is typing into is a fresh element each time — hand focus (and the caret) back to it.
      this.#refocusSchemaSearch = false;
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }
    searchInput?.addEventListener('input', () => {
      this.#schemaSearch = searchInput.value;
      this.#refocusSchemaSearch = true;
      void this.render();
    });

    const literalInput = this.element.querySelector<HTMLInputElement | HTMLSelectElement>('[data-role="literal-value"]');
    literalInput?.addEventListener('change', () => {
      const target = this.#selectedTarget;
      if (!target || !this.#profile) return;
      const field = this.#resolveFieldForTarget(this.#profile, target)?.sourceRef;
      if (!field || field === 'name') return;
      const text = literalInput.value;
      if (text === '') {
        if (field.source?.kind === 'literal') delete field.source;
      } else {
        const asNumber = field.dataType === 'number' && text.trim() !== '' && !Number.isNaN(Number(text)) ? Number(text) : text;
        field.source = { kind: 'literal', value: field.dataType === 'boolean' ? text === 'true' : asNumber };
      }
      void this.render();
    });

    const nameInput = this.element.querySelector<HTMLInputElement>('input[name="profileName"]');
    nameInput?.addEventListener('change', () => {
      if (this.#profile) this.#profile.name = nameInput.value;
    });

    const itemTypeInputs = this.element.querySelectorAll<HTMLInputElement>('input[data-role="collection-item-type"]');
    itemTypeInputs.forEach((input) => {
      input.addEventListener('change', () => {
        const collection = this.#profile?.collections.find((c: AnyCollection) => c.id === input.dataset['id']);
        if (collection) collection.itemType = input.value;
      });
    });

    const templateItemInputs = this.element.querySelectorAll<HTMLInputElement>('input[data-role="collection-template-item"]');
    templateItemInputs.forEach((input) => {
      input.addEventListener('change', () => {
        void (async () => {
          const collectionId = input.dataset['id']!;
          const collection = this.#profile?.collections.find((c: AnyCollection) => c.id === collectionId);
          if (!collection) return;
          collection.templateItemUuid = input.value;
          const item = input.value ? await fromUuid(input.value) : null;
          if (item) {
            const schema = await this.#schema();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = schema.introspectDocumentInstance('Item', item as any);
            this.#itemDescriptorsByCollectionId.set(collectionId, result.descriptors);
            collection.itemType = (item as unknown as { type: string }).type;
            await this.render();
          }
        })();
      });
    });

    const splitKindSelects = this.element.querySelectorAll<HTMLSelectElement>('select[data-role="collection-split-kind"]');
    splitKindSelects.forEach((select) => {
      select.addEventListener('change', () => {
        const collection = this.#profile?.collections.find((c: AnyCollection) => c.id === select.dataset['id']);
        if (collection) collection.splitRule = { kind: select.value };
        void this.render();
      });
    });

    const splitPatternInputs = this.element.querySelectorAll<HTMLInputElement>('input[data-role="collection-split-pattern"]');
    splitPatternInputs.forEach((input) => {
      input.addEventListener('change', () => {
        const collection = this.#profile?.collections.find((c: AnyCollection) => c.id === input.dataset['id']);
        if (!collection) return;
        if (collection.splitRule.kind === 'sectionHeaderThenEntries') collection.splitRule.sectionHeaderPattern = input.value;
        else collection.splitRule.entryBoundaryPattern = input.value;
      });
    });

    const anchorKindSelect = this.element.querySelector<HTMLSelectElement>('select[data-role="anchor-kind"]');
    anchorKindSelect?.addEventListener('change', () => {
      if (this.#profile) {
        this.#profile.detection.anchor = anchorKindSelect.value === 'headingStyle' ? { kind: 'headingStyle', styleFilter: { largestFontInBlock: true } } : { kind: 'textPattern' };
      }
      void this.render();
    });
    const anchorBoldCheckbox = this.element.querySelector<HTMLInputElement>('input[data-role="anchor-style-bold"]');
    anchorBoldCheckbox?.addEventListener('change', () => {
      if (this.#profile?.detection.anchor.styleFilter) this.#profile.detection.anchor.styleFilter.bold = anchorBoldCheckbox.checked;
    });
    const anchorLargestCheckbox = this.element.querySelector<HTMLInputElement>('input[data-role="anchor-style-largest"]');
    anchorLargestCheckbox?.addEventListener('change', () => {
      if (this.#profile?.detection.anchor.styleFilter) this.#profile.detection.anchor.styleFilter.largestFontInBlock = anchorLargestCheckbox.checked;
    });
    const anchorPatternInput = this.element.querySelector<HTMLInputElement>('input[data-role="anchor-pattern"]');
    anchorPatternInput?.addEventListener('change', () => {
      if (this.#profile) {
        this.#profile.detection.anchor.pattern = anchorPatternInput.value;
        this.#profile.detection.anchor.patternIsRegex = this.#mode === 'advanced';
      }
    });
    const boundaryKindSelect = this.element.querySelector<HTMLSelectElement>('select[data-role="boundary-kind"]');
    boundaryKindSelect?.addEventListener('change', () => {
      if (this.#profile) this.#profile.detection.boundary = { kind: boundaryKindSelect.value, gapThreshold: 20, endLabelPattern: '' };
      void this.render();
    });
    const gapThresholdInput = this.element.querySelector<HTMLInputElement>('input[data-role="gap-threshold"]');
    gapThresholdInput?.addEventListener('change', () => {
      if (this.#profile) this.#profile.detection.boundary.gapThreshold = Number(gapThresholdInput.value) || 1;
    });
    const endLabelInput = this.element.querySelector<HTMLInputElement>('input[data-role="end-label-pattern"]');
    endLabelInput?.addEventListener('change', () => {
      if (this.#profile) this.#profile.detection.boundary.endLabelPattern = endLabelInput.value;
    });
    const inheritCheckbox = this.element.querySelector<HTMLInputElement>('input[name="inheritUnmapped"]');
    inheritCheckbox?.addEventListener('change', () => {
      if (this.#profile) this.#profile.inheritUnmappedFromTemplate = inheritCheckbox.checked;
    });
    const labelSourcePatternInput = this.element.querySelector<HTMLInputElement>('input[data-role="label-pattern"]');
    labelSourcePatternInput?.addEventListener('change', () => {
      const target = this.#selectedTarget;
      if (!target || !this.#profile) return;
      const resolved = this.#resolveFieldForTarget(this.#profile, target);
      if (resolved?.source && (resolved.source as { kind?: string }).kind === 'label') (resolved.source as { labelPattern: string }).labelPattern = labelSourcePatternInput.value;
    });

    if ((this.#tab === 'fields' || this.#tab === 'detection') && this.#previewDoc) void this.#mountPageOverlay();
  }

  // ---- PDF preview + overlay --------------------------------------------

  /** Releases the CURRENT PDF's resources — the previous `PreviewDocument` (pdf.js worker/document handle) and every cached page image URL — before it's replaced or the window closes. Without this, opening a second exemplar PDF in the same session (or closing the window) leaked BOTH. */
  #teardownPreviewDoc(): void {
    if (this.#previewDoc) void this.#previewDoc.destroy();
    this.#previewDoc = null;
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    this.#pageImageCache.clear();
    this.#pageImageOrder = [];
  }

  async #onPdfSelected(file: File | null): Promise<void> {
    if (!file) return;
    this.#teardownPreviewDoc();
    this.#pdfFile = file;
    this.#busy = 'BINDERY.statblockProfileBuilder.loadingPdf';
    await this.render();
    try {
      this.#pdfBuffer = await file.arrayBuffer();
      const core = await this.#core();
      this.#previewDoc = await core.openPreviewDocument(this.#pdfBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#pagesForDetection = await core.buildPagesForDetection(this.#pdfBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#currentPageNumber = 1;
    } catch (err) {
      console.error('Bindery | ProfileBuilderApp: failed to open PDF', err);
      this.#previewDoc = null;
      this.#pagesForDetection = null;
    } finally {
      this.#busy = null;
      await this.render();
    }
  }

  /** Cache-first — see the `#pageImageCache` field comment for why this replaced a naive "always re-render" version. */
  async #ensurePageImage(pageNumber: number): Promise<void> {
    if (!this.#previewDoc || this.#pageImageCache.has(pageNumber)) return;
    const token = ++this.#pageRenderToken;
    try {
      const encoded = await this.#previewDoc.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' });
      if (token !== this.#pageRenderToken) return; // user already moved on — discard the stale result
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded.bytes)], { type: `image/${encoded.format}` }));
      this.#pageImageCache.set(pageNumber, url);
      this.#pageImageOrder.push(pageNumber);
      while (this.#pageImageOrder.length > ProfileBuilderApp.#PAGE_CACHE_SIZE) {
        const evict = this.#pageImageOrder.shift()!;
        const evictUrl = this.#pageImageCache.get(evict);
        if (evictUrl) URL.revokeObjectURL(evictUrl);
        this.#pageImageCache.delete(evict);
      }
      if ((this.#tab === 'fields' || this.#tab === 'detection') && pageNumber === this.#currentPageNumber) await this.render();
    } catch (err) {
      console.warn('Bindery | ProfileBuilderApp: renderPage failed:', err);
    }
  }

  async #mountPageOverlay(): Promise<void> {
    await this.#ensurePageImage(this.#currentPageNumber);
    const svg = this.element.querySelector<SVGSVGElement>('[data-pb-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-pb-page-image');
    if (!svg || !img || !img.getAttribute('src')) return;

    const core = await this.#core();
    const box = await this.#previewDoc.getPageBox(this.#currentPageNumber);
    const elements = (this.#pagesForDetection ?? []).find((p) => p.pageNumber === this.#currentPageNumber)?.elements ?? [];

    // The page's "body" style = the (size, bold) combination covering the most text.
    const styleKey = (el: { fontSize: number; bold: boolean }): string => `${Math.round(el.fontSize * 2) / 2}|${el.bold}`;
    const weight = new Map<string, number>();
    for (const el of elements as Array<{ text: string; fontSize: number; bold: boolean }>) weight.set(styleKey(el), (weight.get(styleKey(el)) ?? 0) + el.text.length);
    const bodyStyle = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const hasValueAfter = new Set<object>();
    for (const line of core.reconstructLines(elements)) for (const e of line.elements.slice(0, -1)) hasValueAfter.add(e);

    const draw = (): void => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      const geometry = { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation };
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const el of elements as Array<{ text: string; x: number; y: number; w: number; h: number }>) {
        const screen = core.pdfRectToScreen({ minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h }, geometry);
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        rect.setAttribute('class', 'bindery-pb-element');
        this.#rectLabels.set(rect, { text: el.text.trim(), fontSize: el.fontSize, bold: el.bold, isBodyStyle: styleKey(el) === bodyStyle, hasValueAfter: hasValueAfter.has(el) });
        svg.appendChild(rect);
      }
    };

    if (img.complete) draw();
    img.addEventListener('load', draw, { once: true });
    new ResizeObserver(() => draw()).observe(img);
    this.#wireRegionDrag(svg, img, box, core);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #wireRegionDrag(svg: SVGSVGElement, img: HTMLImageElement, box: any, core: CoreModule): void {
    if (svg.dataset['pbDragWired']) return;
    svg.dataset['pbDragWired'] = '1';
    const MIN_DRAG_PX = 8;

    const toOverlayPoint = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = svg.getBoundingClientRect();
      const view = svg.viewBox.baseVal;
      return { x: ((clientX - rect.left) / rect.width) * view.width, y: ((clientY - rect.top) / rect.height) * view.height };
    };

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      const start = toOverlayPoint(e.clientX, e.clientY);
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('class', 'bindery-pb-drag-rect');
      rectEl.setAttribute('x', String(start.x));
      rectEl.setAttribute('y', String(start.y));
      svg.appendChild(rectEl);
      this.#dragState = { startScreen: start, rectEl };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#dragState) return;
      const cur = toOverlayPoint(e.clientX, e.clientY);
      const { startScreen, rectEl } = this.#dragState;
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });
    svg.addEventListener('pointerup', (e: PointerEvent) => {
      const state = this.#dragState;
      this.#dragState = null;
      if (!state) return;
      const cur = toOverlayPoint(e.clientX, e.clientY);
      const width = Math.abs(cur.x - state.startScreen.x);
      const height = Math.abs(cur.y - state.startScreen.y);
      state.rectEl.remove();
      if (width < MIN_DRAG_PX || height < MIN_DRAG_PX) {
        // A plain click, not a drag. `setPointerCapture` above redirects the
        // browser's own `click` to the <svg> itself, so a per-rect click
        // listener never fires — find the text element under the pointer here.
        const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => this.#rectLabels.has(n as SVGRectElement));
        const clicked = hit ? this.#rectLabels.get(hit as SVGRectElement) : undefined;
        if (clicked && this.#tab === 'detection') {
          void this.#pickAnchor(clicked, clicked.isBodyStyle ? 'text' : 'look');
        } else if (clicked) {
          this.#pendingCapture = { kind: 'label', pageNumber: this.#currentPageNumber, labelText: clicked.text, element: clicked };
          void this.render();
        }
        return;
      }
      // Dragging out a region is for field capture only — it has no meaning for the statblock start.
      if (this.#tab === 'detection') return;
      const screenRect = { minX: Math.min(state.startScreen.x, cur.x), minY: Math.min(state.startScreen.y, cur.y), maxX: Math.max(state.startScreen.x, cur.x), maxY: Math.max(state.startScreen.y, cur.y) };
      const width_ = img.clientWidth;
      const height_ = img.clientHeight;
      const pdfRect = core.screenRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width_, imageHeightPx: height_, rotation: box.rotation });
      // Normalized relative to the WHOLE
      // page box, not "the statblock's own bbox" (`RegionSource`'s intended
      // meaning) — at capture time there is no established statblock region
      // yet (detection hasn't necessarily run), and the page box is the only
      // bbox available. A profile built this way only works correctly for
      // single-statblock-per-page layouts unless the author hand-edits the
      // normalized rect afterwards.
      const pageWidth = box.box.maxX - box.box.minX;
      const pageHeight = box.box.maxY - box.box.minY;
      this.#pendingCapture = {
        kind: 'region',
        pageNumber: this.#currentPageNumber,
        normalizedRect: {
          minX: (pdfRect.minX - box.box.minX) / pageWidth,
          minY: (pdfRect.minY - box.box.minY) / pageHeight,
          maxX: (pdfRect.maxX - box.box.minX) / pageWidth,
          maxY: (pdfRect.maxY - box.box.minY) / pageHeight,
        },
      };
      void this.render();
    });
  }

  static async #onPrevPage(this: ProfileBuilderApp): Promise<void> {
    if (this.#currentPageNumber <= 1) return;
    this.#currentPageNumber--;
    await this.render();
  }

  static async #onNextPage(this: ProfileBuilderApp): Promise<void> {
    if (!this.#previewDoc || this.#currentPageNumber >= this.#previewDoc.pageCount) return;
    this.#currentPageNumber++;
    await this.render();
  }

  async #onTemplateActorSelected(actorId: string): Promise<void> {
    const actor = game.actors!.get(actorId);
    this.#templateActor = actor ?? null;
    this.#actorDescriptors = [];
    this.#itemDescriptorsByCollectionId.clear();
    if (actor && this.#profile) {
      const schema = await this.#schema();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = schema.introspectDocumentInstance('Actor', actor as any);
      this.#actorDescriptors = result.descriptors;
      this.#profile.templateActorUuid = actor.uuid;
      this.#profile.actorType = actor.type;
      this.#profile.templateSchemaFingerprint = (await this.#core()).computeSchemaFingerprint(result.descriptors);
      this.#validationIssues = [];
    }
    await this.render();
  }

  // ---- profile list / CRUD -------------------------------------------------

  static #onNewProfile(this: ProfileBuilderApp): void {
    void (async () => {
      const core = await this.#core();
      this.#profile = {
        schemaVersion: core.STATBLOCK_PROFILE_SCHEMA_VERSION,
        id: foundry.utils.randomID(),
        name: game.i18n!.localize('BINDERY.statblockProfileBuilder.defaultProfileName'),
        actorType: '',
        templateActorUuid: '',
        templateSchemaFingerprint: '',
        detection: { anchor: { kind: 'textPattern' }, boundary: { kind: 'nextAnchor' }, requiredLabels: [] },
        nameSource: { kind: 'label', labelPattern: '', labelIsRegex: false, stopAt: 'endOfLine' },
        fields: [],
        collections: [],
        valueMaps: [],
        inheritUnmappedFromTemplate: true,
      };
      this.#phase = 'editor';
      this.#tab = 'source';
      this.#resetEditorState();
      await this.render();
    })();
  }

  static #onEditProfile(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const id = target.dataset['id']!;
      const store = await this.#store();
      const profile = store.getProfile(id);
      if (!profile) return;
      this.#profile = foundry.utils.deepClone(profile);
      this.#phase = 'editor';
      this.#tab = 'source';
      this.#resetEditorState();
      await this.#loadTemplates();
      await this.render();
    })();
  }

  /** The saved profile only remembers WHICH template Actor/Items it was built from — the field list in the editor comes from reading their schema again, so it has to be reloaded whenever a profile is opened. */
  async #loadTemplates(): Promise<void> {
    const profile = this.#profile;
    if (!profile) return;
    const schema = await this.#schema();
    const actor = profile.templateActorUuid ? await fromUuid(profile.templateActorUuid) : null;
    if (actor) {
      this.#templateActor = actor;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#actorDescriptors = schema.introspectDocumentInstance('Actor', actor as any).descriptors;
    } else {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.statblockProfileBuilder.templateActorMissing'));
    }
    for (const collection of profile.collections as AnyCollection[]) {
      const item = collection.templateItemUuid ? await fromUuid(collection.templateItemUuid) : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (item) this.#itemDescriptorsByCollectionId.set(collection.id, schema.introspectDocumentInstance('Item', item as any).descriptors);
    }
  }

  #resetEditorState(): void {
    this.#teardownPreviewDoc();
    this.#templateActor = null;
    this.#actorDescriptors = [];
    this.#itemDescriptorsByCollectionId.clear();
    this.#pdfFile = null;
    this.#pdfBuffer = null;
    this.#pagesForDetection = null;
    this.#currentPageNumber = 1;
    this.#selectedTarget = null;
    this.#pendingCapture = null;
    this.#detectionResults = null;
    this.#anchorPick = null;
  }

  static #onDuplicateProfileFromList(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const store = await this.#store();
      await store.duplicateProfile(target.dataset['id']!, `${target.dataset['name']} ${game.i18n!.localize('BINDERY.statblockProfileBuilder.copySuffix')}`);
      await this.render();
    })();
  }

  static #onDeleteProfileFromList(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const confirmed = await foundry.applications.api.DialogV2.confirm({ window: { title: 'BINDERY.statblockProfileBuilder.confirmDeleteTitle' }, content: `<p>${game.i18n!.localize('BINDERY.statblockProfileBuilder.confirmDeleteBody')}</p>` });
      if (!confirmed) return;
      const store = await this.#store();
      await store.deleteProfile(target.dataset['id']!);
      await this.render();
    })();
  }

  static #onExportProfileFromList(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const store = await this.#store();
      store.exportProfile(target.dataset['id']!);
    })();
  }

  static #onImportProfile(this: ProfileBuilderApp): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        const store = await this.#store();
        const result = await store.importProfileFromFile(file);
        if (!result.ok) {
          ui.notifications?.error(result.issues.join('; '));
          return;
        }
        await this.render();
      })();
    });
    input.click();
  }

  static #onBackToList(this: ProfileBuilderApp): void {
    void (async () => {
      this.#teardownPreviewDoc();
      this.#phase = 'list';
      this.#profile = null;
      await this.render();
    })();
  }

  static #onSaveProfile(this: ProfileBuilderApp): void {
    void (async () => {
      if (!this.#profile) return;
      this.#pruneEmptyFields();
      if (this.#selectedTarget && 'fieldId' in this.#selectedTarget && !this.#profile.fields.some((f: AnyField) => f.id === (this.#selectedTarget as { fieldId: string }).fieldId)) this.#selectedTarget = null;
      const core = await this.#core();
      const validation = core.validateProfile(this.#profile);
      if (!validation.ok) {
        this.#validationIssues = validation.issues;
        await this.render();
        return;
      }
      const store = await this.#store();
      await store.saveProfile(validation.profile);
      ui.notifications?.info(game.i18n!.localize('BINDERY.statblockProfileBuilder.saved'));
    })();
  }

  static #onDuplicateCurrent(this: ProfileBuilderApp): void {
    void (async () => {
      if (!this.#profile) return;
      this.#profile = { ...foundry.utils.deepClone(this.#profile), id: foundry.utils.randomID(), name: `${this.#profile.name} ${game.i18n!.localize('BINDERY.statblockProfileBuilder.copySuffix')}` };
      await this.render();
    })();
  }

  static #onDeleteCurrent(this: ProfileBuilderApp): void {
    void (async () => {
      if (!this.#profile) return;
      const confirmed = await foundry.applications.api.DialogV2.confirm({ window: { title: 'BINDERY.statblockProfileBuilder.confirmDeleteTitle' }, content: `<p>${game.i18n!.localize('BINDERY.statblockProfileBuilder.confirmDeleteBody')}</p>` });
      if (!confirmed) return;
      const store = await this.#store();
      await store.deleteProfile(this.#profile.id);
      this.#phase = 'list';
      this.#profile = null;
      await this.render();
    })();
  }

  static #onExportCurrent(this: ProfileBuilderApp): void {
    void (async () => {
      if (!this.#profile) return;
      const store = await this.#store();
      await store.saveProfile(this.#profile);
      store.exportProfile(this.#profile.id);
    })();
  }

  // ---- tabs / mode ---------------------------------------------------------

  static #onSwitchTab(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      this.#tab = target.dataset['tab'] as BuilderTab;
      await this.render();
    })();
  }

  static #onSetMode(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      this.#mode = target.dataset['mode'] as BuilderMode;
      await this.render();
    })();
  }

  // ---- field mapping ---------------------------------------------------------

  /** Clicking a field in the tree creates its entry so it can be given a source; entries that never got one are dropped as soon as the selection moves on, so only fields that really take a value stay in the profile (and show a check mark). Collection fields are added explicitly and removed explicitly, so they are left alone. */
  #pruneEmptyFields(keepFieldId?: string): void {
    const profile = this.#profile;
    if (!profile) return;
    profile.fields = profile.fields.filter((f: AnyField) => f.source || f.id === keepFieldId);
  }

  static #onSelectSchemaTarget(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const path = target.dataset['path']!;
      const profile = this.#profile!;
      let field = profile.fields.find((f: AnyField) => f.actorSchemaPath === path);
      this.#pruneEmptyFields(field?.id);
      if (!field) {
        const descriptor = this.#findDescriptorByPath(this.#actorDescriptors, path);
        field = {
          id: foundry.utils.randomID(),
          actorSchemaPath: path,
          dataType: descriptor?.type ?? 'string',
          capture: { exampleBbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, examplePageNumber: this.#currentPageNumber, relativePosition: 'sameLineAfterLabel' },
          transforms: [],
        };
        profile.fields.push(field);
      }
      this.#pruneEmptyFields(field.id);
      this.#selectedTarget = { scope: 'field', fieldId: field.id };
      await this.render();
    })();
  }

  static #onSelectNameTarget(this: ProfileBuilderApp): void {
    void (async () => {
      this.#pruneEmptyFields();
      this.#selectedTarget = { scope: 'name' };
      await this.render();
    })();
  }

  static #onSelectCollectionNameTarget(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      this.#pruneEmptyFields();
      this.#selectedTarget = { scope: 'collectionName', collectionId: target.dataset['collectionId']! };
      await this.render();
    })();
  }

  static #onSelectCollectionFieldTarget(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      this.#pruneEmptyFields();
      this.#selectedTarget = { scope: 'collectionField', collectionId: target.dataset['collectionId']!, fieldId: target.dataset['fieldId']! };
      await this.render();
    })();
  }

  /** No per-item-type schema tree in v1 — the profile author types the target Item's `actorSchemaPath` directly (advanced-mode knowledge, matching the simple/advanced split: a plain text field, not a picker, is the "advanced" affordance here). */
  static #onAddCollectionField(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const collectionId = target.dataset['collectionId']!;
      const input = this.element.querySelector<HTMLInputElement>(`input[data-role="new-collection-field-path"][data-collection-id="${collectionId}"]`);
      const path = input?.value.trim();
      if (!path) return;
      const collection = this.#profile!.collections.find((c: AnyCollection) => c.id === collectionId);
      if (!collection) return;
      const descriptors = this.#itemDescriptorsByCollectionId.get(collectionId) ?? [];
      const descriptor = this.#findDescriptorByPath(descriptors, path);
      const field = {
        id: foundry.utils.randomID(),
        actorSchemaPath: path,
        dataType: descriptor?.type ?? 'string',
        capture: { exampleBbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, examplePageNumber: this.#currentPageNumber, relativePosition: 'sameLineAfterLabel' },
        transforms: [],
      };
      collection.itemFields.push(field);
      this.#selectedTarget = { scope: 'collectionField', collectionId, fieldId: field.id };
      await this.render();
    })();
  }

  #findDescriptorByPath(nodes: AnyDescriptor[], path: string): AnyDescriptor | undefined {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = this.#findDescriptorByPath(node.children, path);
        if (found) return found;
      }
    }
    return undefined;
  }

  static #onAssignCapture(this: ProfileBuilderApp): void {
    void (async () => {
      const target = this.#selectedTarget;
      const capture = this.#pendingCapture;
      if (!target || !capture || !this.#profile) return;
      const resolved = this.#resolveFieldForTarget(this.#profile, target);
      if (!resolved) return;

      // Clicked text with something after it on its line is a LABEL (the value follows). Text that stands alone and looks different from the page's body text IS the value itself (a creature's name, typically) — take it by its look, so it also works for the next statblock, whose text differs.
      const el = capture.element;
      const source =
        capture.kind === 'region'
          ? { kind: 'region' as const, normalizedRect: capture.normalizedRect! }
          : el && !el.hasValueAfter && !el.isBodyStyle
            ? { kind: 'styleFilter' as const, filter: { minFontSize: el.fontSize - 0.5, maxFontSize: el.fontSize + 0.5, ...(el.bold ? { bold: true } : {}) } }
            : { kind: 'label' as const, labelPattern: capture.labelText ?? '', labelIsRegex: false, stopAt: 'endOfLine' as const };

      if (resolved.sourceRef === 'name') {
        if (target.scope === 'name') this.#profile.nameSource = source;
        else if (target.scope === 'collectionName') {
          const collection = this.#profile.collections.find((c: AnyCollection) => c.id === target.collectionId);
          if (collection) collection.nameSource = source;
        }
      } else {
        (resolved.sourceRef as AnyField).source = source;
      }
      this.#pendingCapture = null;
      await this.render();
    })();
  }

  static #onClearCapture(this: ProfileBuilderApp): void {
    void (async () => {
      this.#pendingCapture = null;
      await this.render();
    })();
  }

  static #onRemoveField(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const fieldId = target.dataset['fieldId']!;
      const collectionId = target.dataset['collectionId'];
      const profile = this.#profile!;
      if (collectionId) {
        const collection = profile.collections.find((c: AnyCollection) => c.id === collectionId);
        if (collection) collection.itemFields = collection.itemFields.filter((f: AnyField) => f.id !== fieldId);
      } else {
        profile.fields = profile.fields.filter((f: AnyField) => f.id !== fieldId);
      }
      if (this.#selectedTarget && 'fieldId' in this.#selectedTarget && this.#selectedTarget.fieldId === fieldId) this.#selectedTarget = null;
      await this.render();
    })();
  }

  // ---- transforms ---------------------------------------------------------

  static #onAddTransformStep(this: ProfileBuilderApp): void {
    void (async () => {
      const target = this.#selectedTarget;
      if (!target || target.scope === 'name' || target.scope === 'collectionName' || !this.#profile) return;
      const resolved = this.#resolveFieldForTarget(this.#profile, target);
      const field = resolved?.sourceRef as AnyField | undefined;
      if (!field) return;

      const kindSelect = this.element.querySelector<HTMLSelectElement>('select[data-role="new-transform-kind"]');
      const paramInput = this.element.querySelector<HTMLInputElement>('input[data-role="new-transform-param"]');
      const kind = kindSelect?.value ?? 'trim';
      const param = paramInput?.value ?? '';

      let step: { kind: string; pattern?: string; n?: number; separator?: string; value?: unknown };
      if (TRANSFORM_KINDS_NO_PARAM.has(kind)) step = { kind };
      else if (kind === 'regexExtract') step = { kind, pattern: param };
      else if (kind === 'nthNumber') step = { kind, n: Number(param) || 1 };
      else if (kind === 'split' || kind === 'join') step = { kind, separator: param };
      else step = { kind: 'defaultValue', value: param };

      field.transforms.push(step);
      await this.render();
    })();
  }

  static #onRemoveTransformStep(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const selTarget = this.#selectedTarget;
      if (!selTarget || selTarget.scope === 'name' || selTarget.scope === 'collectionName' || !this.#profile) return;
      const resolved = this.#resolveFieldForTarget(this.#profile, selTarget);
      const field = resolved?.sourceRef as AnyField | undefined;
      if (!field) return;
      const index = Number(target.dataset['index']);
      field.transforms.splice(index, 1);
      await this.render();
    })();
  }

  // ---- collections ---------------------------------------------------------

  static #onAddCollection(this: ProfileBuilderApp): void {
    void (async () => {
      const profile = this.#profile!;
      profile.collections.push({
        id: foundry.utils.randomID(),
        itemType: '',
        templateItemUuid: '',
        splitRule: { kind: 'sectionHeaderThenEntries' },
        nameSource: { kind: 'label', labelPattern: '', labelIsRegex: false, stopAt: 'endOfLine' },
        itemFields: [],
      });
      await this.render();
    })();
  }

  static #onRemoveCollection(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const profile = this.#profile!;
      profile.collections = profile.collections.filter((c: AnyCollection) => c.id !== target.dataset['id']);
      await this.render();
    })();
  }

  // ---- detection ---------------------------------------------------------

  static #onAddRequiredLabel(this: ProfileBuilderApp): void {
    void (async () => {
      const input = this.element.querySelector<HTMLInputElement>('input[data-role="new-required-label"]');
      const pattern = input?.value.trim();
      if (!pattern) return;
      this.#profile!.detection.requiredLabels.push({ pattern, isRegex: false });
      await this.render();
    })();
  }

  static #onRemoveRequiredLabel(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const index = Number(target.dataset['index']);
      this.#profile!.detection.requiredLabels.splice(index, 1);
      await this.render();
    })();
  }

  static #onTestDetection(this: ProfileBuilderApp): void {
    void (async () => {
      if (!this.#profile || !this.#pagesForDetection) return;
      const core = await this.#core();
      this.#detectionResults = core.detectStatblocks(this.#pagesForDetection, this.#profile);
      await this.render();
    })();
  }

  #describeAnchor(profile: AnyProfile): string {
    const i18n = game.i18n!;
    const anchor = profile.detection.anchor;
    if (anchor.kind === 'textPattern' && anchor.pattern) return i18n.format('BINDERY.statblockProfileBuilder.anchorSummaryText', { text: anchor.pattern });
    const filter = anchor.styleFilter;
    if (anchor.kind === 'headingStyle' && filter) {
      if (filter.minFontSize !== undefined) {
        return i18n.format(filter.bold ? 'BINDERY.statblockProfileBuilder.anchorSummaryStyleBold' : 'BINDERY.statblockProfileBuilder.anchorSummaryStyle', { size: String(Math.round(((filter.minFontSize + (filter.maxFontSize ?? filter.minFontSize)) / 2) * 10) / 10) });
      }
      return i18n.localize('BINDERY.statblockProfileBuilder.anchorSummaryCustomStyle');
    }
    return i18n.localize('BINDERY.statblockProfileBuilder.anchorNone');
  }

  /** Turns a clicked line into the statblock-start rule and immediately shows what it finds. "Look" = lines styled like the clicked one (size, bold); "text" = lines containing its text. */
  async #pickAnchor(element: ClickedElement, mode: 'look' | 'text'): Promise<void> {
    if (!this.#profile) return;
    this.#anchorPick = { element, mode };
    this.#profile.detection.anchor =
      mode === 'look'
        ? { kind: 'headingStyle', styleFilter: { minFontSize: element.fontSize - 0.5, maxFontSize: element.fontSize + 0.5, ...(element.bold ? { bold: true } : {}) } }
        : { kind: 'textPattern', pattern: element.text, patternIsRegex: false };
    if (this.#pagesForDetection) {
      const core = await this.#core();
      this.#detectionResults = core.detectStatblocks(this.#pagesForDetection, this.#profile);
    }
    await this.render();
  }

  static #onAnchorByLook(this: ProfileBuilderApp): void {
    if (this.#anchorPick) void this.#pickAnchor(this.#anchorPick.element, 'look');
  }

  static #onAnchorByText(this: ProfileBuilderApp): void {
    if (this.#anchorPick) void this.#pickAnchor(this.#anchorPick.element, 'text');
  }

  static #onJumpToCandidate(this: ProfileBuilderApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const id = target.dataset['id'];
      const candidate = this.#detectionResults?.find((c) => c.id === id);
      const page = candidate?.regions[0]?.pageNumber;
      if (!page) return;
      this.#currentPageNumber = page;
      await this.render();
    })();
  }

  override async close(options?: object): Promise<this> {
    this.#teardownPreviewDoc();
    return super.close(options);
  }
}
