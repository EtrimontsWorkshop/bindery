import type { ProfileV2 } from '../profiles/schema.js';
import type { ContentKind, SystemAdapter } from './adapter.js';

/**
 * [Step 19 Z2] The profile<->active-world-system compatibility mechanism —
 * exactly MDD §6.5. Answers the question "what happens when a CoC PDF ends
 * up in a WFRP world". DELIBERATELY does not include D2 (scoreProfile) or
 * D3 (language detection) — `resolve` already receives a ready detection
 * result (`Detection`); scoring/language detection ITSELF is a separate,
 * larger scope (profile registry + loading them in `packages/module`),
 * outside this step, whose goal is ONLY to deliver the adapter as a
 * precondition for the B'/A measurement (see KROK-19-adapter-coc7.md).
 *
 * A pure function — zero references to `game`/Foundry (A1): the active
 * system (`activeSystemId`/`activeSystemVersion`) comes in as a PARAMETER,
 * not as a read of the global `game.system`. The module layer
 * (Foundry-specific) supplies these values by calling `resolve(det,
 * adapters, game.system.id, game.system.version)`.
 */

/** System-neutral content — ALWAYS allowed, regardless of the matching result (MDD §6.5). */
export const NEUTRAL_CONTENT_KINDS: readonly ContentKind[] = ['journals', 'scenes', 'images'];

export interface ScoredProfile {
  profile: ProfileV2;
  score: number;
}

/**
 * Result of profile detection (D2, outside the scope of this file — see
 * the comment above). Defined here only as the INPUT type for `resolve`.
 */
export type Detection =
  | { kind: 'confident'; profile: ProfileV2; score: number }
  | { kind: 'ambiguous'; candidates: readonly ScoredProfile[] }
  | { kind: 'none'; scored: readonly ScoredProfile[] };

export type ResolutionReason = 'line-mismatch' | 'no-adapter' | 'version-mismatch' | 'no-text-layer';

export type Resolution =
  | { kind: 'full'; profile: ProfileV2; adapter: SystemAdapter; allowed: readonly ContentKind[] }
  | {
      kind: 'partial';
      profile: ProfileV2;
      allowed: readonly ContentKind[];
      blocked: readonly ContentKind[];
      reason: ResolutionReason;
      /**
       * [Step 19 Z2, gap relative to MDD] Only for `reason:
       * 'version-mismatch'`. MDD §6.5 does not carry this value in the
       * `Resolution` type, but §6.8 requires it in the message ("Adapter
       * requires system X in version Y") — without it the banner cannot
       * display its own content from its own spec. Added here instead of
       * guessing/omitting it in the UI.
       */
      requiredVersion?: string;
    }
  | { kind: 'generic'; allowed: readonly ContentKind[] }
  | { kind: 'ambiguous'; candidates: readonly ProfileV2[] };

function intersectContentKinds(a: readonly ContentKind[], b: readonly ContentKind[]): ContentKind[] {
  const bSet = new Set(b);
  return a.filter((k) => bSet.has(k));
}

/**
 * A very simplified semver range check ("*", ">=X.Y.Z", "*.*.* <A.B.C" etc.)
 * — sufficient for the `>=` comparisons used by the adapters in this
 * project (see `coc7Adapter.systemVersion`). NOT a full semver-range parser
 * (the `semver` library from the MDD example is not a dependency of
 * `packages/core` — adding it just for one comparison would be
 * disproportionate).
 */
function satisfiesVersionRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) return true; // unrecognized range -> don't block on something we can't parse
  const [, reqMajorStr, reqMinorStr, reqPatchStr] = match;
  const reqMajor = Number(reqMajorStr);
  const reqMinor = Number(reqMinorStr);
  const reqPatch = Number(reqPatchStr);
  const versionMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!versionMatch) return false;
  const [, majorStr, minorStr, patchStr] = versionMatch;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);
  if (major !== reqMajor) return major > reqMajor;
  if (minor !== reqMinor) return minor > reqMinor;
  return patch >= reqPatch;
}

export function resolve(det: Detection, adapters: readonly SystemAdapter[], activeSystemId: string, activeSystemVersion: string): Resolution {
  if (det.kind === 'ambiguous') {
    return { kind: 'ambiguous', candidates: det.candidates.slice(0, 3).map((c) => c.profile) };
  }

  if (det.kind === 'none') {
    return { kind: 'generic', allowed: NEUTRAL_CONTENT_KINDS };
  }

  const profile = det.profile;
  const forSystem = adapters.filter((a) => a.systemId === activeSystemId);

  if (forSystem.length === 0) {
    return { kind: 'partial', profile, allowed: NEUTRAL_CONTENT_KINDS, blocked: ['actors', 'items'], reason: 'no-adapter' };
  }

  const match = forSystem.find((a) => a.accepts.includes(profile.gameLine)) ?? forSystem.find((a) => a.accepts.includes('*'));

  if (!match) {
    return { kind: 'partial', profile, allowed: NEUTRAL_CONTENT_KINDS, blocked: ['actors', 'items'], reason: 'line-mismatch' };
  }

  if (!satisfiesVersionRange(activeSystemVersion, match.systemVersion)) {
    return {
      kind: 'partial',
      profile,
      allowed: NEUTRAL_CONTENT_KINDS,
      blocked: ['actors', 'items'],
      reason: 'version-mismatch',
      requiredVersion: match.systemVersion,
    };
  }

  return {
    kind: 'full',
    profile,
    adapter: match,
    allowed: intersectContentKinds(profile.provides as ContentKind[], [...match.produces, ...NEUTRAL_CONTENT_KINDS]),
  };
}
