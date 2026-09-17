import type { Resolution } from '@bindery/core';

/**
 * [Step 19 Z2] Incompatibility banner — MDD §6.8. Requirement: the banner
 * lives IN THE WINDOW, not in `ui.notifications` (which disappears after 5s
 * — incompatibility is a persistent state).
 *
 * This function is PURE (zero `game.i18n`/Foundry) so that it can be
 * verified with a script in Node, the same way `coc7Adapter.fromActor` (Z1)
 * is — it returns i18n keys + parameters, NOT ready-made text. The
 * rendering layer (the template/`_prepareContext` in ApplicationV2) calls
 * `game.i18n.format(key, params)` on each field.
 *
 * Three functional requirements from §6.8 are visible in the shape of the
 * returned viewmodel:
 * 1. `detected`/`activeSystem` — what was detected and with what confidence.
 * 2. `stillAvailableKey` — what the banner does NOT block.
 * 3. `showChangeProfile: true` always (an emergency exit is always available).
 */

export interface CompatibilityBannerContext {
  /** Label of the detected profile (e.g. `profile.title`), to insert into the message. */
  detectedProfileLabel: string;
  /** Profile detection score, 0..1 — displayed as a percentage. */
  detectionScore: number;
  /** Label of the world's active system (e.g. `game.system.title`). */
  activeSystemLabel: string;
}

export interface CompatibilityBannerViewModel {
  visible: boolean;
  headingKey: string;
  headingParams: Record<string, string>;
  bodyKey: string;
  bodyParams: Record<string, string>;
  detectedLineKey: string;
  detectedLineParams: Record<string, string>;
  activeSystemKey: string;
  activeSystemParams: Record<string, string>;
  stillAvailableKey: string;
  /** Only for `no-adapter`/`version-mismatch`/`no-text-layer` — the corrective action from the §6.8 table. */
  actionKey: string | null;
  /** `[Change detected profile]` — always available on incompatibility (emergency exit, requirement #3 from §6.8). */
  showChangeProfile: boolean;
  /** `[Import the rest]` — available when there's anything neutral to import. */
  showImportRest: boolean;
}

const HIDDEN: CompatibilityBannerViewModel = {
  visible: false,
  headingKey: '',
  headingParams: {},
  bodyKey: '',
  bodyParams: {},
  detectedLineKey: '',
  detectedLineParams: {},
  activeSystemKey: '',
  activeSystemParams: {},
  stillAvailableKey: '',
  actionKey: null,
  showChangeProfile: false,
  showImportRest: false,
};

export function buildCompatibilityBanner(resolution: Resolution, ctx: CompatibilityBannerContext): CompatibilityBannerViewModel {
  // `full`/`generic`/`ambiguous` are not incompatibility — `ambiguous` gets
  // its OWN profile-selection screen (out of scope for this banner),
  // `full`/`generic` block nothing, so an incompatibility banner here would
  // be misleading.
  if (resolution.kind !== 'partial') return HIDDEN;

  const confidence = String(Math.round(ctx.detectionScore * 100));
  const detectedLineParams = { profile: ctx.detectedProfileLabel, confidence };
  const activeSystemParams = { system: ctx.activeSystemLabel };
  const showImportRest = resolution.allowed.length > 0;

  switch (resolution.reason) {
    case 'line-mismatch':
      return {
        ...HIDDEN,
        visible: true,
        headingKey: 'BINDERY.compatibility.headingLineMismatch',
        headingParams: {},
        bodyKey: 'BINDERY.compatibility.bodyLineMismatch',
        bodyParams: {},
        detectedLineKey: 'BINDERY.compatibility.detectedLine',
        detectedLineParams,
        activeSystemKey: 'BINDERY.compatibility.activeSystem',
        activeSystemParams,
        stillAvailableKey: 'BINDERY.compatibility.stillAvailable',
        actionKey: null,
        showChangeProfile: true,
        showImportRest,
      };
    case 'no-adapter':
      return {
        ...HIDDEN,
        visible: true,
        headingKey: 'BINDERY.compatibility.headingNoAdapter',
        headingParams: activeSystemParams,
        bodyKey: 'BINDERY.compatibility.bodyNoAdapter',
        bodyParams: {},
        detectedLineKey: 'BINDERY.compatibility.detectedLine',
        detectedLineParams,
        activeSystemKey: 'BINDERY.compatibility.activeSystem',
        activeSystemParams,
        stillAvailableKey: 'BINDERY.compatibility.stillAvailable',
        actionKey: 'BINDERY.compatibility.actionNoAdapter',
        showChangeProfile: true,
        showImportRest,
      };
    case 'version-mismatch':
      return {
        ...HIDDEN,
        visible: true,
        headingKey: 'BINDERY.compatibility.headingVersionMismatch',
        headingParams: { ...activeSystemParams, version: resolution.requiredVersion ?? '?' },
        bodyKey: 'BINDERY.compatibility.bodyVersionMismatch',
        bodyParams: {},
        detectedLineKey: 'BINDERY.compatibility.detectedLine',
        detectedLineParams,
        activeSystemKey: 'BINDERY.compatibility.activeSystem',
        activeSystemParams,
        stillAvailableKey: 'BINDERY.compatibility.stillAvailable',
        actionKey: 'BINDERY.compatibility.actionVersionMismatch',
        showChangeProfile: true,
        showImportRest,
      };
    case 'no-text-layer':
      return {
        ...HIDDEN,
        visible: true,
        headingKey: 'BINDERY.compatibility.headingNoTextLayer',
        headingParams: {},
        bodyKey: 'BINDERY.compatibility.bodyNoTextLayer',
        bodyParams: {},
        detectedLineKey: 'BINDERY.compatibility.detectedLine',
        detectedLineParams,
        activeSystemKey: 'BINDERY.compatibility.activeSystem',
        activeSystemParams,
        stillAvailableKey: 'BINDERY.compatibility.stillAvailable',
        actionKey: 'BINDERY.compatibility.actionNoTextLayer',
        showChangeProfile: true,
        showImportRest,
      };
    default: {
      const exhaustiveCheck: never = resolution.reason;
      throw new Error(`Unknown incompatibility reason: ${String(exhaustiveCheck)}`);
    }
  }
}
