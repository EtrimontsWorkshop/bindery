import { MODULE_ID } from '../settings.js';

/**
 * Warstwa zapisu (KROK-8 Z4) — WYLACZNIE `FilePicker.upload()`, zero logiki
 * decyzyjnej (A1, `check:boundary`). `packages/core` juz zdecydowalo CO jest
 * warte zapisania (klasyfikacja, ekstrakcja) — ten modul tylko zapisuje bajty
 * pod bezpieczna nazwa pliku.
 */

export interface UploadImageInput {
  bytes: Uint8Array;
  /** Bez rozszerzenia — dodawane na podstawie `format`. */
  baseName: string;
  format: 'webp' | 'png';
}

export interface UploadImageResult {
  /** Sciezka zwrocona przez Foundry — do uzycia jako `background.src` sceny. */
  path: string;
}

/**
 * Sanityzacja nazwy pliku — Foundry samo odrzuca niektore znaki, ale wolimy
 * jawnie kontrolowac wynik (przewidywalne kolizje sufiksow, brak niespodzianek
 * miedzy systemami plikow Windows/Linux/S3 hostingu).
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
 * [KROK-8, odkrycie] `FilePicker.upload()` NIE tworzy docelowego folderu
 * samo z siebie — proba wgrania do nieistniejacej sciezki konczy sie bledem
 * serwera "Target directory ... does not exist.", zweryfikowane wprost w
 * prawdziwym Foundry (nie zalozenie). Trzeba jawnie utworzyc KAZDY poziom
 * sciezki (`worlds/x/bindery-imports` -> `worlds/x`, potem `worlds/x/bindery-imports`)
 * PRZED pierwszym wgraniem — `createDirectory` na juz istniejacym poziomie
 * rzuca, wiec kazdy poziom jest proboway w osobnym try/catch (najczesciej
 * "already exists", ale prawdziwy blad uprawnien i tak wyjdzie na wgrywaniu).
 */
async function ensureDirectoryExists(source: string, path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await foundry.applications.apps.FilePicker.implementation.createDirectory(source, current);
    } catch {
      // Najczesciej "juz istnieje" — kontynuuj do kolejnego poziomu.
    }
  }
}

/**
 * Wgrywa jeden obraz do skonfigurowanego folderu (ustawienie `uploadPath`).
 * Kolizje nazw rozwiazywane sufiksem liczbowym (`-1`, `-2`, ...) — sprawdzane
 * PRZEZ PRZEGLADANIE folderu (`FilePicker.browse`), nie przez zgadywanie:
 * inny import mogl juz zajac te nazwe.
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
    // Przegladanie nieudane mimo istniejacego (juz utworzonego wyzej) folderu — brak kolizji do sprawdzenia.
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
  // Kopia na nowym ArrayBuffer (nie ArrayBufferLike/SharedArrayBuffer) — wymog typu `BlobPart`.
  const file = new File([new Uint8Array(input.bytes)], fileName, { type: mimeType });

  const response = (await foundry.applications.apps.FilePicker.implementation.upload(source, uploadPath, file, {}, { notify: false })) as
    | { path?: string }
    | false
    | undefined;
  if (!response || !response.path) {
    throw new Error(`Bindery | upload nieudany dla ${fileName}`);
  }

  return { path: response.path };
}
