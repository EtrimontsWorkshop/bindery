import { formatDiagnostic } from '../../i18n.js';
import { ASSET_BASE_URL } from '../../settings.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoreModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProfile = any;

type DuplicatePolicy = 'skip' | 'overwrite' | 'copy';

export interface StatblockImportInput {
  /** The PDF the Import Wizard already loaded — never asked for again. */
  fileBuffer: ArrayBuffer;
  fileName: string;
}

/**
 * Imports the statblocks of the PDF that is already open in the Import
 * Wizard as Actors, using a profile built in the profile builder. This
 * window only chooses a profile, shows what was found and runs the import —
 * building profiles stays in `ProfileBuilderApp`. Loaded lazily from the
 * wizard (risk I3/`check:size`), like `ReviewScreen`.
 */
export class StatblockImportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-statblock-import',
    classes: ['bindery', 'bindery-statblock-import-app'],
    window: { title: 'BINDERY.statblockImport.title', resizable: true, icon: 'fa-solid fa-dragon' },
    position: { width: 560, height: 600 },
    actions: {
      importStatblocks: StatblockImportApp.#onImport,
    },
  };

  static override PARTS = {
    main: { template: 'modules/bindery-pdf-importer/templates/statblock-import.hbs', scrollable: ['.bindery-si-body'] },
  };

  static async open(input: StatblockImportInput): Promise<StatblockImportApp> {
    const app = new StatblockImportApp(input);
    await app.#loadProfiles();
    await app.render({ force: true });
    // One saved profile is the common case — pick it and look for statblocks straight away.
    if (app.#profiles.length === 1) await app.#selectProfile(app.#profiles[0].id);
    return app;
  }

  readonly #input: StatblockImportInput;
  #profiles: AnyProfile[] = [];
  #selectedProfileId = '';
  #busy: string | null = null;
  #pages: unknown[] | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #candidates: any[] | null = null;
  #issues: string[] = [];
  #policy: DuplicatePolicy = 'skip';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #report: any = null;

  private constructor(input: StatblockImportInput) {
    super();
    this.#input = input;
  }

  async #core(): Promise<CoreModule> {
    return import('@bindery/core');
  }

  async #loadProfiles(): Promise<void> {
    const store = await import('../profile/store.js');
    this.#profiles = store.listProfiles();
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const i18n = game.i18n!;
    const count = this.#candidates?.length ?? 0;
    return {
      fileName: this.#input.fileName,
      hasProfiles: this.#profiles.length > 0,
      profileOptions: this.#profiles.map((p: AnyProfile) => ({ id: p.id, name: p.name, isSelected: p.id === this.#selectedProfileId })),
      hasSelection: this.#selectedProfileId !== '',
      busy: this.#busy,
      issues: this.#issues,
      hasCandidates: count > 0,
      noCandidates: this.#candidates !== null && count === 0,
      foundSummary: i18n.format('BINDERY.statblockImport.foundCount', { count: String(count) }),
      candidates: (this.#candidates ?? []).map((c) => ({
        id: c.id,
        page: c.regions[0]?.pageNumber ?? '?',
        confidencePercent: Math.round(c.confidence * 100),
        snippet: c.elements[0]?.text ?? '',
      })),
      policyIsSkip: this.#policy === 'skip',
      policyIsOverwrite: this.#policy === 'overwrite',
      policyIsCopy: this.#policy === 'copy',
      importButtonLabel: i18n.format('BINDERY.statblockImport.importButton', { count: String(count) }),
      report: this.#describeReport(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const profileSelect = this.element.querySelector<HTMLSelectElement>('select[data-role="profile"]');
    profileSelect?.addEventListener('change', () => void this.#selectProfile(profileSelect.value));
    const policySelect = this.element.querySelector<HTMLSelectElement>('select[data-role="policy"]');
    policySelect?.addEventListener('change', () => {
      this.#policy = policySelect.value as DuplicatePolicy;
    });
  }

  /** Validates the chosen profile and detects its statblocks in the open PDF (the pages are read once and reused if another profile is chosen). */
  async #selectProfile(profileId: string): Promise<void> {
    this.#selectedProfileId = profileId;
    this.#candidates = null;
    this.#report = null;
    this.#issues = [];
    const profile = this.#profiles.find((p: AnyProfile) => p.id === profileId);
    if (!profile) {
      await this.render();
      return;
    }
    const core = await this.#core();
    const validation = core.validateProfile(profile);
    if (!validation.ok) {
      this.#issues = validation.issues;
      await this.render();
      return;
    }
    this.#busy = 'BINDERY.statblockImport.findingStatblocks';
    await this.render();
    try {
      this.#pages ??= await core.buildPagesForDetection(this.#input.fileBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#candidates = core.detectStatblocks(this.#pages, validation.profile);
    } catch (err) {
      console.warn('Bindery | statblock detection failed:', err);
      ui.notifications?.error(game.i18n!.format('BINDERY.statblockImport.failed', { message: String(err) }));
    } finally {
      this.#busy = null;
      await this.render();
    }
  }

  #describeReport(): { summary: string; instances: Array<{ status: string; statusKey: string; actorName: string; pageNumber?: number; messages: string[] }> } | null {
    const report = this.#report;
    if (!report) return null;
    const statusKeys: Record<string, string> = {
      created: 'BINDERY.statblockImport.statusCreated',
      updated: 'BINDERY.statblockImport.statusUpdated',
      skipped: 'BINDERY.statblockImport.statusSkipped',
      error: 'BINDERY.statblockImport.statusError',
    };
    return {
      summary: game.i18n!.format('BINDERY.statblockImport.reportSummary', {
        created: String(report.created),
        updated: String(report.updated),
        skipped: String(report.skipped),
        failed: String(report.failed),
      }),
      instances: report.instances.map((i: { status: string; actorName: string; pageNumber?: number; diagnostics: Parameters<typeof formatDiagnostic>[0][] }) => ({
        status: i.status,
        statusKey: statusKeys[i.status] ?? statusKeys['error']!,
        actorName: i.actorName,
        pageNumber: i.pageNumber,
        messages: i.diagnostics.map((d) => formatDiagnostic(d)),
      })),
    };
  }

  static async #onImport(this: StatblockImportApp): Promise<void> {
    const profile = this.#profiles.find((p: AnyProfile) => p.id === this.#selectedProfileId);
    if (!profile || !this.#candidates?.length) return;
    const i18n = game.i18n!;
    const policyKeys = { skip: 'policySkip', overwrite: 'policyOverwrite', copy: 'policyCopy' } as const;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'BINDERY.statblockImport.confirmTitle' },
      content: `<p>${i18n.format('BINDERY.statblockImport.confirmBody', { count: String(this.#candidates.length), policy: i18n.localize(`BINDERY.statblockImport.${policyKeys[this.#policy]}`) })}</p>`,
    });
    if (!confirmed) return;

    this.#busy = 'BINDERY.statblockImport.importing';
    this.#report = null;
    await this.render();
    try {
      const { importStatblocks } = await import('../import/importStatblocks.js');
      this.#report = await importStatblocks(profile, this.#candidates, { duplicatePolicy: this.#policy });
    } catch (err) {
      ui.notifications?.error(i18n.format('BINDERY.statblockImport.failed', { message: String(err) }));
    } finally {
      this.#busy = null;
      await this.render();
    }
  }
}
