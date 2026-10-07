import type { Diagnostic, StatblockProfile } from '@bindery/core';
import { formatDiagnostic } from '../i18n.js';
import { ASSET_BASE_URL } from '../settings.js';

type Core = typeof import('@bindery/core');

/**
 * The pure (Foundry-free) statblock engine functions a separate authoring module needs to test and preview a profile against a PDF. An explicit list rather than the whole core package, so what other modules may rely on is a deliberate contract.
 */
export type StatblockEngine = Pick<
  Core,
  | 'STATBLOCK_PROFILE_SCHEMA_VERSION'
  | 'validateProfile'
  | 'computeSchemaFingerprint'
  | 'openPreviewDocument'
  | 'pdfRectToScreen'
  | 'screenRectToPdf'
  | 'buildPagesForDetection'
  | 'detectStatblocks'
  | 'extractField'
  | 'reconstructLines'
  | 'resolveTransformChain'
>;

export type SaveProfileResult = { ok: true; profile: StatblockProfile } | { ok: false; issues: readonly string[] };

type IntrospectInstance = typeof import('./schema/introspectActor.js').introspectDocumentInstance;

/**
 * Public contract for statblock profiles, available as `game.modules.get('bindery-pdf-importer').api.statblock` while profile-based statblock import is switched on. Everything needed to RUN a profile lives in Bindery; this surface lets another module author profiles without duplicating any of it.
 *
 * Every method that touches `@bindery/core` loads it lazily, so reading the property costs nothing at world startup.
 */
export interface StatblockAPI {
  /** Bumped when this contract changes in a way that breaks callers. */
  readonly contractVersion: 1;

  /** Foundry-relative folder holding the pdf.js assets — pass it as `assetBaseUrl` to the engine's PDF-opening functions. */
  readonly assetBaseUrl: string;

  /** Turns an engine `Diagnostic` into a localized, human-readable line. */
  formatDiagnostic(diagnostic: Diagnostic): string;

  readonly profiles: {
    /** Every stored profile that currently passes migration and validation. */
    list(): Promise<StatblockProfile[]>;
    get(id: string): Promise<StatblockProfile | undefined>;
    /** Migrates and validates untrusted data first; nothing invalid is ever stored. An existing profile with the same id is replaced. */
    save(raw: unknown): Promise<SaveProfileResult>;
    remove(id: string): Promise<void>;
    /** Downloads the profile as a standalone `.json` file. */
    exportToFile(id: string): Promise<void>;
  };

  readonly schema: {
    /** Describes the fields of an Actor or Item the way profile mapping needs them (paths, kinds, labels, rich-text flags). */
    introspectInstance: (...args: Parameters<IntrospectInstance>) => Promise<ReturnType<IntrospectInstance>>;
  };

  /** The pure engine behind detection, extraction and validation — see {@link StatblockEngine}. */
  engine(): Promise<StatblockEngine>;
}

const ENGINE_EXPORTS = [
  'STATBLOCK_PROFILE_SCHEMA_VERSION',
  'validateProfile',
  'computeSchemaFingerprint',
  'openPreviewDocument',
  'pdfRectToScreen',
  'screenRectToPdf',
  'buildPagesForDetection',
  'detectStatblocks',
  'extractField',
  'reconstructLines',
  'resolveTransformChain',
] as const satisfies readonly (keyof StatblockEngine)[];

export function buildStatblockAPI(): StatblockAPI {
  const store = () => import('./profile/store.js');
  return {
    contractVersion: 1,
    assetBaseUrl: ASSET_BASE_URL,
    formatDiagnostic,
    profiles: {
      list: async () => (await store()).listProfiles(),
      get: async (id) => (await store()).getProfile(id),
      async save(raw) {
        const { migrateProfileData, validateProfile } = await import('@bindery/core');
        const migrated = migrateProfileData(raw);
        if (!migrated.ok) return { ok: false, issues: [migrated.issue] };
        const result = validateProfile(migrated.data);
        if (!result.ok) return result;
        await (await store()).saveProfile(result.profile);
        return { ok: true, profile: result.profile };
      },
      remove: async (id) => (await store()).deleteProfile(id),
      exportToFile: async (id) => (await store()).exportProfile(id),
    },
    schema: {
      introspectInstance: async (...args) => (await import('./schema/introspectActor.js')).introspectDocumentInstance(...args),
    },
    async engine() {
      const core = await import('@bindery/core');
      return Object.fromEntries(ENGINE_EXPORTS.map((name) => [name, core[name]])) as StatblockEngine;
    },
  };
}
