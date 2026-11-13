import { MODULE_ID } from '../settings.js';
import { withWhiteBackground } from './whiteBackground.js';

/**
 * The write layer — EXCLUSIVELY `FilePicker.upload()`, zero
 * decision logic (`check:boundary`). `packages/core` has already
 * decided WHAT is worth saving (classification, extraction) — this module
 * only writes the bytes under a safe file name.
 */

export interface UploadImageInput {
  bytes: Uint8Array;
  /** Without extension — added based on `format`. */
  baseName: string;
  format: 'webp' | 'png';
  /** The image was changed by hand (token panel, image editor): the "white background" setting leaves it as it is. */
  keepTransparency?: boolean;
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
export function sanitizeBaseName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    // NFKD splits "ę" into "e" + a combining mark; drop the marks after LATIN letters so the letter survives instead of
    // becoming "e_". Marks of other scripts are part of their letters (a vowel sign) and stay. "ł" has no decomposition
    // and is mapped by hand.
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFC')
    // Letters and digits of any script are kept: a name in Cyrillic or Japanese used to be reduced to "image".
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  // Capped (by characters, not UTF-16 units, so no letter is cut in half): a long caption must not make a name the
  // file system refuses. The collision suffix and the extension come on top of this.
  const capped = [...cleaned].slice(0, MAX_BASE_NAME_CHARS).join('').replace(/_$/, '');
  return capped.length > 0 ? capped : 'image';
}

/** Longest base name of an uploaded file, in characters. Three bytes each at worst in UTF-8, which stays under the usual 255-byte limit of a file name. */
const MAX_BASE_NAME_CHARS = 60;

/** Where the files go: Foundry's storage source and, for S3, the bucket. */
export interface UploadTarget {
  source: string;
  bucket?: string;
}

/**
 * The storage the "upload storage" setting points at. The default is `data`, the user data folder: it is what a
 * self-hosted Foundry uses, and a hosting service that replaces that folder serves it under the same name (verified on
 * one, see the README). The other values are there for a setup where it does not, chosen by the user.
 */
export function resolveUploadTarget(): UploadTarget {
  const configured = game.settings!.get(MODULE_ID, 'uploadSource') as unknown;
  const source = typeof configured === 'string' && configured !== '' ? configured : 'data';
  const bucket = game.settings!.get(MODULE_ID, 'uploadBucket') as unknown;
  return source === 's3' && typeof bucket === 'string' && bucket.trim() !== '' ? { source, bucket: bucket.trim() } : { source };
}

function storageOptions(target: UploadTarget): { bucket?: string } {
  return target.bucket ? { bucket: target.bucket } : {};
}

/**
 * `FilePicker.upload()` does NOT create the target
 * folder by itself — trying to upload to a nonexistent path ends with the
 * server error "Target directory ... does not exist.", verified directly on
 * a real Foundry instance (not assumed). Every level of the path
 * (`worlds/x/bindery-imports` -> `worlds/x`, then
 * `worlds/x/bindery-imports`) has to be explicitly created BEFORE the first
 * upload — `createDirectory` on an already-existing level throws, so each
 * level is attempted in its own try/catch (usually "already exists", but a
 * real permissions error will still surface on upload).
 */
async function ensureDirectoryExists(target: UploadTarget, path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await foundry.applications.apps.FilePicker.implementation.createDirectory(target.source as never, current, storageOptions(target));
    } catch {
      // Usually "already exists" — continue to the next level.
    }
  }
}

/** What is known about one upload folder: the names in it, and whether they could be read at all. */
interface FolderNames {
  names: Set<string>;
  /** `false` when the folder could not be listed: `names` then holds only what this import uploaded. */
  listed: boolean;
}

/** The names already in `path`, after making sure the folder exists. */
async function listExistingNames(target: UploadTarget, path: string): Promise<FolderNames> {
  await ensureDirectoryExists(target, path);
  try {
    const browsed = await foundry.applications.apps.FilePicker.implementation.browse(target.source as never, path, storageOptions(target));
    // A name in a listing may come URL-encoded (a space as %20); compare what the file is really called.
    return { names: new Set((browsed.files as string[]).map((f) => decodeName(f.split('/').pop()!))), listed: true };
  } catch (err) {
    // Not listed: nothing is known about the files already there, and an upload under a taken name REPLACES that file
    // without a word. `uploadImage` then makes the name its own (see `unlistedSuffix`).
    console.warn(`Bindery | could not list the upload folder "${path}"; uploaded files get a unique suffix instead:`, err);
    return { names: new Set<string>(), listed: false };
  }
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** A suffix no earlier import used: the time, to the millisecond, in base 36. One per import, so its files sort together. */
function unlistedSuffix(): string {
  return Date.now().toString(36);
}

/**
 * One import's view of the upload folders: each folder is created and browsed ONCE, then the names this import
 * uploads are added to what was found. Without it every image cost one server call per level of the path plus a
 * listing of the whole folder (about a thousand calls for two hundred images). Names that another user uploads to the
 * same folder during the import are not seen — the same as before between the listing and the upload.
 */
export class UploadSession {
  readonly #namesByFolder = new Map<string, FolderNames>();
  readonly #suffix = unlistedSuffix();

  /** Added to the base name of every file that goes to a folder which could not be listed. */
  get unlistedSuffix(): string {
    return this.#suffix;
  }

  async namesIn(target: UploadTarget, path: string): Promise<FolderNames> {
    const key = `${target.source}:${target.bucket ?? ''}:${path}`;
    let names = this.#namesByFolder.get(key);
    if (!names) {
      names = await listExistingNames(target, path);
      this.#namesByFolder.set(key, names);
    }
    return names;
  }
}

/** The first of `baseName.ext`, `baseName-1.ext`, `baseName-2.ext`, ... that is not in `existingNames`. */
export function uniqueFileName(baseName: string, extension: string, existingNames: ReadonlySet<string>): string {
  let fileName = `${baseName}.${extension}`;
  let suffix = 1;
  while (existingNames.has(fileName)) {
    fileName = `${baseName}-${suffix}.${extension}`;
    suffix++;
  }
  return fileName;
}

/**
 * Uploads a single image to the configured folder (the `uploadPath`
 * setting) of the configured storage (`resolveUploadTarget`). Name collisions are resolved with a numeric suffix (`-1`,
 * `-2`, ...) — checked BY BROWSING the folder (`FilePicker.browse`), not by
 * guessing: another import may have already taken that name. A folder that cannot be browsed gets names with a
 * suffix of this import instead, so nothing already there is replaced. Pass one
 * `session` for all uploads of an import so the folder is browsed once.
 */
export async function uploadImage(input: UploadImageInput, opts: { signal?: AbortSignal; session?: UploadSession } = {}): Promise<UploadImageResult> {
  opts.signal?.throwIfAborted();

  const uploadPath = game.settings!.get(MODULE_ID, 'uploadPath') as string;
  const target = resolveUploadTarget();
  const session = opts.session ?? new UploadSession();
  const folder = await session.namesIn(target, uploadPath);
  const existingNames = folder.names;

  const cleanName = sanitizeBaseName(input.baseName);
  const baseName = folder.listed ? cleanName : `${cleanName}-${session.unlistedSuffix}`;
  const extension = input.format;
  const fileName = uniqueFileName(baseName, extension, existingNames);

  opts.signal?.throwIfAborted();

  const mimeType = input.format === 'webp' ? 'image/webp' : 'image/png';
  const whiteBackground = !input.keepTransparency && game.settings!.get(MODULE_ID, 'whiteBackground') === true;
  const bytes = whiteBackground ? (await withWhiteBackground({ bytes: input.bytes, format: input.format })).bytes : input.bytes;
  // Copy into a new ArrayBuffer (not ArrayBufferLike/SharedArrayBuffer) — required by the `BlobPart` type.
  const file = new File([new Uint8Array(bytes)], fileName, { type: mimeType });

  const response = (await foundry.applications.apps.FilePicker.implementation.upload(target.source as never, uploadPath, file, storageOptions(target), { notify: false })) as
    | { path?: string }
    | false
    | undefined;
  if (!response || !response.path) {
    throw new Error(`Bindery | upload failed for ${fileName}`);
  }
  existingNames.add(fileName);

  return { path: response.path };
}
