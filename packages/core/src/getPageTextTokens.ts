import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { fontSizeFromTransform } from './layout/textGeometry.js';
import { resolveFontKey } from './inventory/fontRegistry.js';

/**
 * [KROK-23 Z6] Surowe tokeny tekstowe JEDNEJ strony (tekst + bbox) — WYLACZNIE
 * do "klik na stronie wkleja tekst do pola formularza" w edytorze profilu.
 * Celowo NIE liczy `fontRole` (bez `buildInventory`, ktore wymaga przebiegu
 * po CALYM dokumencie) — Z6 nie potrzebuje roli fontu, tylko tekstu, wiec
 * pomijamy koszt, ktorego reszta profilu (`analyzeProfileDocument`) i tak juz
 * placi przy pelnym przebiegu. Ten sam wzorzec otwierania co
 * `openPreviewDocument.ts`/`inspectDocument.ts` (wlasna kopia bajtow).
 *
 * [KROK-29 Z3] `fontKey` NATOMIAST liczony jest tutaj, mimo powyzszego —
 * `resolveFontKey` potrzebuje WYLACZNIE `page.commonObjs` (JEDNEJ strony), nie
 * calodokumentowego `buildInventory`. Klikniecie kandydata na nazwe w
 * zakladce "Nazwa" (Profile Studio) uczy sie TEGO klucza — bez niego nie
 * byloby czego sie uczyc.
 *
 * [ZGŁOSZENIE na zywo, "requireFontKeys nie zapisuje sie mimo klikniecia w
 * prawdziwe imie"] Poprzednia wersja tego komentarza twierdzila, ze
 * `page.commonObjs` jest "juz wypelnione przez getTextContent()" (F0-Q1) —
 * zmierzone wprost jako FALSZYWE dla rzadziej uzywanych/ozdobnych fontow
 * (np. font imienia postaci, uzyty raz na strone): `getTextContent()` NIE
 * gwarantuje, ze KAZDY napotkany font zdazy w pelni zaladowac sie do
 * `commonObjs` przed rozwiazaniem swojej obietnicy — `resolveFontKey` cicho
 * zwraca `null` dla takiego tokenu (`commonObjs.has(fontName)` jeszcze
 * `false`), a klikniecie w Studiu "dziala" wizualnie (podglad tekstu sie
 * aktualizuje — `#namePreviewText`, calkowicie niezalezne pole), ale
 * `requireFontKeys` nigdy nie dostaje wpisu. Prawdziwe, udokumentowane od
 * fazy 0 zrodlo prawdy (patrz `CLAUDE.md`, "Font fingerprinting works via
 * `commonObjs.get(fontName).name` AFTER `getOperatorList()`") — ten sam
 * wzorzec, ktorego reszta kodu (`tokenizePage.ts`'s prawdziwi wywolujacy,
 * `buildInventory`) juz uzywa poprawnie; ta funkcja byla jedynym miejscem,
 * ktore go pominelo.
 */

export interface PageTextToken {
  text: string;
  bbox: Rect;
  fontKey?: string;
}

export interface GetPageTextTokensOptions {
  assetBaseUrl: string;
}

export async function getPageTextTokens(data: ArrayBuffer, pageNumber: number, opts: GetPageTextTokensOptions): Promise<PageTextToken[]> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const page = await doc.getPage(pageNumber);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const tokens: PageTextToken[] = [];
  for (const item of tc.items as { str?: string; transform?: number[]; width?: number; fontName?: string }[]) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const transform = item.transform;
    const size = transform ? fontSizeFromTransform(transform as [number, number, number, number, number, number]) : 0;
    const x = transform?.[4] ?? 0;
    const y = transform?.[5] ?? 0;
    const w = item.width ?? 0;
    const fontKey = item.fontName ? (resolveFontKey(item.fontName, page.commonObjs, size) ?? undefined) : undefined;
    tokens.push({ text: str.trim(), bbox: { minX: x, maxX: x + w, minY: y, maxY: y + (size || 10) }, fontKey });
  }
  page.cleanup();
  return tokens;
}
