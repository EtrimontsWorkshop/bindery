/**
 * [Step 23 Z1-Z5] The shape of a profile draft in the Profile Studio editor —
 * PURE UI convenience (lists instead of records, so it can be safely edited
 * row-by-row without losing order/identity), NOT validation. The validation/
 * decision of "is this a valid profile" stays EXCLUSIVELY in
 * `@bindery/core`'s `validateProfile` (Zod) — this file only converts to and
 * from that shape. Zero import of `@bindery/core` here (types are kept as a
 * plain object shape), so this file can be freely imported statically
 * without affecting I3/`check:size` (see `ProfileStudioLauncher.ts`).
 */

export interface LabelEntryDraft {
  label: string;
  canonicalKey: string;
}

export interface LabelledPairsPatternDraft {
  kind: 'labelledPairs';
  labels: LabelEntryDraft[];
  valuePattern: string;
  minPairs: number;
  maxPairs?: number;
  onRepeatedLabel: boolean;
  maxGapPt?: number;
  allowTrailingWords: boolean;
  unit?: string;
  trailingWordsStopBefore?: string;
}

export interface SectionListPatternDraft {
  kind: 'sectionList';
  sectionHeader: string;
  itemPattern: string;
  rejoinHyphenated: boolean;
  skipAfterHeader?: string;
  terminateSectionBefore?: string;
  /** [Step 40] Words/phrases denoting a ranged weapon — see `SectionListPattern.rangedKeywords` in `@bindery/core`. */
  rangedKeywords: string[];
}

export interface FontRoleCandidatePatternDraft {
  kind: 'fontRoleCandidate';
  excludeRoles: string[];
  maxLength: number;
  excludeRepeatedAcrossPages: boolean;
  excludeHyphenContinuations: boolean;
  /** [Step 29 Z3] Font keys learned by clicking in the "Name" tab — empty = unchanged behavior. */
  requireFontKeys: string[];
}

/**
 * [Step 34 Z2] "Notes pointed out in the PDF" — `offsetDxPt`/`offsetDyPt`
 * are ALWAYS numeric (the `@bindery/core` schema requires this, no optional
 * field), defaulting to `{0,0}` (not yet measured -> starting point = the
 * end of the entity's own content, see `lastClaimedTokenBbox`) — the UI
 * distinguishes "not yet measured" with the separate `measured` field, not
 * by the `{0,0}` value itself (which could also be a genuine measurement
 * result).
 */
export interface ProseBlockPatternDraft {
  kind: 'proseBlock';
  label: string;
  offsetDxPt: number;
  offsetDyPt: number;
  measured: boolean;
  maxLengthChars: number;
  searchRadiusPt: number;
  /**
   * [Live report after Step 39, "Wrak.pdf" Investigators] See the comment
   * near `chainFromPrevious` in `schema.ts` — `false` (default) computes the
   * offset relative to a fixed point (the end of the grid/derived
   * stats/attacks/skills), `true` relative to the end of the PREVIOUS note in
   * the `notesPatterns` list (stable when note fields stack one below the
   * other with variable length between them, e.g. different biography
   * lengths for different characters).
   */
  chainFromPrevious: boolean;
  /** [Live report, "I only select these two, and all the information from those paragraphs gets written into them"] See the comment near `stopAtSameFontRole` in `schema.ts` — the collection stops at the next heading of THE SAME style as the clicked example, instead of always stopping at `accent`. */
  stopAtSameFontRole: boolean;
  /** [Live report, "Wrak.pdf" Investigators, "Your friends" in a separate column] See the comment near `anchorGridOnly` in `schema.ts` — the offset is computed exclusively relative to the end of the anchor grid, without attacks/skills. */
  anchorGridOnly: boolean;
}

export type PatternDraft = LabelledPairsPatternDraft | SectionListPatternDraft | FontRoleCandidatePatternDraft | ProseBlockPatternDraft;

export interface PatternEntryDraft {
  id: string;
  pattern: PatternDraft;
}

export interface AttachRuleDraft {
  pattern: string;
  strategy: 'nearestBelow' | 'nearestAbove' | 'nearest';
  maxDistancePt: number;
  preferEarlierSiblingMaxDeltaYPt?: number;
}

export interface ProfileDraft {
  schemaVersion: 2;
  id: string;
  gameLine: string;
  language: string;
  title: string;
  publication: string;
  author?: string;
  license?: string;
  provides: string[];
  fingerprintMinScore: number;
  pageRanges: [number, number][];
  patterns: PatternEntryDraft[];
  anchor: string;
  attach: AttachRuleDraft[];
  nameConfidenceThreshold: number;
  namePlaceholder: string;
  skillsPattern: string;
  /** [Report after step 30, "Separating name from type/occupation"] The id of the `fontRoleCandidate` pattern pointed to as the occupation/type ("yacht captain"), SEPARATE from `anchor`'s paired name. An empty string = not set (backward compatibility). */
  typeLabelPattern: string;
  /** [Step 34 Z2] Ids of `proseBlock` patterns — see `entityAssembly.notesPatterns` in `schema.ts`. Order = the order of blocks in the final note. */
  notesPatterns: string[];
  /**
   * [Report after step 30, "Wrak" — images with a full bleed and text
   * overlaid on every page] Its own, typed field (NOT via extraJson),
   * because requiring raw JSON mode for a single checkbox turned out to be
   * bad UX — see `images.treatFullBleedAsContent` in `schema.ts`
   * (`@bindery/core`).
   */
  treatFullBleedAsContent: boolean;
  /**
   * [at user request, EXPERIMENTAL, after fixing "Wrak"] See
   * `images.autoCropUniformMargins` in `schema.ts`. Has no effect when
   * `treatFullBleedAsContent` is disabled.
   */
  autoCropUniformMargins: boolean;
  /**
   * [at user request, after fixing "Wrak" cropping] See
   * `images.brightenAutoCroppedImages` in `schema.ts`. Has no effect when
   * `autoCropUniformMargins` is disabled.
   */
  brightenAutoCroppedImages: boolean;
  /**
   * [Step 42 Z1] See `images.removeTokenBackgroundDefault` in `schema.ts` —
   * only the starting value of the toggle in the token-preparation panel.
   */
  removeTokenBackgroundDefault: boolean;
  /**
   * [Z5, escape hatch to raw JSON] Fields outside the form (Z2-Z4) — any
   * extra JSON, merged DIRECTLY into `draftToProfileInput`'s result without
   * interpretation (e.g. `fingerprint.keywords`, `pages.excludeZones`,
   * `images`). `undefined` until the user uses the raw-JSON mode.
   */
  extraJson?: Record<string, unknown>;
}

/**
 * [Step 34 Z2, bug measured live] This counter is MODULE-SCOPED (survives
 * the whole lifetime of the browser tab), but loading an EXISTING profile
 * (`profileToDraft`) keeps the ORIGINAL ids from the file ("draft-1"
 * .."draft-6") DIRECTLY as keys — it NEVER calls `nextDraftId()` — so this
 * counter stays at `0` even after loading a profile with six patterns. The
 * first `createPatternDraft()` call AFTER loading such a profile (e.g. "+
 * Add note block" in the Notes tab — the only place that calls it
 * REPEATEDLY on the SAME, ALREADY populated draft) therefore generates
 * "draft-1" — an id ALREADY taken by the loaded pattern! Two
 * `draft.patterns` entries with the same `id` break every
 * `.find(e => e.id === id)` throughout the file (always hits the FIRST,
 * older entry) — measured directly: the new note block disappeared
 * entirely, because `#buildNotesTabContent` found the original
 * characteristics grid instead of it and skipped it
 * (`kind !== 'proseBlock'`). Fix: `existingIds` (the current
 * `draft.patterns` at call time) is excluded when searching for the next
 * free number — guaranteeing a unique id regardless of how many times, and
 * in what order, a profile was loaded/edited in the same tab.
 */
let draftIdCounter = 0;
function nextDraftId(existingIds: ReadonlySet<string>): string {
  let id: string;
  do {
    draftIdCounter += 1;
    id = `draft-${draftIdCounter}`;
  } while (existingIds.has(id));
  return id;
}

export function createEmptyProfileDraft(): ProfileDraft {
  return {
    schemaVersion: 2,
    id: '',
    gameLine: '',
    language: '',
    title: '',
    publication: '',
    provides: ['actors'],
    fingerprintMinScore: 0.5,
    pageRanges: [[1, -1]],
    patterns: [],
    anchor: '',
    attach: [],
    nameConfidenceThreshold: 0.7,
    namePlaceholder: 'NPC #{ordinal} (p. {page})',
    skillsPattern: '',
    typeLabelPattern: '',
    notesPatterns: [],
    treatFullBleedAsContent: false,
    autoCropUniformMargins: false,
    brightenAutoCroppedImages: false,
    removeTokenBackgroundDefault: false,
  };
}

function labelsRecordToDraft(labels: Record<string, string>): LabelEntryDraft[] {
  return Object.entries(labels).map(([label, canonicalKey]) => ({ label, canonicalKey }));
}

function labelsDraftToRecord(labels: readonly LabelEntryDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of labels) {
    if (entry.label.trim().length === 0) continue;
    out[entry.label] = entry.canonicalKey;
  }
  return out;
}

/** [Z1] Converts an ALREADY validated `ProfileV2` (from `@bindery/core`) into an editable draft — the caller (`ProfileStudio.ts`) passes a structurally compatible object; this file doesn't import the type directly (see the header). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function profileToDraft(profile: any): ProfileDraft {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patterns: PatternEntryDraft[] = Object.entries(profile.patterns ?? {}).map(([id, p]: [string, any]) => {
    if (p.kind === 'labelledPairs') {
      const draft: LabelledPairsPatternDraft = {
        kind: 'labelledPairs',
        labels: labelsRecordToDraft(p.labels ?? {}),
        valuePattern: p.valuePattern ?? '',
        minPairs: p.minPairs ?? 1,
        maxPairs: p.maxPairs,
        onRepeatedLabel: p.terminate?.onRepeatedLabel ?? false,
        maxGapPt: p.terminate?.maxGapPt,
        allowTrailingWords: p.allowTrailingWords ?? false,
        unit: p.unit,
        trailingWordsStopBefore: p.trailingWordsStopBefore,
      };
      return { id, pattern: draft };
    }
    if (p.kind === 'sectionList') {
      const draft: SectionListPatternDraft = {
        kind: 'sectionList',
        sectionHeader: p.sectionHeader ?? '',
        itemPattern: p.itemPattern ?? '',
        rejoinHyphenated: p.rejoinHyphenated ?? false,
        skipAfterHeader: p.skipAfterHeader,
        terminateSectionBefore: p.terminateSectionBefore,
        rangedKeywords: p.rangedKeywords ?? [],
      };
      return { id, pattern: draft };
    }
    if (p.kind === 'proseBlock') {
      const draft: ProseBlockPatternDraft = {
        kind: 'proseBlock',
        label: p.label ?? '',
        offsetDxPt: p.offset?.dxPt ?? 0,
        offsetDyPt: p.offset?.dyPt ?? 0,
        // A profile loaded from a file already has a "real" measurement
        // (whoever saved it made one) -- distinguishing "not yet clicked"
        // applies ONLY to patterns newly created in this session
        // (`createPatternDraft`).
        measured: true,
        maxLengthChars: p.maxLengthChars ?? 2000,
        searchRadiusPt: p.searchRadiusPt ?? 60,
        chainFromPrevious: p.chainFromPrevious ?? false,
        stopAtSameFontRole: p.stopAtSameFontRole ?? false,
        anchorGridOnly: p.anchorGridOnly ?? false,
      };
      return { id, pattern: draft };
    }
    const draft: FontRoleCandidatePatternDraft = {
      kind: 'fontRoleCandidate',
      excludeRoles: p.excludeRoles ?? ['body'],
      maxLength: p.maxLength ?? 60,
      excludeRepeatedAcrossPages: p.excludeRepeatedAcrossPages ?? true,
      excludeHyphenContinuations: p.excludeHyphenContinuations ?? true,
      requireFontKeys: p.requireFontKeys ?? [],
    };
    return { id, pattern: draft };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attach: AttachRuleDraft[] = (profile.entityAssembly?.attach ?? []).map((r: any) => ({
    pattern: r.pattern,
    strategy: r.strategy,
    maxDistancePt: r.maxDistancePt,
    preferEarlierSiblingMaxDeltaYPt: r.preferEarlierSibling?.maxDeltaYPt,
  }));

  // Fields not covered by the form (Z2-Z4) -- preserved DIRECTLY in extraJson,
  // so that "Edit loaded profile" never silently loses content (an A3-like rule).
  const { schemaVersion, id, gameLine, language, title, publication, author, license, provides, fingerprint, pages, patterns: _p, entityAssembly, images, ...restTop } = profile;
  void schemaVersion;
  void _p;
  const extraJson: Record<string, unknown> = { ...restTop };
  const {
    treatFullBleedAsContent: treatFullBleedAsContentRaw,
    autoCropUniformMargins: autoCropUniformMarginsRaw,
    brightenAutoCroppedImages: brightenAutoCroppedImagesRaw,
    removeTokenBackgroundDefault: removeTokenBackgroundDefaultRaw,
    ...restImages
  } = images ?? {};
  if (Object.keys(restImages).length > 0) extraJson['images'] = restImages;
  const { minScore: _minScore, ...restFingerprint } = fingerprint ?? {};
  void _minScore;
  if (Object.keys(restFingerprint).length > 0) extraJson['fingerprintExtra'] = restFingerprint;
  if (pages?.excludeZones && pages.excludeZones.length > 0) extraJson['pagesExcludeZones'] = pages.excludeZones;
  const { allowCrossPage } = entityAssembly ?? {};
  if (allowCrossPage) extraJson['allowCrossPage'] = allowCrossPage;

  return {
    schemaVersion: 2,
    id: id ?? '',
    gameLine: gameLine ?? '',
    language: language ?? '',
    title: title ?? '',
    publication: publication ?? '',
    author,
    license,
    provides: provides ?? ['actors'],
    fingerprintMinScore: fingerprint?.minScore ?? 0.5,
    pageRanges: pages?.include ?? [[1, -1]],
    patterns,
    anchor: entityAssembly?.anchor ?? '',
    attach,
    nameConfidenceThreshold: entityAssembly?.nameConfidenceThreshold ?? 0.7,
    namePlaceholder: entityAssembly?.namePlaceholder ?? 'NPC #{ordinal} (p. {page})',
    skillsPattern: entityAssembly?.skillsPattern ?? '',
    typeLabelPattern: entityAssembly?.typeLabelPattern ?? '',
    notesPatterns: entityAssembly?.notesPatterns ?? [],
    treatFullBleedAsContent: treatFullBleedAsContentRaw ?? false,
    autoCropUniformMargins: autoCropUniformMarginsRaw ?? false,
    brightenAutoCroppedImages: brightenAutoCroppedImagesRaw ?? false,
    removeTokenBackgroundDefault: removeTokenBackgroundDefaultRaw ?? false,
    extraJson: Object.keys(extraJson).length > 0 ? extraJson : undefined,
  };
}

/** [Z5] Draft -> raw JSON ready for `validateProfile`. Doesn't validate anything itself — an empty string stays an empty string, Zod will reject it with a readable error. */
export function draftToProfileInput(draft: ProfileDraft): unknown {
  const patterns: Record<string, unknown> = {};
  for (const entry of draft.patterns) {
    if (entry.pattern.kind === 'labelledPairs') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'labelledPairs',
        labels: labelsDraftToRecord(p.labels),
        valuePattern: p.valuePattern,
        minPairs: p.minPairs,
        ...(p.maxPairs !== undefined ? { maxPairs: p.maxPairs } : {}),
        terminate: { onRepeatedLabel: p.onRepeatedLabel, ...(p.maxGapPt !== undefined ? { maxGapPt: p.maxGapPt } : {}) },
        allowTrailingWords: p.allowTrailingWords,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.trailingWordsStopBefore ? { trailingWordsStopBefore: p.trailingWordsStopBefore } : {}),
      };
    } else if (entry.pattern.kind === 'sectionList') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'sectionList',
        sectionHeader: p.sectionHeader,
        itemPattern: p.itemPattern,
        rejoinHyphenated: p.rejoinHyphenated,
        ...(p.skipAfterHeader ? { skipAfterHeader: p.skipAfterHeader } : {}),
        ...(p.terminateSectionBefore ? { terminateSectionBefore: p.terminateSectionBefore } : {}),
        rangedKeywords: p.rangedKeywords,
      };
    } else if (entry.pattern.kind === 'proseBlock') {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'proseBlock',
        label: p.label,
        offset: { dxPt: p.offsetDxPt, dyPt: p.offsetDyPt },
        maxLengthChars: p.maxLengthChars,
        searchRadiusPt: p.searchRadiusPt,
        chainFromPrevious: p.chainFromPrevious,
        stopAtSameFontRole: p.stopAtSameFontRole,
        anchorGridOnly: p.anchorGridOnly,
      };
    } else {
      const p = entry.pattern;
      patterns[entry.id] = {
        kind: 'fontRoleCandidate',
        excludeRoles: p.excludeRoles,
        maxLength: p.maxLength,
        excludeRepeatedAcrossPages: p.excludeRepeatedAcrossPages,
        excludeHyphenContinuations: p.excludeHyphenContinuations,
        ...(p.requireFontKeys.length > 0 ? { requireFontKeys: p.requireFontKeys } : {}),
      };
    }
  }

  const attach = draft.attach.map((r) => ({
    pattern: r.pattern,
    strategy: r.strategy,
    maxDistancePt: r.maxDistancePt,
    ...(r.preferEarlierSiblingMaxDeltaYPt !== undefined ? { preferEarlierSibling: { maxDeltaYPt: r.preferEarlierSiblingMaxDeltaYPt } } : {}),
  }));

  const extra = draft.extraJson ?? {};
  const { fingerprintExtra, pagesExcludeZones, allowCrossPage, images: extraImages, ...restExtra } = extra as Record<string, unknown>;
  const images: Record<string, unknown> = {
    ...(typeof extraImages === 'object' && extraImages ? (extraImages as Record<string, unknown>) : {}),
    ...(draft.treatFullBleedAsContent ? { treatFullBleedAsContent: true } : {}),
    ...(draft.autoCropUniformMargins ? { autoCropUniformMargins: true } : {}),
    ...(draft.brightenAutoCroppedImages ? { brightenAutoCroppedImages: true } : {}),
    ...(draft.removeTokenBackgroundDefault ? { removeTokenBackgroundDefault: true } : {}),
  };

  return {
    schemaVersion: 2,
    id: draft.id,
    gameLine: draft.gameLine,
    language: draft.language,
    title: draft.title,
    publication: draft.publication,
    ...(draft.author ? { author: draft.author } : {}),
    ...(draft.license ? { license: draft.license } : {}),
    provides: draft.provides,
    fingerprint: { minScore: draft.fingerprintMinScore, ...(typeof fingerprintExtra === 'object' && fingerprintExtra ? fingerprintExtra : {}) },
    pages: { include: draft.pageRanges, ...(Array.isArray(pagesExcludeZones) ? { excludeZones: pagesExcludeZones } : {}) },
    patterns,
    entityAssembly: {
      anchor: draft.anchor,
      attach,
      nameConfidenceThreshold: draft.nameConfidenceThreshold,
      namePlaceholder: draft.namePlaceholder,
      ...(draft.skillsPattern ? { skillsPattern: draft.skillsPattern } : {}),
      ...(draft.typeLabelPattern ? { typeLabelPattern: draft.typeLabelPattern } : {}),
      ...(draft.notesPatterns.length > 0 ? { notesPatterns: draft.notesPatterns } : {}),
      ...(allowCrossPage ? { allowCrossPage } : {}),
    },
    ...(Object.keys(images).length > 0 ? { images } : {}),
    ...restExtra,
  };
}

/** [Z6] A new, empty entry of a given pattern kind, with sensible default values — for the "Add pattern" button. */
/** [Step 34 Z2] `existingIds` — usually the caller's `draft.patterns.map(e => e.id)` — see the comment near `nextDraftId` for why this is necessary for correctness, not just cosmetic. */
export function createPatternDraft(kind: PatternDraft['kind'], existingIds: readonly string[] = []): PatternEntryDraft {
  const id = nextDraftId(new Set(existingIds));
  if (kind === 'labelledPairs') {
    return { id, pattern: { kind, labels: [], valuePattern: '^.+$', minPairs: 1, onRepeatedLabel: true, allowTrailingWords: false } };
  }
  if (kind === 'sectionList') {
    return { id, pattern: { kind, sectionHeader: '', itemPattern: '', rejoinHyphenated: false, rangedKeywords: [] } };
  }
  if (kind === 'proseBlock') {
    return {
      id,
      pattern: { kind, label: '', offsetDxPt: 0, offsetDyPt: 0, measured: false, maxLengthChars: 2000, searchRadiusPt: 60, chainFromPrevious: false, stopAtSameFontRole: false, anchorGridOnly: false },
    };
  }
  return { id, pattern: { kind, excludeRoles: ['body'], maxLength: 60, excludeRepeatedAcrossPages: true, excludeHyphenContinuations: true, requireFontKeys: [] } };
}

/** [Z3] Whether removing pattern `patternId` would break a reference from `anchor`/`attach`/`skillsPattern` — for warning before deletion. */
export function findPatternReferences(draft: ProfileDraft, patternId: string): string[] {
  const refs: string[] = [];
  if (draft.anchor === patternId) refs.push('entityAssembly.anchor');
  if (draft.skillsPattern === patternId) refs.push('entityAssembly.skillsPattern');
  if (draft.typeLabelPattern === patternId) refs.push('entityAssembly.typeLabelPattern');
  if (draft.notesPatterns.includes(patternId)) refs.push('entityAssembly.notesPatterns');
  draft.attach.forEach((rule, i) => {
    if (rule.pattern === patternId) refs.push(`entityAssembly.attach[${i}]`);
  });
  return refs;
}

/**
 * [Z6, Step 29 renamed and fixed] Regex-escapes the literal text of the
 * token clicked on the page, for pasting into the `sectionHeader`/
 * `terminateSectionBefore` fields — the only two fields in this file that
 * have ever used regex-escaping of a click (`labelledPairs` labels are
 * matched by EXACT string equality, not regex; `valuePattern` is typed in
 * manually) — so the name `escapeRegexLiteral` was misleadingly generic.
 *
 * [Bug measured live, p. 23 "Call of Cthulhu 7ed. Wrak.pdf"] A section
 * heading/boundary from a CLICK on ONE occurrence ("Skills", no colon for
 * Calhoun) didn't match THE SAME heading on a SECOND occurrence in the same
 * book ("Skills:", a colon appended by pdf.js for Hansen) — the previous
 * version required EXACTLY the text under the click, so the regex from the
 * first occurrence never closed the section of the second. Effect measured
 * directly: Hansen's "Combat" section (with no working boundary of its own
 * and no third entity on the page that would give a hardStop) read ALL THE
 * WAY TO THE END OF THAT PAGE'S STREAM, including the entire right column —
 * whose tokens, in column-stream order, HAVE THEIR Y RESET TO THE TOP OF THE
 * PAGE, so the resulting (excessively wide) section bbox stretched across
 * ALMOST THE ENTIRE HEIGHT of the page and geometrically overlapped
 * Calhoun's regions (report #2). This same side effect falsely "stole"
 * (global nearest-match, `entityAssembly.ts`) Calhoun's valid Skills
 * candidate, giving the misleading message "87pt > 400pt" (report #1) even
 * though 87 < 400 — because that candidate wasn't "out of range" at all, it
 * had been SEIZED by a different anchor (see `AttachDiagnosticResult`,
 * `entityAssembly.ts`).
 *
 * Fix: a trailing colon on the clicked text becomes OPTIONAL in the
 * generated regex (`:?` instead of requiring exactly what was under the
 * token) — works regardless of WHICH occurrence the author clicked.
 */
export function escapeSectionBoundaryLiteral(text: string): string {
  const withoutTrailingColon = text.replace(/:+$/, '');
  const escaped = withoutTrailingColon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}:?$`;
}
