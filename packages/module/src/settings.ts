import type { StatblockProfile } from '@bindery/core';
import { ImportWizard } from './apps/ImportWizard.js';
import { STATBLOCK_IMPORT_ENABLED } from './statblock/enabled.js';
import { StatblockProfilesLauncher } from './statblock/ui/StatblockProfilesLauncher.js';

// The module id — the folder name under `Data/modules/`, the namespace of every
// setting and the base of every asset path. It must stay unique among Foundry
// packages. Besides this constant it is spelled out in the apps' template paths
// (`modules/<id>/templates/...`) and in `global.d.ts`; `npm run check:manifest`
// verifies that all of them match `module.json`.
export const MODULE_ID = 'bindery-pdf-importer';

/** Base path of pdf.js assets relative to the Foundry web server root (I3). */
export const ASSET_BASE_URL = `modules/${MODULE_ID}/lib/`;

export function registerSettings(): void {
  // Called in the 'init' hook — game.settings is already initialized at this point
  // in Foundry's lifecycle, even though the 'game' type allows for a pre-init state.
  game.settings!.registerMenu(MODULE_ID, 'openWizard', {
    name: 'BINDERY.settings.openWizardMenuLabel',
    hint: 'BINDERY.settings.openWizardMenuHint',
    label: 'BINDERY.settings.openWizardMenuLabel',
    icon: 'fa-solid fa-file-import',
    type: ImportWizard,
    restricted: true,
  });

  // The statblock-profiles window (list, import, export, delete) — same
  // menu-button pattern as `openWizard` above.
  if (STATBLOCK_IMPORT_ENABLED) {
    game.settings!.registerMenu(MODULE_ID, 'openStatblockProfiles', {
      name: 'BINDERY.statblockProfiles.openMenuLabel',
      hint: 'BINDERY.statblockProfiles.openMenuHint',
      label: 'BINDERY.statblockProfiles.openMenuLabel',
      icon: 'fa-solid fa-dragon',
      type: StatblockProfilesLauncher,
      restricted: true,
    });
  }

  // Consent from the legal notice — saved once per world.
  game.settings!.register(MODULE_ID, 'legalNoticeAcknowledged', {
    name: 'Legal notice acknowledged',
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  });

  // The folder in the configured storage source (default 'data')
  // where exported images go — configurable, because worlds differ in
  // directory conventions (and because this is ONLY a save location,
  // no decision logic).
  game.settings!.register(MODULE_ID, 'uploadPath', {
    name: 'BINDERY.settings.uploadPathLabel',
    hint: 'BINDERY.settings.uploadPathHint',
    scope: 'world',
    config: true,
    type: String,
    default: `worlds/${game.world?.id ?? 'world'}/bindery-imports`,
  });

  // The most recently used grid setting (GridPicker) —
  // remembered per world, not shown in the settings screen (the user
  // changes it ONLY through GridPicker itself).
  game.settings!.register(MODULE_ID, 'lastGridConfig', {
    name: 'Last grid config',
    scope: 'world',
    config: false,
    type: Object,
    default: { size: 100, offsetX: 0, offsetY: 0 },
  });

  // Target folders + name prefix from the target screen —
  // remembered per world, NOT
  // shown in the settings screen (the user changes them ONLY through the
  // target screen itself), the same pattern as `lastGridConfig`.
  // `imagePath` does NOT duplicate `uploadPath` above — the target screen
  // edits/shows THAT SAME value (`uploadPath` is already per-world,
  // config:true).
  game.settings!.register(MODULE_ID, 'importTargets', {
    name: 'Import target folders',
    scope: 'world',
    config: false,
    default: { sceneFolder: '', journalFolder: '', namePrefix: '' },
  });

  // [Set as default] The starting values for the token-preparation panel,
  // most recently saved by the user (the "Set as default" button in
  // TokenPrepApp) — remembered PER WORLD, so preparing many tokens in a row
  // (e.g. a whole group of NPCs from one rulebook) doesn't require repeating
  // the same clicks every time. `enabled:false` (the initial value) = the
  // user has never clicked the button yet — TokenPrepApp then uses its own
  // built-in initial values. When `enabled:true`, these values OVERRIDE that
  // default — this is an explicit, deliberate decision via the button, not
  // a default heuristic. `config:false` — like `lastGridConfig` above,
  // changed ONLY by TokenPrepApp itself, never through the settings screen.
  //
  // No explicit `type: Object` — the fvtt-types generic-inference limit on
  // the third-or-later Object-typed setting in the same module
  // (`lastGridConfig`/`importTargets` above already take up the first two
  // slots) — `default` alone is enough.
  game.settings!.register(MODULE_ID, 'tokenPrepDefaults', {
    name: 'Token preparation defaults',
    scope: 'world',
    config: false,
    default: {
      enabled: false,
      shape: 'circle',
      removeBackground: false,
      // Source of truth: DEFAULT_REMOVE_BACKGROUND.tolerance in
      // packages/core/src/images/removeBackground.ts (not imported here —
      // world-startup budget, see the header of TokenPrepApp.ts).
      removeBackgroundTolerance: 10,
      frame: 'none',
      // Source of truth: DEFAULT_FRAME_COLOR in TokenPrepApp.ts.
      frameColor: '#8a6d3b',
      frameCustomImage: null,
      outputSize: 512,
      format: 'webp',
    } satisfies TokenPrepDefaults,
  });

  // All statblock profiles the user has built in
  // this world, keyed by `StatblockProfile.id` — one setting holding the
  // whole collection (not one setting per profile), so CRUD is a single
  // `get`/`set` round-trip. `config:false` — like the settings above,
  // changed ONLY through the profiles window and the public API
  // (`statblock/api.ts`), never the settings screen. No explicit `type: Object` — same fvtt-types
  // generic-inference limit noted at `tokenPrepDefaults` above.
  game.settings!.register(MODULE_ID, 'statblockProfiles', {
    name: 'Statblock import profiles',
    scope: 'world',
    config: false,
    default: {} as Record<string, StatblockProfile>,
  });
}

/** Shape of `tokenPrepDefaults` — see the comment at its registration above. */
export interface TokenPrepDefaults {
  /** `false` = the user has never clicked "Set as default", the other fields are ignored. */
  enabled: boolean;
  shape: string;
  removeBackground: boolean;
  removeBackgroundTolerance: number;
  frame: string;
  frameColor: string;
  /** Base64 of the uploaded custom frame's bytes (only when `frame === 'custom'`), `null` when there is none. */
  frameCustomImage: string | null;
  outputSize: number;
  format: string;
}

/** Shape of `importTargets` — see the comment at its registration above. */
export interface ImportTargets {
  /** `Scene` folder name (Foundry `Folder.name`, created if it doesn't exist) — empty = root. */
  sceneFolder: string;
  /** `JournalEntry` folder name — empty = root. */
  journalFolder: string;
  /** Optional name prefix for created documents (scenes/journals) — empty = no prefix. */
  namePrefix: string;
}
