import { STATBLOCK_PROFILE_SCHEMA_VERSION } from './schema.js';

/**
 * [Task 1] Migration skeleton — there is only ONE schema version today, so
 * this is currently a single case (identity) plus a rejection for anything
 * else. The shape exists so that a future breaking change to
 * `StatblockProfile` adds ONE new `case` here (transforming `raw` into the
 * next version's shape) without touching any existing case, the same
 * "additive, never rewritten" pattern the old, deleted profile schema used
 * for its own field additions.
 *
 * Called BEFORE `validateProfile` by the storage layer (`packages/module`)
 * — a profile saved under a future version this build doesn't understand
 * yet fails here with a readable reason, never a confusing Zod error about
 * an unrecognized `schemaVersion` literal.
 */

export interface ProfileMigrationOk {
  ok: true;
  /** The profile data, upgraded to `STATBLOCK_PROFILE_SCHEMA_VERSION` — still untrusted, still needs `validateProfile`. */
  data: unknown;
  /** The version it was migrated FROM, or `null` when it was already current. */
  migratedFrom: number | null;
}

export interface ProfileMigrationFailed {
  ok: false;
  issue: string;
}

export type ProfileMigrationResult = ProfileMigrationOk | ProfileMigrationFailed;

export function migrateProfileData(raw: unknown): ProfileMigrationResult {
  if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw)) {
    return { ok: false, issue: 'missing schemaVersion' };
  }
  const version = (raw as { schemaVersion: unknown }).schemaVersion;
  switch (version) {
    case STATBLOCK_PROFILE_SCHEMA_VERSION:
      return { ok: true, data: raw, migratedFrom: null };
    // A future version's case goes here, e.g.:
    //   case 2: return { ok: true, data: upgradeV1ToV2(raw), migratedFrom: 2 };
    // transforming `raw` forward one step and falling through (or
    // recursing) until it reaches STATBLOCK_PROFILE_SCHEMA_VERSION.
    default:
      return { ok: false, issue: `unsupported schemaVersion: ${String(version)}` };
  }
}
