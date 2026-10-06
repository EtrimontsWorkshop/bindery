import { describe, expect, it } from 'vitest';
import { migrateProfileData } from '../../../src/statblock/profile/migrate.js';
import { STATBLOCK_PROFILE_SCHEMA_VERSION } from '../../../src/statblock/profile/schema.js';

describe('migrateProfileData', () => {
  it('passes a current-version profile through unchanged, with migratedFrom: null', () => {
    const raw = { schemaVersion: STATBLOCK_PROFILE_SCHEMA_VERSION, id: 'p1' };
    const result = migrateProfileData(raw);
    expect(result).toEqual({ ok: true, data: raw, migratedFrom: null });
  });

  it('rejects an unrecognized future schemaVersion with a readable reason, not a crash or silent coercion', () => {
    const result = migrateProfileData({ schemaVersion: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain('999');
  });

  it('rejects data with no schemaVersion field at all', () => {
    expect(migrateProfileData({ id: 'p1' }).ok).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    for (const input of [null, 'a string', 42, [], undefined]) {
      expect(() => migrateProfileData(input)).not.toThrow();
      expect(migrateProfileData(input).ok).toBe(false);
    }
  });
});
