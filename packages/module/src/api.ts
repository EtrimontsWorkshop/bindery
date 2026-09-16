import { ASSET_BASE_URL } from './settings.js';
import { ensureFolder } from './documents/ensureFolder.js';
import { createActorsFromAdapterResults, type CreatedActorEntry } from './documents/createActors.js';
import type { Coc7ActorPayload } from './adapters/coc7.js';

export interface BinderyAPI {
  readonly version: string;
  /**
   * Analizuje PDF bez UI. Ladowanie @bindery/core (i pdf.js, ktorego uzywa)
   * jest leniwe — dopiero przy pierwszym wywolaniu (ryzyko I3).
   */
  inspectDocument(data: ArrayBuffer): Promise<import('@bindery/core').DocumentSummary>;
  /**
   * [KROK-19 Z4] WYLACZNIE do pomiaru B'/A z uzytkownikiem — NIE ekran
   * przegladu (celowo poza zakresem tego kroku, patrz "Czego NIE robic" w
   * KROK-19-adapter-coc7.md). Przyjmuje JUZ GOTOWE wyniki adaptera (policzone
   * z calego dokumentu wczesniej, w Node — `coc7Adapter.fromActor` jest
   * czysta funkcja, wiec jej wynik jest identyczny niezaleznie od tego, gdzie
   * zostal policzony) i tworzy z nich Actor+Item w AKTYWNYM swiecie. Uzycie:
   * wklejone do konsoli przegladarki Foundry, patrz
   * `tools/build-z4-measurement-macro.ts`.
   */
  createStatblockActorsForMeasurement(
    results: readonly import('@bindery/core').AdapterResult<Coc7ActorPayload>[],
    opts?: { folderName?: string },
  ): Promise<{ id: string; name: string; notes: readonly import('@bindery/core').LocalizableMessage[]; issues: readonly import('@bindery/core').AdapterIssue[] }[]>;
}

/** Podglad wyekstrahowanego obrazu — TYLKO to, co potrzebne ekranowi przegladu (A5: czlowiek zawsze przeglada przed zapisem). */
export interface ExtractedImagePreview {
  objId: string | null;
  page: number;
  classification: import('@bindery/core').ImageClassification;
  targetKind: string;
  width: number;
  height: number;
  format: 'webp' | 'png';
  bytes: Uint8Array;
  /** Blob URL do podgladu w UI — wolajacy odpowiada za `URL.revokeObjectURL` po zamknieciu. */
  previewUrl: string;
}

function bytesToBlobUrl(bytes: Uint8Array, format: 'webp' | 'png'): string {
  const mime = format === 'webp' ? 'image/webp' : 'image/png';
  // Kopia na nowym ArrayBuffer (nie ArrayBufferLike/SharedArrayBuffer) — wymog typu `BlobPart`.
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
}

export function buildAPI(version: string): BinderyAPI {
  return {
    version,
    async inspectDocument(data: ArrayBuffer) {
      const { inspectDocument } = await import('@bindery/core');
      return inspectDocument(data, { assetBaseUrl: ASSET_BASE_URL });
    },
    async createStatblockActorsForMeasurement(results, opts = {}) {
      const folder = opts.folderName ? await ensureFolder(opts.folderName, 'Actor') : undefined;
      const entries: CreatedActorEntry[] = await createActorsFromAdapterResults({ results: [...results], folder });
      return entries.map((e) => ({ id: e.actor.id as unknown as string, name: e.actor.name as unknown as string, notes: e.notes, issues: e.issues }));
    },
  };
}

export type ActorProfileValidation =
  | { ok: true; profile: import('@bindery/core').ProfileV2 }
  | { ok: false; issues: readonly string[] };

/**
 * [KROK-21 Z1] Waliduje tresc pliku profilu wybranego przez uzytkownika w
 * `ImportWizard` (`<input type="file">`, nigdy konsola — patrz RAPORT-KROK-20.md
 * odkrycie #3, zakladka Aktorow byla "funkcjonalnie martwa dla kazdego poza
 * deweloperem"). Zastepuje usuniete `setDebugActorProfile` — JEDNA droga do
 * wczytania profilu, nie dwie ("Dwie drogi do tej samej rzeczy to dwie drogi
 * do rozjazdu", brief kroku 21). Zwraca `ok:false` z czytelnymi bledami
 * zamiast rzucac — zly plik to spodziewany, nie wyjatkowy przypadek (ten sam
 * kontrakt co `validateProfile` samo w sobie).
 */
export async function validateActorProfileFile(raw: unknown): Promise<ActorProfileValidation> {
  const { validateProfile } = await import('@bindery/core');
  const result = validateProfile(raw);
  if (!result.ok) return { ok: false, issues: result.issues };
  return { ok: true, profile: result.profile };
}

/**
 * Orkiestracja fazy 3 nad prawdziwym dokumentem w przegladarce (KROK-8 Z4/Z5).
 * Cala logika otwierania pdf.js i sklejania inwentaryzacji z ekstrakcja zyje w
 * `@bindery/core` (`extractImagesFromDocument`) — NIE tutaj. Powod: `pdfjs-dist`
 * jest zewnetrzny (`external`) we wszystkich konfiguracjach Vite tego repo, ale
 * przekierowanie goleg specyfikatora na prawdziwa sciezke (`output.paths`) jest
 * skonfigurowane WYLACZNIE w `packages/core/vite.config.ts`. Bezposredni
 * `import('pdfjs-dist/...')` STAD zostawilby goly specyfikator w zbudowanym
 * kodzie modulu — zlapane empirycznie przez `check:imports` (ten sam blad co
 * "bare-specifier incident" z fazy 1, RAPORT-FAZA-1.md) przy pierwszej probie.
 *
 * Zwraca WYLACZNIE wpisy `content` — `undecided` trafi do ekranu przegladu
 * dopiero w kroku 9 (bloki semantyczne), na razie pokazujemy tylko to, co
 * `packages/core` juz uznalo za jednoznaczna tresc.
 */
export async function extractImagesForReview(data: ArrayBuffer, opts: { signal?: AbortSignal } = {}): Promise<ExtractedImagePreview[]> {
  const { extractImagesFromDocument } = await import('@bindery/core');
  const result = await extractImagesFromDocument(data, { assetBaseUrl: ASSET_BASE_URL, signal: opts.signal });

  return result.images
    .filter((img) => img.classification === 'content')
    .map((img) => ({
      objId: img.entry.objId,
      page: img.entry.occurrences[0]?.page ?? 0,
      classification: img.classification,
      targetKind: img.targetKind,
      width: img.width,
      height: img.height,
      format: img.payload.format,
      bytes: img.payload.bytes,
      previewUrl: bytesToBlobUrl(img.payload.bytes, img.payload.format),
    }));
}

/** Podglad hierarchii journali PRZED zapisem (A5: czlowiek zawsze przeglada) — nazwa + liczba stron, bez pelnej tresci HTML. */
export interface JournalPreview {
  name: string;
  pageCount: number;
}

export interface CIFBuildResult {
  preview: { journals: JournalPreview[]; imageCount: number };
  document: import('@bindery/core').CIFDocument;
  imageBytesById: Map<string, { bytes: Uint8Array; format: string }>;
}

/** SHA-256 w hex — Web Crypto API standardowa (nie Foundry), do `CIFDocument.source.fileHash`. */
async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Orkiestracja fazy 8 (KROK-9 Z3/Z4/Z5) nad prawdziwym dokumentem w
 * przegladarce — ten sam wzorzec architektoniczny co `extractImagesForReview`:
 * cale otwieranie pdf.js zyje w `@bindery/core` (`buildCIFFromDocument`), NIE
 * tutaj (`check:imports`, patrz komentarz przy `extractImagesForReview`).
 */
export async function buildJournalsForReview(
  data: ArrayBuffer,
  fileName: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; profile?: import('@bindery/core').ProfileV2 } = {},
): Promise<CIFBuildResult> {
  const { buildCIFFromDocument } = await import('@bindery/core');
  const fileHash = await hashArrayBuffer(data);
  const result = await buildCIFFromDocument(data, { assetBaseUrl: ASSET_BASE_URL, fileName, fileHash, signal: opts.signal, onProgress: opts.onProgress, profile: opts.profile });
  return {
    preview: {
      journals: result.document.journals.map((j) => ({ name: j.name, pageCount: j.pages.length })),
      imageCount: result.document.images.length,
    },
    document: result.document,
    imageBytesById: result.imageBytesById,
  };
}

/**
 * [KROK-11 Z3] Otwiera uchwyt dokumentu WYLACZNIE do podgladu stron w ekranie
 * przegladu — patrz `openPreviewDocument` w `@bindery/core`. Wywolujacy
 * (`ReviewScreen`) jest odpowiedzialny za `destroy()` po zamknieciu ekranu.
 */
export async function openPreviewForReview(data: ArrayBuffer): Promise<import('@bindery/core').PreviewDocument> {
  const { openPreviewDocument } = await import('@bindery/core');
  return openPreviewDocument(data, { assetBaseUrl: ASSET_BASE_URL });
}
