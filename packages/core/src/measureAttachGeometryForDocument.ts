import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildInventory } from './inventory/inventory.js';
import { tokenizePage, type TextContentItemLike } from './profiles/tokenizePage.js';
import { measureAttachGeometry, type AttachGeometryMeasurement } from './profiles/measureAttachGeometry.js';
import type { LabelledPairsPattern, SectionListPattern, FontRoleCandidatePattern } from './profiles/schema.js';
import type { FontRole } from './inventory/fontRegistry.js';
import type { ProfileToken } from './profiles/types.js';

/**
 * [KROK-24 Z2] Entry point Profile Studio (pomiar geometrii) — analogiczny do
 * `analyzeProfileDocument.ts`/`getPageTextTokens.ts`: WYLACZNIE tutaj otwieramy
 * pdf.js dla tej funkcji (`check:imports`). Celowo BEZ `buildInventory`, GDY
 * kandydat to `labelledPairs`/`sectionList` — zaden z nich nie czyta
 * `ProfileToken.fontRole`, wiec mapa rol fontow zostaje pusta (koszt
 * inwentaryzacji, ktorego to narzedzie pomiarowe wtedy nie potrzebuje).
 *
 * [KROK-29 Z3, "przy okazji"] `fontRoleCandidate` (Nazwa) WLACZONE do pomiaru
 * od tego kroku — `matchFontRoleCandidate` CZYTA `fontRole` (i `fontKey` przez
 * `requireFontKeys`) jako WEJSCIOWY filtr, wiec BEZ inwentaryzacji kazdy token
 * mialby `fontRole: undefined` i pomiar zawsze pokazywalby zero par,
 * niezaleznie od prawdziwych danych — cichy, mylacy wynik zamiast bledu.
 * Inwentaryzacja uruchamiana WYLACZNIE w tej galezi (osobna kopia dokumentu,
 * ten sam wzorzec co `verify-profile-studio.ts` — `buildInventory` sam
 * przechodzi WSZYSTKIE strony operatorem, nie da sie tego bezpiecznie
 * przeplatac z rownoleglym czytaniem tekstu na TYM SAMYM uchwycie dokumentu).
 *
 * Celowo BEZ filtru pregenow/`pages.include` z profilu — pomiar jest SYGNALEM
 * do kalibracji, nie ostateczna decyzja (brief: "Pokaz rozklad, autor i tak
 * wszystko przegladnie"), a strony pregen/poza zakresem po prostu nie dadza
 * pasujacych par (`grids.length === 0`), wiec nie zafalszuja pomiaru.
 */

export interface MeasureAttachGeometryForDocumentOptions {
  assetBaseUrl: string;
  signal?: AbortSignal;
}

export async function measureAttachGeometryForDocument(
  data: ArrayBuffer,
  anchorPattern: LabelledPairsPattern,
  candidatePattern: LabelledPairsPattern | SectionListPattern | FontRoleCandidatePattern,
  opts: MeasureAttachGeometryForDocumentOptions,
): Promise<AttachGeometryMeasurement> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;

  let fontRoles: ReadonlyMap<string, FontRole> = new Map();
  if (candidatePattern.kind === 'fontRoleCandidate') {
    const invDoc = await pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      wasmUrl: `${opts.assetBaseUrl}wasm/`,
      standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
    }).promise;
    fontRoles = (await buildInventory(invDoc, { signal: opts.signal })).fontRoles;
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const pages: { tokens: ProfileToken[] }[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('measureAttachGeometryForDocument przerwane przez AbortSignal', 'AbortError');
    const page = await doc.getPage(pageNumber);
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const tokens = tokenizePage(tc.items as TextContentItemLike[], page, fontRoles, pageNumber);
    page.cleanup();
    pages.push({ tokens });
  }

  return measureAttachGeometry(pages, anchorPattern, candidatePattern);
}
