import { ImportWizard } from './apps/ImportWizard.js';
import { ProfileStudioLauncher } from './apps/ProfileStudioLauncher.js';
import { STATBLOCKS_ENABLED } from './features.js';

export const MODULE_ID = 'bindery';

/** Base path of pdf.js assets relative to the Foundry web server root (risk I1/I3). */
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

  // [Step 22 Z1] Profile Studio — a button NEXT TO "Import PDF..." (brief:
  // "the Studio is a different mode of work, for a different person, at a
  // different time"). `type` points to the thin `ProfileStudioLauncher`, NOT
  // the real `ProfileStudio` — see the comment in `ProfileStudioLauncher.ts`
  // (I3, the <40KB world-startup budget).
  //
  // [Step 44 Z1] Hidden behind `STATBLOCKS_ENABLED` — see `features.ts` for
  // the rationale and the restore condition. The menu entry simply isn't
  // registered when the flag is off — Foundry doesn't show it at all in the
  // module settings, zero dead button.
  if (STATBLOCKS_ENABLED) {
    game.settings!.registerMenu(MODULE_ID, 'openProfileStudio', {
      name: 'BINDERY.settings.openProfileStudioMenuLabel',
      hint: 'BINDERY.settings.openProfileStudioMenuHint',
      label: 'BINDERY.settings.openProfileStudioMenuLabel',
      icon: 'fa-solid fa-flask',
      type: ProfileStudioLauncher,
      restricted: true,
    });
  }

  // Consent from the legal notice, §2.2 MDD — saved once per world.
  game.settings!.register(MODULE_ID, 'legalNoticeAcknowledged', {
    name: 'Legal notice acknowledged',
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  });

  // [Step 8 Z4] The folder in the configured storage source (default 'data')
  // where exported images go — configurable, because worlds differ in
  // directory conventions (and because R6/A1: this is ONLY a save location,
  // no decision logic).
  game.settings!.register(MODULE_ID, 'uploadPath', {
    name: 'BINDERY.settings.uploadPathLabel',
    hint: 'BINDERY.settings.uploadPathHint',
    scope: 'world',
    config: true,
    type: String,
    default: `worlds/${game.world?.id ?? 'world'}/bindery-imports`,
  });

  // [Step 8 Z5] The most recently used grid setting (GridPicker) —
  // remembered per world, not shown in the settings screen (the user
  // changes it ONLY through GridPicker itself).
  game.settings!.register(MODULE_ID, 'lastGridConfig', {
    name: 'Last grid config',
    scope: 'world',
    config: false,
    type: Object,
    default: { size: 100, offsetX: 0, offsetY: 0 },
  });

  // [Step 11 Z6] Target folders + name prefix from the target screen —
  // remembered per world (brief: "settings remembered per world"), NOT
  // shown in the settings screen (the user changes them ONLY through the
  // target screen itself), the same pattern as `lastGridConfig`.
  // `imagePath` does NOT duplicate `uploadPath` above — the target screen
  // edits/shows THAT SAME value (`uploadPath` is already per-world,
  // config:true, set since step 8).
  game.settings!.register(MODULE_ID, 'importTargets', {
    name: 'Import target folders',
    scope: 'world',
    config: false,
    // [Step 19 Z3] `actorFolder` added to THIS SAME object (not a separate
    // `game.settings` key) — the same pattern as `sceneFolder`/`journalFolder`
    // above, so the target screen (once it gets an actors tab) can
    // read/write all folders with one `.get`/`.set` call.
    default: { sceneFolder: '', journalFolder: '', actorFolder: '', namePrefix: '' },
  });

  // [Step 21 Z1] The most recently loaded actor profile (a JSON file chosen
  // in ImportWizard) — remembered PER WORLD, so it doesn't need to be
  // selected again on every import. Stores the RAW (not yet validated on
  // read) file content + its name for display — validation
  // (`validateProfile`) runs AGAIN on every read in `ImportWizard`, never
  // trusted without checking (the same requirement as on first load —
  // profiles come from unknown authors, R2/schema.ts).
  // `config:false` — like `lastGridConfig`/`importTargets`, the user changes
  // this ONLY through ImportWizard itself, not through the settings screen.
  //
  // [R3] This field stores CONTENT supplied by the USER, in their OWN
  // Foundry world (their server's database) — not in this repository and
  // not hosted by this project for others. Analogous to saving an image or
  // actor imported from that same file; R3 applies to THIS repo, not to the
  // user's world data.
  //
  // [measured directly in step 21] DELIBERATELY without `type: Object` —
  // with it, `ClientSettings.register` (the `fvtt-types` types) throws
  // `Type 'ObjectConstructor' is not assignable to type 'undefined'` for
  // THIS particular entry (narrowed down by bisection: disappears when
  // `type` is removed, comes back regardless of the key's name or the
  // interface's shape — looks like a generic-inference limit on the
  // third-or-later Object-typed setting in the same module, not a bug in
  // this code). `default` alone is enough for Foundry to infer the type.
  game.settings!.register(MODULE_ID, 'lastActorProfile', {
    name: 'Last loaded actor profile',
    scope: 'world',
    config: false,
    default: { fileName: '', profile: null },
  });

  // [Set as default] The starting values for the token-preparation panel,
  // most recently saved by the user (the "Set as default" button in
  // TokenPrepApp) — remembered PER WORLD, so preparing many tokens in a row
  // (e.g. a whole group of NPCs from one rulebook) doesn't require repeating
  // the same clicks every time. `enabled:false` (the initial value) = the
  // user has never clicked the button yet — TokenPrepApp then uses its own
  // built-in initial values, exactly as before (including
  // `images.removeTokenBackgroundDefault` from the profile). When
  // `enabled:true`, these values OVERRIDE even the profile's suggestion —
  // this is an explicit, deliberate decision via the button, not a default
  // heuristic. `config:false` — like `lastGridConfig` above, changed ONLY by
  // TokenPrepApp itself, never through the settings screen.
  //
  // No explicit `type: Object` — same reason as `lastActorProfile` above
  // (the fvtt-types generic-inference limit on the third-or-later
  // Object-typed setting in the same module; `lastGridConfig`/`importTargets`
  // above already take up the first two slots) — `default` alone is enough.
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
}

/** Shape of `lastActorProfile` — see the comment at its registration above. `fileName === ''` = no remembered profile. */
export interface LastActorProfile {
  fileName: string;
  /** Raw JSON from the file, not yet validated — validated on every read. `null` when `fileName === ''`. */
  profile: unknown;
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
  /** [Step 19 Z3] `Actor` folder name — empty = root. */
  actorFolder: string;
  /** Optional name prefix for created documents (scenes/journals/actors) — empty = no prefix. */
  namePrefix: string;
}
