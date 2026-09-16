import type { ProfileV2 } from '../profiles/schema.js';
import type { ContentKind, SystemAdapter } from './adapter.js';

/**
 * [KROK-19 Z2] Mechanizm zgodnosci profil<->system aktywnego swiata —
 * dokladnie MDD §6.5. Odpowiada na pytanie "co sie dzieje, gdy PDF CoC trafi
 * do swiata WFRP". CELOWO nie zawiera D2 (scoreProfile) ani D3 (detekcja
 * jezyka) — `resolve` przyjmuje juz gotowy wynik detekcji (`Detection`); SAM
 * scoring/detekcja jezyka to osobny, wiekszy zakres (rejestr profili +
 * wczytywanie ich w `packages/module`), poza tym krokiem, ktorego celem jest
 * WYLACZNIE dostarczenie adaptera jako warunku pomiaru B'/A (patrz
 * KROK-19-adapter-coc7.md).
 *
 * Pure function — zero odwolan do `game`/Foundry (A1): aktywny system
 * (`activeSystemId`/`activeSystemVersion`) przychodzi jako PARAMETR, nie jako
 * odczyt globalnego `game.system`. Warstwa modulu (Foundry-specyficzna)
 * dostarcza te wartosci wolajac `resolve(det, adapters, game.system.id,
 * game.system.version)`.
 */

/** Tresci systemowo neutralne — ZAWSZE dozwolone, niezaleznie od wyniku dopasowania (MDD §6.5). */
export const NEUTRAL_CONTENT_KINDS: readonly ContentKind[] = ['journals', 'scenes', 'images'];

export interface ScoredProfile {
  profile: ProfileV2;
  score: number;
}

/**
 * Wynik detekcji profilu (D2, poza zakresem tego pliku — patrz komentarz
 * powyzej). Zdefiniowany tutaj wylacznie jako typ WEJSCIOWY dla `resolve`.
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
       * [KROK-19 Z2, luka wobec MDD] Tylko dla `reason: 'version-mismatch'`.
       * MDD §6.5 nie niesie tej wartosci w typie `Resolution`, ale §6.8
       * wymaga jej w komunikacie ("Adapter wymaga systemu X w wersji Y") —
       * bez niej baner nie da rady wyswietlic wlasnej tresci z wlasnej
       * specyfikacji. Dodane tutaj zamiast zgadywac/pomijac w UI.
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
 * Bardzo uproszczone sprawdzenie zakresu semver ("*", ">=X.Y.Z", "*.*.* <A.B.C"
 * itp.) — wystarczajace dla porownan `>=` uzywanych przez adaptery w tym
 * projekcie (patrz `coc7Adapter.systemVersion`). NIE jest pelnym parserem
 * semver-range (biblioteka `semver` z przykladu MDD nie jest zaleznoscia
 * `packages/core` — dokladac ja tylko dla jednego porownania byloby
 * nieproporcjonalne).
 */
function satisfiesVersionRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return true;
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) return true; // zakres nierozpoznany -> nie blokuj na tym, czego nie umiemy sparsowac
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
