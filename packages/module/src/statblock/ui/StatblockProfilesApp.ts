import type { StatblockProfile } from '@bindery/core';
import { deleteProfile, exportProfile, importProfileFromFile, listProfiles } from '../profile/store.js';

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The window listing the statblock profiles stored in this world: what each one is (name, Actor type, how much it maps) plus import from / export to a `.json` file and delete. Profiles are executed by the review screen's Statblocks tab; this window only manages the collection and never edits a profile.
 */
export class StatblockProfilesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-statblock-profiles',
    classes: ['bindery', 'bindery-profiles-app'],
    window: {
      title: 'BINDERY.statblockProfiles.title',
      resizable: true,
      icon: 'fa-solid fa-dragon',
    },
    position: { width: 640, height: 'auto' as const },
    actions: {
      importProfile: StatblockProfilesApp.#onImport,
      exportProfile: StatblockProfilesApp.#onExport,
      deleteProfile: StatblockProfilesApp.#onDelete,
    },
  };

  static override PARTS = {
    main: { template: 'modules/bindery-pdf-importer/templates/statblock-profiles.hbs' },
  };

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const profiles = listProfiles().map((p: StatblockProfile) => ({
      id: p.id,
      name: p.name,
      actorType: p.actorType,
      language: p.language ?? '',
      fieldCount: p.fields.length,
      collectionCount: p.collections.length,
    }));
    return { profiles, hasProfiles: profiles.length > 0 };
  }

  static #onImport(this: StatblockProfilesApp): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        const result = await importProfileFromFile(file);
        if (!result.ok) {
          ui.notifications?.error(`${game.i18n!.localize('BINDERY.statblockProfiles.importFailed')} ${result.issues.join('; ')}`);
          return;
        }
        const key = result.replaced ? 'BINDERY.statblockProfiles.importReplaced' : 'BINDERY.statblockProfiles.importDone';
        ui.notifications?.info(game.i18n!.format(key, { name: result.profile.name }));
        await this.render();
      })();
    });
    input.click();
  }

  static #onExport(this: StatblockProfilesApp, _ev: PointerEvent, target: HTMLElement): void {
    exportProfile(target.dataset['id']!);
  }

  static #onDelete(this: StatblockProfilesApp, _ev: PointerEvent, target: HTMLElement): void {
    void (async () => {
      const confirmed = await DialogV2.confirm({
        window: { title: 'BINDERY.statblockProfiles.confirmDeleteTitle' },
        content: `<p>${game.i18n!.localize('BINDERY.statblockProfiles.confirmDeleteBody')}</p>`,
      });
      if (!confirmed) return;
      await deleteProfile(target.dataset['id']!);
      await this.render();
    })();
  }
}
