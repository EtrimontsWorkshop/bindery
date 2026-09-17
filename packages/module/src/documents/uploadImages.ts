import { MODULE_ID } from '../settings.js';

/**
 * The write layer (Step 8 Z4) — EXCLUSIVELY `FilePicker.upload()`, zero
 * decision logic (A1, `check:boundary`). `packages/core` has already
 * decided WHAT is worth saving (classification, extraction) — this module
 * only writes the bytes under a safe file name.
 */

export interface UploadImageInput {
  bytes: Uint8Array;
  /** Without extension — added based on `format`. */
  baseName: string;
  format: 'webp' | 'png';
}

export interface UploadImageResult {
  /** Path returned by Foundry — to use as a scene's `background.src`. */
  path: string;
}

/**
 * File name sanitization — Foundry itself rejects some characters, but we
 * prefer to explicitly control the result (predictable suffix collisions,
 * no surprises between Windows/Linux/S3-hosting file systems).
 */
function sanitizeBaseName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned.length > 0 ? cleaned : 'image';
}

/**
 * [Step 8, discovery] `FilePicker.upload()` does NOT create the target
 * folder by itself — trying to upload to a nonexistent path ends with the
 * server error "Target directory ... does not exist.", verified directly on
 * a real Foundry instance (not assumed). Every level of the path
 * (`worlds/x/bindery-imports` -> `worlds/x`, then
 * `worlds/x/bindery-imports`) has to be explicitly created BEFORE the first
 * upload — `createDirectory` on an already-existing level throws, so each
 * level is attempted in its own try/catch (usually "already exists", but a
 * real permissions error will still surface on upload).
 */
async function ensureDirectoryExists(source: string, path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await foundry.applications.apps.FilePicker.implementation.createDirectory(source, current);
    } catch {
      // Usually "already exists" — continue to the next level.
    }
  }
}

/**
 * Uploads a single image to the configured folder (the `uploadPath`
 * setting). Name collisions are resolved with a numeric suffix (`-1`,
 * `-2`, ...) — checked BY BROWSING the folder (`FilePicker.browse`), not by
 * guessing: another import may have already taken that name.
 */
export async function uploadImage(input: UploadImageInput, opts: { signal?: AbortSignal } = {}): Promise<UploadImageResult> {
  opts.signal?.throwIfAborted();

  const uploadPath = game.settings!.get(MODULE_ID, 'uploadPath') as string;
  const source = 'data';

  await ensureDirectoryExists(source, uploadPath);

  let existingNames = new Set<string>();
  try {
    const browsed = await foundry.applications.apps.FilePicker.implementation.browse(source, uploadPath);
    existingNames = new Set((browsed.files as string[]).map((f) => f.split('/').pop()!));
  } catch {
    // Browsing failed despite the folder existing (already created above) — no collisions to check.
  }

  const baseName = sanitizeBaseName(input.baseName);
  const extension = input.format;
  let fileName = `${baseName}.${extension}`;
  let suffix = 1;
  while (existingNames.has(fileName)) {
    fileName = `${baseName}-${suffix}.${extension}`;
    suffix++;
  }

  opts.signal?.throwIfAborted();

  const mimeType = input.format === 'webp' ? 'image/webp' : 'image/png';
  // Copy into a new ArrayBuffer (not ArrayBufferLike/SharedArrayBuffer) — required by the `BlobPart` type.
  const file = new File([new Uint8Array(input.bytes)], fileName, { type: mimeType });

  const response = (await foundry.applications.apps.FilePicker.implementation.upload(source, uploadPath, file, {}, { notify: false })) as
    | { path?: string }
    | false
    | undefined;
  if (!response || !response.path) {
    throw new Error(`Bindery | upload failed for ${fileName}`);
  }

  return { path: response.path };
}
