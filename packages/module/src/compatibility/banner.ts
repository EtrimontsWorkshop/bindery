import type { Resolution } from '@bindery/core';

/**
 * [KROK-19 Z2] Baner niezgodnosci — MDD §6.8. Wymaganie: baner W OKNIE, nie
 * `ui.notifications` (ktore znika po 5s — niezgodnosc to stan trwaly).
 *
 * Ta funkcja jest CZYSTA (zero `game.i18n`/Foundry) tak, zeby dalo sie ja
 * zweryfikowac skryptem w Node, tak jak `coc7Adapter.fromActor` (Z1) —
 * zwraca klucze i18n + parametry, NIE gotowy tekst. Warstwa renderujaca
 * (szablon/`_prepareContext` w ApplicationV2) wywoluje `game.i18n.format(key,
 * params)` na kazdym polu.
 *
 * Trzy wymagania funkcjonalne z §6.8 sa widoczne w ksztalcie zwracanego
 * viewmodelu:
 * 1. `detected`/`activeSystem` — co wykryto i z jaka pewnoscia.
 * 2. `stillAvailableKey` — czego banner NIE blokuje.
 * 3. `showChangeProfile: true` zawsze (wyjscie awaryjne zawsze dostepne).
 */

export interface CompatibilityBannerContext {
  /** Etykieta wykrytego profilu (np. `profile.title`), do wstawienia w komunikat. */
  detectedProfileLabel: string;
  /** Wynik detekcji profilu, 0..1 — wyswietlany jako procent. */
  detectionScore: number;
  /** Etykieta aktywnego systemu swiata (np. `game.system.title`). */
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
  /** Tylko dla `no-adapter`/`version-mismatch`/`no-text-layer` — akcja naprawcza z tabeli §6.8. */
  actionKey: string | null;
  /** `[Zmień wykryty profil]` — zawsze dostepne przy niezgodnosci (wyjscie awaryjne, wymaganie #3 z §6.8). */
  showChangeProfile: boolean;
  /** `[Importuj pozostałe]` — dostepne, gdy jest cokolwiek neutralnego do zaimportowania. */
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
  // `full`/`generic`/`ambiguous` nie sa niezgodnoscia — `ambiguous` dostaje
  // WLASNY ekran wyboru profilu (poza zakresem tego banera), `full`/`generic`
  // nie blokuja niczego, wiec baner o niezgodnosci by tu wprowadzal w blad.
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
      throw new Error(`Nieznany powod niezgodnosci: ${String(exhaustiveCheck)}`);
    }
  }
}
