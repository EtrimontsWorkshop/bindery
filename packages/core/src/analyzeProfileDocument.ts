import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildInventory } from './inventory/inventory.js';
import { classifyPageRoute } from './profiles/pageRoute.js';
import { analyzeProfilePage, aggregateDocumentAnalysis, type DocumentAnalysis, type PageAnalysis } from './profiles/studioAnalysis.js';
import { tokenizePage, type TextContentItemLike } from './profiles/tokenizePage.js';
import type { ProfileToken } from './profiles/types.js';
import type { ProfileV2 } from './profiles/schema.js';

/**
 * [KROK-22 Z1/Z4] Entry point Profile Studio — analogiczny do
 * `buildCIFFromDocument.ts`/`inspectDocument.ts`: WYLACZNIE tutaj otwieramy
 * pdf.js (`check:imports`, ta sama przyczyna architektoniczna co wszedzie
 * indziej w tym pliku katalogu — `pdfjs-dist` jest zewnetrzny we WSZYSTKICH
 * konfiguracjach Vite). `packages/module` (`ProfileStudio.ts`) NIE liczy
 * niczego samodzielnie — wylacznie okno i rysowanie (DoD kroku 22,
 * `check:boundary`).
 */

export interface AnalyzeProfileDocumentOptions {
  assetBaseUrl: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

async function openDocument(data: ArrayBuffer, assetBaseUrl: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = `${assetBaseUrl}pdf.worker.mjs`;
  return pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${assetBaseUrl}wasm/`,
    standardFontDataUrl: `${assetBaseUrl}standard_fonts/`,
  }).promise;
}

export async function analyzeProfileDocument(data: ArrayBuffer, profile: ProfileV2, opts: AnalyzeProfileDocumentOptions): Promise<DocumentAnalysis> {
  const invDoc = await openDocument(data, opts.assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);

  const textDoc = await openDocument(data, opts.assetBaseUrl);
  const pages: PageAnalysis[] = [];
  for (let pageNumber = 1; pageNumber <= textDoc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('analyzeProfileDocument przerwane przez AbortSignal', 'AbortError');

    const page = await textDoc.getPage(pageNumber);
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const tokens = tokenizePage(tc.items as TextContentItemLike[], page, inv.fontRoles, pageNumber);
    page.cleanup();

    const route = classifyPageRoute(tokens);
    pages.push(analyzeProfilePage(tokens, profile, pageNumber, route));
    opts.onProgress?.(pageNumber, textDoc.numPages);
  }

  return aggregateDocumentAnalysis(pages);
}

export interface GetFontRoleAwareTokensOptions {
  assetBaseUrl: string;
}

/**
 * [KROK-34 Z2, zmierzony na zywo blad] `getPageTextTokens.ts` (Krok 23 Z6)
 * CELOWO nie liczy `fontRole` (wymaga `buildInventory`, kosztowne na kazde
 * klikniecie) — wystarczalo to Krok 23 Z6 (klikniecie "wklej tekst do pola",
 * etykiety/naglowki dopasowuja sie po LITERALNYM tekscie). `proseBlock`
 * (Notatki, ten krok) i Krok-33 Z4 (opisy pod atakami) WYMAGAJA jednak
 * `fontRole === 'accent'`, zeby rozpoznac podnaglowki — bez prawdziwej roli
 * fontu (liczonej z CALEGO dokumentu, NIE jednej strony — rola to ranking
 * czestosci/rozmiaru PER DOKUMENT, patrz `inventory.ts`) obie funkcje milcza
 * mimo poprawnych danych, mierzone wprost: Profile Studio "Notatki" na
 * `Wrak.pdf` zwracalo "brak dopasowania" dla Sciapoda, mimo ze DOKLADNIE TEN
 * SAM profil+strona przez `analyzeProfileDocument` (pelny przebieg) i node'owy
 * skrypt weryfikacyjny znajdowaly notatke poprawnie.
 *
 * Placi TEN SAM koszt co pelny przebieg (`buildInventory` na calym
 * dokumencie), ale zwraca tokeny WYLACZNIE dla jednej, zadanej strony — do
 * uzycia z WYRAZNEJ akcji autora (klikniecie "Wskaż przykład"/"Odśwież
 * podgląd" w zakladce Notatki), NIE do rysowania klikalnych prostokatow przy
 * kazdym przejsciu miedzy stronami (tam nadal wystarcza `getPageTextTokens`).
 */
export async function getFontRoleAwareTokensForPage(data: ArrayBuffer, pageNumber: number, opts: GetFontRoleAwareTokensOptions): Promise<ProfileToken[]> {
  const invDoc = await openDocument(data, opts.assetBaseUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = await buildInventory(invDoc as any);

  const textDoc = await openDocument(data, opts.assetBaseUrl);
  const page = await textDoc.getPage(pageNumber);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const tokens = tokenizePage(tc.items as TextContentItemLike[], page, inv.fontRoles, pageNumber);
  page.cleanup();
  return tokens;
}
