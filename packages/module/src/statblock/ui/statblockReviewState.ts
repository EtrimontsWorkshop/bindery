import { buildPagesForDetection, detectStatblocks, findNearestImage, validateProfile, type CIFImage, type DetectionCandidate, type ImageCandidate, type ImportReport, type StatblockProfile } from '@bindery/core';
import { ASSET_BASE_URL } from '../../settings.js';
import { importStatblocks } from '../import/importStatblocks.js';
import { listProfiles } from '../profile/store.js';

export type DuplicatePolicy = 'skip' | 'overwrite' | 'copy';

interface Row {
  id: string;
  pageNumber: number;
  snippet: string;
  confidencePercent: number;
  include: boolean;
  /** The CIF image chosen for this statblock ('' = none). */
  imageId: string;
}

/**
 * State behind the review screen's "Statblocks" tab: which profile is used,
 * which statblocks it found in the open PDF, which of them to import and with
 * which picture. Holds no UI — `ReviewScreen` renders it and calls `run`
 * together with its own image import, so a picture chosen here is uploaded
 * once and shared with the Actor's portrait and token. Loaded lazily (risk
 * I3/`check:size`).
 */
export class StatblockReviewState {
  readonly #fileBuffer: ArrayBuffer;
  readonly #images: readonly CIFImage[];
  readonly #onChange: () => void;

  profiles: StatblockProfile[] = listProfiles();
  selectedProfileId = '';
  policy: DuplicatePolicy = 'skip';
  busy = false;
  issues: string[] = [];
  rows: Row[] | null = null;

  #pages: Awaited<ReturnType<typeof buildPagesForDetection>> | null = null;
  #profile: StatblockProfile | null = null;
  #candidates = new Map<string, DetectionCandidate>();

  constructor(fileBuffer: ArrayBuffer, images: readonly CIFImage[], onChange: () => void) {
    this.#fileBuffer = fileBuffer;
    this.#images = images;
    this.#onChange = onChange;
  }

  /** One saved profile is the common case — pick it and look for statblocks straight away. */
  async init(): Promise<void> {
    if (this.profiles.length === 1) await this.selectProfile(this.profiles[0]!.id);
  }

  get includedCount(): number {
    return this.rows?.filter((r) => r.include).length ?? 0;
  }

  async selectProfile(profileId: string): Promise<void> {
    this.selectedProfileId = profileId;
    this.rows = null;
    this.issues = [];
    this.#candidates.clear();
    this.#profile = null;
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) {
      this.#onChange();
      return;
    }
    const validation = validateProfile(profile);
    if (!validation.ok) {
      this.issues = [...validation.issues];
      this.#onChange();
      return;
    }
    this.#profile = validation.profile;
    this.busy = true;
    this.#onChange();
    try {
      this.#pages ??= await buildPagesForDetection(this.#fileBuffer, { assetBaseUrl: ASSET_BASE_URL });
      const candidates = detectStatblocks(this.#pages, validation.profile);
      const imageCandidates: ImageCandidate[] = this.#images.map((i) => ({ id: i.id, pageNumber: i.provenance.pageNumber, bbox: i.provenance.bbox }));
      this.rows = candidates.map((c) => {
        this.#candidates.set(c.id, c);
        return {
          id: c.id,
          pageNumber: c.regions[0]?.pageNumber ?? 0,
          snippet: c.elements[0]?.text ?? '',
          confidencePercent: Math.round(c.confidence * 100),
          include: true,
          // The picture nearest to where the statblock starts is the usual portrait — preselected, changeable.
          imageId: findNearestImage(c.regions, imageCandidates) ?? '',
        };
      });
    } catch (err) {
      console.warn('Bindery | statblock detection failed:', err);
      this.issues = [String(err)];
    } finally {
      this.busy = false;
      this.#onChange();
    }
  }

  setInclude(rowId: string, include: boolean): void {
    const row = this.rows?.find((r) => r.id === rowId);
    if (row) row.include = include;
  }

  setImage(rowId: string, imageId: string): void {
    const row = this.rows?.find((r) => r.id === rowId);
    if (row) row.imageId = imageId;
  }

  /** The pictures offered for one statblock: those found on the page(s) it spans. */
  #imageOptionsFor(row: Row, noneLabel: string): Array<{ id: string; label: string; selected: boolean }> {
    const pages = new Set(this.#candidates.get(row.id)?.regions.map((r) => r.pageNumber) ?? [row.pageNumber]);
    const options = this.#images
      .filter((i) => pages.has(i.provenance.pageNumber) || i.id === row.imageId)
      .map((i) => ({ id: i.id, label: `${game.i18n!.localize('BINDERY.statblockImport.pageAbbrev')} ${i.provenance.pageNumber} · ${i.caption?.trim() || i.id}`, selected: i.id === row.imageId }));
    return [{ id: '', label: noneLabel, selected: row.imageId === '' }, ...options];
  }

  describe(thumbnailFor: (imageId: string) => string | null): Record<string, unknown> {
    const i18n = game.i18n!;
    const noneLabel = i18n.localize('BINDERY.statblockImport.noImage');
    return {
      hasProfiles: this.profiles.length > 0,
      profileOptions: this.profiles.map((p) => ({ id: p.id, name: p.name, isSelected: p.id === this.selectedProfileId })),
      busy: this.busy,
      issues: this.issues,
      hasIssues: this.issues.length > 0,
      noneFound: this.rows !== null && this.rows.length === 0,
      hasRows: (this.rows?.length ?? 0) > 0,
      foundSummary: i18n.format('BINDERY.statblockImport.foundCount', { count: String(this.rows?.length ?? 0) }),
      policyIsSkip: this.policy === 'skip',
      policyIsOverwrite: this.policy === 'overwrite',
      policyIsCopy: this.policy === 'copy',
      rows: (this.rows ?? []).map((r) => ({
        id: r.id,
        page: r.pageNumber,
        snippet: r.snippet,
        confidencePercent: r.confidencePercent,
        include: r.include,
        thumbUrl: r.imageId ? thumbnailFor(r.imageId) : null,
        imageOptions: this.#imageOptionsFor(r, noneLabel),
      })),
    };
  }

  /** Imports the statblocks ticked in the tab. `resolveImagePath` turns a chosen CIF image id into an uploaded file path (the caller owns uploading, so a picture shared with the image import is uploaded once). */
  async run(resolveImagePath: (imageId: string) => Promise<string | undefined>): Promise<ImportReport | null> {
    const profile = this.#profile;
    const included = (this.rows ?? []).filter((r) => r.include);
    if (!profile || included.length === 0) return null;
    const imageByCandidate = new Map(included.map((r) => [r.id, r.imageId]));
    const candidates = included.map((r) => this.#candidates.get(r.id)).filter((c): c is DetectionCandidate => c !== undefined);
    return importStatblocks(profile, candidates, {
      duplicatePolicy: this.policy,
      resolveImagePath: async (candidateId) => {
        const imageId = imageByCandidate.get(candidateId);
        return imageId ? resolveImagePath(imageId) : undefined;
      },
    });
  }
}
