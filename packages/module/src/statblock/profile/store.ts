import { migrateProfileData, validateProfile, type StatblockProfile } from '@bindery/core';
import { MODULE_ID } from '../../settings.js';

/**
 * [Task 1] CRUD for `StatblockProfile`s, all held in the single
 * `statblockProfiles` world setting (`settings.ts`), keyed by
 * `StatblockProfile.id`. Every read runs `migrateProfileData` then
 * `validateProfile` again (never trusted just because it came from
 * `game.settings` — the same "profiles are untrusted input, always
 * re-validated" contract as the deleted CoC7-era actor profile), so a
 * profile that becomes invalid (e.g. hand-edited in the world database, or
 * saved by a future version of this module) is skipped with a console
 * warning rather than silently corrupting the rest of the collection.
 */

function readAllRaw(): Record<string, unknown> {
  return game.settings!.get(MODULE_ID, 'statblockProfiles') as unknown as Record<string, unknown>;
}

async function writeAll(profiles: Record<string, StatblockProfile>): Promise<void> {
  await game.settings!.set(MODULE_ID, 'statblockProfiles', profiles);
}

/** Every profile currently valid (see the file header) — invalid entries are skipped, not thrown. */
function readAllValid(): Record<string, StatblockProfile> {
  const raw = readAllRaw();
  const valid: Record<string, StatblockProfile> = {};
  for (const [id, entry] of Object.entries(raw)) {
    const migrated = migrateProfileData(entry);
    if (!migrated.ok) {
      console.warn(`Bindery | statblock profile "${id}" could not be migrated: ${migrated.issue}`);
      continue;
    }
    const result = validateProfile(migrated.data);
    if (!result.ok) {
      console.warn(`Bindery | statblock profile "${id}" failed validation: ${result.issues.join('; ')}`);
      continue;
    }
    valid[id] = result.profile;
  }
  return valid;
}

export function listProfiles(): StatblockProfile[] {
  return Object.values(readAllValid());
}

export function getProfile(id: string): StatblockProfile | undefined {
  return readAllValid()[id];
}

export async function saveProfile(profile: StatblockProfile): Promise<void> {
  const all = { ...readAllValid(), [profile.id]: profile };
  await writeAll(all);
}

export async function deleteProfile(id: string): Promise<void> {
  const all = { ...readAllValid() };
  delete all[id];
  await writeAll(all);
}

/** Copies an existing profile under a new id/name — the copy is independent from that point on (editing one never affects the other). */
export async function duplicateProfile(id: string, newName: string): Promise<StatblockProfile | null> {
  const source = getProfile(id);
  if (!source) return null;
  const copy: StatblockProfile = { ...source, id: foundry.utils.randomID(), name: newName };
  await saveProfile(copy);
  return copy;
}

/** Triggers a browser download of the profile as a standalone `.json` file — the sharing mechanism between worlds/users (world-setting storage alone can't cross that boundary). */
export function exportProfile(id: string): void {
  const profile = getProfile(id);
  if (!profile) return;
  const json = JSON.stringify(profile, null, 2);
  const filename = `${profile.name.replace(/[^a-z0-9_-]+/gi, '_')}.json`;
  foundry.utils.saveDataToFile(json, 'application/json', filename);
}

export type ImportProfileResult = { ok: true; profile: StatblockProfile } | { ok: false; issues: readonly string[] };

/** Reads a user-picked `.json` file, migrates + validates it, and saves it into this world's collection on success. Never throws — a bad file is an expected case (the same contract as `validateProfile` itself). */
export async function importProfileFromFile(file: File): Promise<ImportProfileResult> {
  let raw: unknown;
  try {
    const text = await foundry.utils.readTextFromFile(file);
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: ['This file is not valid JSON.'] };
  }
  const migrated = migrateProfileData(raw);
  if (!migrated.ok) return { ok: false, issues: [migrated.issue] };
  const result = validateProfile(migrated.data);
  if (!result.ok) return result;
  await saveProfile(result.profile);
  return { ok: true, profile: result.profile };
}
