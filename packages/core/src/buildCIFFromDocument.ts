import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { buildCIFDocument, type BuildCIFDocumentResult } from './cif/buildCIFDocument.js';
import { extractOutline } from './cif/outline.js';
import { browserImageEncoder } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { buildImageExtraction, type BuildImageExtractionOptions } from './images/buildImageExtraction.js';
import { buildInventory } from './inventory/inventory.js';
import { buildPageLayouts } from './layout/buildPageLayout.js';
import { buildTextLayout } from './text/buildTextLayout.js';
import { buildActorsForDocument } from './profiles/buildActorsForDocument.js';
import type { ProfileV2 } from './profiles/schema.js';

/**
 * [KROK-9 Z3/Z4/Z5] Entry point analogiczny do `extractImagesFromDocument`
 * (KROK-8) — WYLACZNIE tutaj otwieramy pdf.js i sklejamy WSZYSTKIE cztery
 * potoki (inwentaryzacja, tekst/uklad, zakladki, obrazy) w jeden `CIFDocument`.
 * Ten sam powod architektoniczny co tam: `pdfjs-dist` jest zewnetrzny we
 * WSZYSTKICH konfiguracjach Vite, przekierowanie goleg specyfikatora jest
 * skonfigurowane WYLACZNIE w `packages/core/vite.config.ts` (check:imports).
 *
 * CZTERY oddzielne `getDocument()` (inwentaryzacja, uklad tekstu, zakladki,
 * ekstrakcja obrazow) — kazdy z WLASNA niezalezna kopia bajtow (`data.slice(0)`),
 * ten sam powod co w `extractImagesFromDocument.ts`: prawdziwa przegladarka
 * TRANSFERUJE (odlacza) bufor do watku Workera przy KAZDYM `getDocument()`.
 */

export interface BuildCIFFromDocumentOptions extends Pick<BuildImageExtractionOptions, 'targetLongEdgePx' | 'maxLongEdgePx' | 'outputFormat' | 'outputQuality' | 'signal' | 'onProgress'> {
  assetBaseUrl: string;
  fileName: string;
  fileHash: string;
  detectedLanguage?: string | null;
  /**
   * [KROK-20 Z2] Gdy podany, statbloki (`CIFDocument.actors`) sa budowane dla
   * calego dokumentu. Opcjonalny bo D2/D3 (scoring/detekcja profilu, MDD
   * §6.3/§6.4) NIE istnieja jeszcze jako rejestr w produkcie (decyzja kroku
   * 19) — wolajacy (warstwa modulu) na razie dostarcza profil z zewnatrz,
   * zamiast core samo zgadujace ktory profil pasuje. Brak profilu = brak
   * aktorow, tak jak dzis (degraduj, nie failuj — A7).
   */
  profile?: ProfileV2;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

export async function buildCIFFromDocument(data: ArrayBuffer, opts: BuildCIFFromDocumentOptions): Promise<BuildCIFDocumentResult> {
  const { assetBaseUrl, fileName, fileHash, detectedLanguage, profile, ...imageOpts } = opts;

  const invDoc = await openDocument(data, assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);

  const layoutDoc = await openDocument(data, assetBaseUrl);
  const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textLayout = await buildTextLayout(layoutDoc as any, fontSizeByKey);
  const { blocks } = buildPageLayouts(textLayout, {
    fontRoles: inv.fontRoles,
    vectors: inv.vectors,
    images: inv.images,
    perPage: inv.perPage,
  });

  // KROK-9 Z2 (patrz classify.ts) — `body`+`caption`, ta sama mapa uzyta tutaj
  // I do obrazow, bez potrzeby dodatkowego `getDocument()` (mamy juz `blocks`).
  const bodyBlockBoxesByPage = new Map<number, Rect[]>();
  for (const b of blocks) {
    if (b.kind !== 'body' && b.kind !== 'caption') continue;
    const arr = bodyBlockBoxesByPage.get(b.pageNumber) ?? [];
    arr.push(b.bbox);
    bodyBlockBoxesByPage.set(b.pageNumber, arr);
  }

  const outlineDoc = await openDocument(data, assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outline = await extractOutline(outlineDoc as any);

  const extractDoc = await openDocument(data, assetBaseUrl);
  const imageResult = await buildImageExtraction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractDoc as any,
    { images: inv.images, vectors: inv.vectors, perPage: inv.perPage },
    browserRegionRenderer,
    browserImageEncoder,
    {
      ...imageOpts,
      bodyBlockBoxesByPage,
      treatFullBleedAsContent: profile?.images?.treatFullBleedAsContent ?? false,
      autoCropUniformMargins: profile?.images?.autoCropUniformMargins ?? false,
      brightenAutoCroppedImages: profile?.images?.brightenAutoCroppedImages ?? false,
    },
  );

  let actors: import('./cif/types.js').CIFActor[] | undefined;
  let actorDiagnostics: import('./text/types.js').Diagnostic[] = [];
  if (profile) {
    const actorsDoc = await openDocument(data, assetBaseUrl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actorsResult = await buildActorsForDocument(actorsDoc as any, { profile, fontRoles: inv.fontRoles, signal: imageOpts.signal });
    actors = actorsResult.actors;
    actorDiagnostics = actorsResult.diagnostics;
  }

  return buildCIFDocument({
    fileName,
    fileHash,
    pageCount: invDoc.numPages,
    detectedLanguage: detectedLanguage ?? null,
    blocks,
    outline,
    images: imageResult.images,
    diagnostics: [...textLayout.diagnostics, ...imageResult.diagnostics, ...actorDiagnostics],
    actors,
  });
}
