import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from './geometry.js';
import { browserImageEncoder, type EncodedImage, type EncodeOptions } from './images/encodeImage.js';
import { browserRegionRenderer } from './images/regionRenderer.js';
import { renderPagePreview } from './images/buildPagePreview.js';
import { renderRotatedRegion, type RotatedPdfRegion } from './images/renderRotatedRegion.js';

/**
 * [KROK-11 Z3] Otwiera dokument WYLACZNIE do celow podgladu strony w ekranie
 * przegladu (faza 9) — NIE ponownie liczy inwentaryzacji/ukladu (to juz
 * zrobil `buildCIFFromDocument`, patrz `buildCIFFromDocument.ts`). Zamierzenie:
 * lekki, osobny "uchwyt" dokumentu, ktory panel podgladu strony w
 * `packages/module` trzyma otwarty przez caly czas trwania przegladu i
 * odpytuje O DOWOLNA strone w dowolnej kolejnosci (uzytkownik przewija/klika
 * `provenance.pageNumber`), bez ponownego otwierania calego dokumentu za
 * kazdym razem.
 *
 * Box strony (`getPageBox`) czyta WYLACZNIE `page.view` (ten sam mechanizm co
 * `inventory.ts`'s `viewToRect`) — NIGDY `getOperatorList()` (kosztowne,
 * niepotrzebne tutaj) — i cache'uje wynik per numer strony, wiec powtorna
 * nawigacja do tej samej strony nie odpytuje pdf.js ponownie.
 */

export interface PreviewPageHandle {
  pageNumber: number;
  box: Rect;
  rotation: number;
}

/** [KROK-18] Jak `EncodedImage`, ale z wymiarami PIKSELOWYMI zdekodowanej bitmapy PRZED kodowaniem — potrzebne wolajacemu, zeby zbudowac `CIFImage.width/height` bez ponownego dekodowania WebP/PNG w przegladarce. */
export interface RegionCrop extends EncodedImage {
  width: number;
  height: number;
}

export interface PreviewDocument {
  pageCount: number;
  /** Box strony w przestrzeni PDF (MediaBox po `page.view`) — cache'owany po pierwszym zapytaniu o dana strone. */
  getPageBox(pageNumber: number): Promise<PreviewPageHandle>;
  /** Renderuje CALA strone do zakodowanej bitmapy (WebP/PNG) — patrz `renderPagePreview`. */
  renderPage(pageNumber: number, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<EncodedImage>;
  /**
   * [KROK-18, "Zaznacz i wytnij"] Renderuje DOWOLNY bbox (w przestrzeni PDF,
   * niekoniecznie caly `pageBox`) do zakodowanej bitmapy — reczny odpowiednik
   * `buildImageExtraction.ts`'s automatycznej ekstrakcji, dla obszaru
   * wskazanego PRZEZ UZYTKOWNIKA (przeciagniecie myszki po podgladzie strony
   * w `packages/module`), nie wykrytego automatycznie. Zwraca `RegionCrop`
   * (nie goly `EncodedImage` jak `renderPage`) — wolajacy potrzebuje
   * `width`/`height`, zeby od razu zbudowac `CIFImage` bez dodatkowego
   * dekodowania bajtow WebP w przegladarce.
   */
  renderRegion(pageNumber: number, bbox: Rect, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<RegionCrop>;
  /**
   * [zgloszenie uzytkownika, "Zaznacz i wytnij" — mozliwosc obrocenia
   * zaznaczonego obszaru] Jak `renderRegion`, ale `region` NIE musi byc
   * rownolegly do osi — patrz `renderRotatedRegion.ts` po pelne uzasadnienie
   * (renderuje otoczke normalnie, potem "prostuje" wlasciwy, obrocony
   * prostokat czysto pikselowo).
   */
  renderRotatedRegion(pageNumber: number, region: RotatedPdfRegion, opts: { targetLongEdgePx: number; signal?: AbortSignal; format?: EncodeOptions['format']; quality?: EncodeOptions['quality'] }): Promise<RegionCrop>;
  /** Zwalnia zasoby pdf.js (worker, cache dokumentu) — MUSI zostac wywolane, gdy ekran przegladu sie zamyka. */
  destroy(): Promise<void>;
}

export interface OpenPreviewDocumentOptions {
  assetBaseUrl: string;
}

export async function openPreviewDocument(data: ArrayBuffer, opts: OpenPreviewDocumentOptions): Promise<PreviewDocument> {
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;
  // `PDFDocumentProxy` (wynik `.promise`) NIE ma wlasnego `destroy()` — nalezy
  // on do `PDFDocumentLoadingTask` (obiekt zwrocony PRZEZ `getDocument()`,
  // zanim jeszcze `.promise` sie rozwiaze) — stad trzymamy OBA.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  });
  const doc = await loadingTask.promise;

  const boxCache = new Map<number, PreviewPageHandle>();

  async function getPageBox(pageNumber: number): Promise<PreviewPageHandle> {
    const cached = boxCache.get(pageNumber);
    if (cached) return cached;
    const page = await doc.getPage(pageNumber);
    const [x0, y0, x1, y1] = page.view;
    const handle: PreviewPageHandle = {
      pageNumber,
      box: { minX: x0 ?? 0, minY: y0 ?? 0, maxX: x1 ?? 0, maxY: y1 ?? 0 },
      rotation: page.rotate ?? 0,
    };
    page.cleanup();
    boxCache.set(pageNumber, handle);
    return handle;
  }

  return {
    pageCount: doc.numPages,
    getPageBox,
    async renderPage(pageNumber, renderOpts) {
      const { box } = await getPageBox(pageNumber);
      const page = await doc.getPage(pageNumber);
      try {
        return await renderPagePreview(page as never, box, browserRegionRenderer, browserImageEncoder, renderOpts);
      } finally {
        page.cleanup();
      }
    },
    async renderRegion(pageNumber, bbox, renderOpts) {
      const page = await doc.getPage(pageNumber);
      try {
        const decoded = await browserRegionRenderer.renderRegion(page as never, bbox, { targetLongEdgePx: renderOpts.targetLongEdgePx, signal: renderOpts.signal });
        const encoded = await browserImageEncoder.encode(decoded, { format: renderOpts.format, quality: renderOpts.quality });
        return { ...encoded, width: decoded.width, height: decoded.height };
      } finally {
        page.cleanup();
      }
    },
    async renderRotatedRegion(pageNumber, region, renderOpts) {
      const page = await doc.getPage(pageNumber);
      try {
        const decoded = await renderRotatedRegion(page as never, region, browserRegionRenderer, { targetLongEdgePx: renderOpts.targetLongEdgePx, signal: renderOpts.signal });
        const encoded = await browserImageEncoder.encode(decoded, { format: renderOpts.format, quality: renderOpts.quality });
        return { ...encoded, width: decoded.width, height: decoded.height };
      } finally {
        page.cleanup();
      }
    },
    async destroy() {
      await loadingTask.destroy();
    },
  };
}
