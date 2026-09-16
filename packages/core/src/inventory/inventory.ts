import type { Rect } from '../geometry.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { buildFontKey, rankFontRoles, stripSubsetPrefix, type FontEntry, type FontRole } from './fontRegistry.js';
import { buildImageEntries, type ImageEntry, type PageImageEvents } from './imageRegistry.js';
import { buildVectorRegions, type VectorRegion } from './vectorRegistry.js';
import { walkOperators } from './walkOperators.js';

/**
 * Orkiestracja przebiegu inwentaryzacyjnego (MDD zal. A8, KROK-4 Z5).
 * Strona po stronie, sekwencyjnie — NIGDY Promise.all na wszystkich stronach
 * (reguła wydajnościowa #2 z MDD §12). Zero `objs.get()`, zero `render()`.
 */

export interface InventoryResult {
  pageCount: number;
  fonts: FontEntry[];
  fontRoles: Map<string, FontRole>;
  images: ImageEntry[];
  vectors: VectorRegion[];
  perPage: { pageNumber: number; box: Rect; rotation: number }[];
}

export interface BuildInventoryOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Duck-typed podzbior `PDFPageProxy` faktycznie uzywany tutaj — pozwala
 * testowac orkiestracje bez prawdziwego dokumentu pdf.js.
 */
export interface PdfPageLike {
  view: readonly number[];
  rotate: number;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

function viewToRect(view: readonly number[]): Rect {
  const [x0, y0, x1, y1] = view;
  return { minX: x0 ?? 0, minY: y0 ?? 0, maxX: x1 ?? 0, maxY: y1 ?? 0 };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('buildInventory przerwane przez AbortSignal', 'AbortError');
  }
}

interface FontAccumulator {
  baseFont: string;
  size: number;
  glyphCount: number;
  itemCount: number;
  pages: Set<number>;
}

export async function buildInventory(
  doc: PdfDocumentLike,
  opts: BuildInventoryOptions = {},
): Promise<InventoryResult> {
  const { signal, onProgress } = opts;
  const pageCount = doc.numPages;

  const perPage: { pageNumber: number; box: Rect; rotation: number }[] = [];
  const perPageImageEvents: PageImageEvents[] = [];
  const allVectors: VectorRegion[] = [];
  const fontAccByKey = new Map<string, FontAccumulator>();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);

    const page = await doc.getPage(pageNumber);
    try {
      const pageBox = viewToRect(page.view);
      perPage.push({ pageNumber, box: pageBox, rotation: page.rotate ?? 0 });

      // JEDNO przejscie po operator liscie tej strony — obrazy, wektory, grupy.
      const ops = await page.getOperatorList();
      checkAborted(signal);
      const events = walkOperators(ops, pageBox);

      perPageImageEvents.push({ page: pageNumber, pageBox, events });
      allVectors.push(...buildVectorRegions(events, pageNumber, pageBox));

      // Fingerprinting fontow: getTextContent() jest OSOBNYM wywolaniem pdf.js
      // (nie drugim przejsciem po fnArray z operator listy) — potrzebne do
      // realnych liczb glifow per font, ktorych operator lista sama nie daje
      // w formie wygodnej do zliczania bez duplikowania logiki pdf.js.
      // commonObjs jest juz wypelnione dzieki getOperatorList() powyzej (F0-Q1) —
      // nie wymaga renderu.
      const textContent = await page.getTextContent();
      checkAborted(signal);
      for (const item of textContent.items as Array<Record<string, unknown>>) {
        if (typeof item['str'] !== 'string' || item['str'].length === 0) continue;
        const fontName = item['fontName'] as string | undefined;
        if (!fontName || !page.commonObjs.has(fontName)) continue;
        const fontObj = page.commonObjs.get(fontName) as { name?: string } | undefined;
        const baseFont = fontObj?.name;
        if (!baseFont) continue;

        // [KROK-9, odkrycie] MUSI byc DOKLADNIE ta sama formula co
        // `fontSizeFromTransform` (layout/textGeometry.ts, uzywana przez cala
        // dalsza warstwe tekstu/layoutu do budowy `TextLine.dominantFont.key`) —
        // przed ta poprawka ten plik liczyl rozmiar z transform[2]/[3] (os Y),
        // podczas gdy `fontSizeFromTransform` liczy z transform[0]/[1] (os X).
        // Dla tekstu ze skalowaniem poziomym (`Tz`, fonty condensed/expanded)
        // te dwie wartosci ROZNIE SIE, wiec `buildFontKey` produkowal RozNY
        // klucz niz ten, ktory faktycznie trafial do `TextLine` — linie
        // uzywajace takiego fontu nigdy nie znajdowaly swojej roli w
        // `fontRoles` (kluczy brakowalo w rejestrze), co zmierzono jako 284/369
        // blokow `unknown` na Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf majacych
        // dominujacy klucz `CaxtonStd-Book@7.5`, ktorego NIE BYLO w `inv.fonts`
        // (prawdziwy rejestr mial `CaxtonStd-Book@8` i `@8.5`, zbudowane ta
        // sama formula co teraz tutaj).
        const transform = item['transform'] as number[] | undefined;
        const size = transform ? fontSizeFromTransform(transform) : 0;
        const key = buildFontKey(baseFont, size);

        let acc = fontAccByKey.get(key);
        if (!acc) {
          acc = { baseFont, size: Math.round(size * 2) / 2, glyphCount: 0, itemCount: 0, pages: new Set() };
          fontAccByKey.set(key, acc);
        }
        acc.glyphCount += (item['str'] as string).length;
        acc.itemCount += 1;
        acc.pages.add(pageNumber);
      }
    } finally {
      // Zmierzone w fazie 0: oszczedza 33% pamieci przy zerowym koszcie czasu.
      page.cleanup();
    }

    onProgress?.(pageNumber, pageCount);
  }

  const images = buildImageEntries(perPageImageEvents);

  const fonts: FontEntry[] = [...fontAccByKey.entries()]
    .map(([key, acc]) => {
      const { prefix } = stripSubsetPrefix(acc.baseFont);
      const entry: FontEntry = {
        key,
        baseFont: stripSubsetPrefix(acc.baseFont).name,
        subsetPrefix: prefix,
        size: acc.size,
        glyphCount: acc.glyphCount,
        itemCount: acc.itemCount,
        pages: acc.pages,
      };
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const fontRoles = rankFontRoles(fonts);

  // Determinizm: kolejnosc ustalona po stabilnym kluczu, nie po kolejnosci
  // iteracji Map/Set (wektory sortowane po stronie, potem po bbox).
  allVectors.sort((a, b) => a.page - b.page || a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY);

  return {
    pageCount,
    fonts,
    fontRoles,
    images,
    vectors: allVectors,
    perPage,
  };
}
