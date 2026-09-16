import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { browserImageEncoder, type EncodedImage } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { buildImageExtraction, type BuildImageExtractionOptions, type BuildImageExtractionResult } from './images/buildImageExtraction.js';
import { buildInventory } from './inventory/inventory.js';
import { buildTextLayout } from './text/buildTextLayout.js';
import { buildPageLayouts } from './layout/buildPageLayout.js';

/**
 * [KROK-8 Z4/Z5] Entry point analogiczny do `inspectDocument` (faza 1) —
 * WYLACZNIE tutaj (nie w `packages/module`) otwieramy pdf.js i sklejamy
 * inwentaryzacje z ekstrakcja obrazow. Powod architektoniczny, nie stylistyczny:
 * `pdfjs-dist` jest zewnetrzny (`external`) we WSZYSTKICH konfiguracjach Vite w
 * tym repo (ryzyko I3 — leniwe ladowanie), a przekierowanie goleg specyfikatora
 * na prawdziwa sciezke (`output.paths` w `vite.config.ts`) jest skonfigurowane
 * WYLACZNIE w `packages/core`. Bezposredni `import('pdfjs-dist/...')` z
 * `packages/module` zostawilby goly specyfikator w zbudowanym kodzie — to
 * DOKLADNIE ten sam blad co "bare-specifier incident" z fazy 1 (RAPORT-FAZA-1.md),
 * zlapany tutaj przez `check:imports` PRZED wdrozeniem na prawdziwy Foundry.
 *
 * `browserRegionRenderer`/`browserImageEncoder` to standardowe API webowe
 * (OffscreenCanvas), nie Foundry — ich uzycie tutaj nie lamie A1 (granica
 * dotyczy globali Foundry: `game`/`Hooks`/`foundry`/`ui`/`canvas`/`CONFIG`,
 * nie ogolnie "kodu przegladarkowego").
 *
 * [KROK-8, odkrycie — PRAWDZIWA przegladarka, nie Node] Ten sam wzorzec co
 * `tools/calibrate-images.ts` (dwa oddzielne `getDocument()`, inwentaryzacja +
 * ekstrakcja) rzuca w prawdziwym Foundry `TypeError: Cannot perform Construct
 * on a detached ArrayBuffer` przy DRUGIM wywolaniu, mimo ze kazde wywolanie
 * tworzylo "swiezy" `new Uint8Array(data)`. Przyczyna: w przegladarce pdf.js
 * uzywa PRAWDZIWEGO Workera i TRANSFERUJE (nie kopiuje) bufor danych do watku
 * workera przy pierwszym `getDocument()` — to ODLACZA (detach) oryginalny
 * `ArrayBuffer` w watku glownym, wiec KAZDY kolejny widok nad TYM SAMYM
 * bazowym buforem (nawet nowy `Uint8Array`) jest juz nieuzywalny. To INNY
 * mechanizm niz udokumentowany w KROK-4 "buffer-reuse DataCloneError" pod
 * Node (tam fake-worker tez transferuje, ale w ramach tego samego procesu —
 * blad byl w PONOWNYM UZYCIU tej samej instancji Uint8Array, nie w samym
 * transferze/detach). Naprawa: `data.slice(0)` PRZED kazdym `getDocument()` —
 * tworzy NIEZALEZNA kopie bajtow, wiec detach jednej kopii nie wplywa na
 * oryginalny `data` ani na kolejne kopie.
 */

export interface ExtractImagesFromDocumentOptions extends BuildImageExtractionOptions {
  /** Katalog bazowy assetow pdf.js — patrz `InspectOptions.assetBaseUrl`. */
  assetBaseUrl: string;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    // `data.slice(0)` — kopia NIEZALEZNA od `data`, patrz komentarz nad plikiem
    // (przegladarka transferuje/odlacza bufor do watku Workera per wywolanie).
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

/**
 * [KROK-9 Z2] Bboksy blokow `body` (potok tekstu) grupowane po stronie — jedyny
 * punkt gdzie potok tekstu (`buildTextLayout`+`buildPageLayouts`) i potok
 * obrazow (`buildImageExtraction`) faktycznie sie spotykaja, JAWNIE przez
 * zwracana mape, nie przez stan globalny (brief KROK-9 Z2). Trzeci `getDocument()`
 * (osobny od inwentaryzacji/ekstrakcji) — patrz komentarz nad plikiem: kazde
 * uzycie pdf.js w przegladarce potrzebuje WLASNEJ niezaleznej kopii bajtow.
 */
async function buildBodyBlockBoxesByPage(
  data: ArrayBuffer,
  assetBaseUrl: string,
  inv: Awaited<ReturnType<typeof buildInventory>>,
): Promise<Map<number, Rect[]>> {
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

  // `body` I `caption` — patrz odkrycie w `classify.ts` przy
  // `TEXT_COVERAGE_DECORATION_THRESHOLD`: flavor-text na dekoracyjnym tle
  // czesto ma font o roli `caption` (mniejszy/inny niz glowny `body`), nie
  // dlatego, ze to podpis obrazu, tylko dlatego, ze jest blisko obrazu.
  const byPage = new Map<number, Rect[]>();
  for (const b of blocks) {
    if (b.kind !== 'body' && b.kind !== 'caption') continue;
    const arr = byPage.get(b.pageNumber) ?? [];
    arr.push(b.bbox);
    byPage.set(b.pageNumber, arr);
  }
  return byPage;
}

export async function extractImagesFromDocument(
  data: ArrayBuffer,
  opts: ExtractImagesFromDocumentOptions,
): Promise<BuildImageExtractionResult> {
  const { assetBaseUrl, ...extractionOpts } = opts;

  const invDoc = await openDocument(data, assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);
  const bodyBlockBoxesByPage = await buildBodyBlockBoxesByPage(data, assetBaseUrl, inv);
  const extractDoc = await openDocument(data, assetBaseUrl);

  return buildImageExtraction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractDoc as any,
    { images: inv.images, vectors: inv.vectors, perPage: inv.perPage },
    browserRegionRenderer,
    browserImageEncoder,
    { ...extractionOpts, bodyBlockBoxesByPage },
  );
}

export type { EncodedImage };
