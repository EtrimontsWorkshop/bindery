import type { Rect } from '../geometry.js';
import type { EncodedImage, EncodeOptions, ImageEncoder } from './encodeImage.js';
import type { PdfPageForRender, RegionRenderer } from './regionRenderer.js';

/**
 * [KROK-11 Z3] Render CALEJ strony (nie pojedynczego obrazu) do bitmapy —
 * potrzebne dla panelu podgladu strony PDF w ekranie przegladu (faza 9).
 * Zadnej NOWEJ logiki renderu — `RegionRenderer`/`ImageEncoder` z kroku 7
 * juz robia dokladnie to, czego trzeba (render dowolnego bboksa strony,
 * zakodowanie do WebP/PNG); ten plik to CIENKI orkiestrator, ktory po prostu
 * przekazuje bbox CALEJ strony zamiast bboksu pojedynczego obrazu — mirror
 * wzorca `buildImageExtraction.ts`/`buildPageLayout.ts` (jeden entry point
 * spinajacy juz istniejace kawalki), nie nowy mechanizm.
 *
 * `renderer`/`encoder` sa wstrzykiwane (nie zaszyte na sztywno
 * `browserRegionRenderer`/`browserImageEncoder`) — ten sam powod co w
 * `buildImageExtraction.ts`: testowalnosc w Node (`nodeCanvasRenderer.ts`/
 * `nodeCanvasImageEncoder.ts`, celowo NIEEKSPORTOWANE z `index.ts`), warstwa
 * Foundry (`packages/module`) wstrzykuje `browserRegionRenderer`/
 * `browserImageEncoder` (jedyne prawdziwe implementacje w przegladarce, A1).
 */

export interface RenderPagePreviewOptions {
  /** Docelowa dlugosc dluzszej krawedzi wyniku w pikselach — patrz `RenderRegionOptions`. */
  targetLongEdgePx: number;
  signal?: AbortSignal;
  format?: EncodeOptions['format'];
  quality?: EncodeOptions['quality'];
}

/**
 * Renderuje CALA strone (bbox = `pageBox`, typowo z `InventoryResult.perPage[].box`,
 * juz policzony przez inwentaryzacje — krok 4 — zeby uniknac ponownego
 * odczytywania `page.view` tutaj) do zakodowanej bitmapy gotowej na `<img>`.
 */
export async function renderPagePreview(
  page: PdfPageForRender,
  pageBox: Rect,
  renderer: RegionRenderer,
  encoder: ImageEncoder,
  opts: RenderPagePreviewOptions,
): Promise<EncodedImage> {
  const decoded = await renderer.renderRegion(page, pageBox, { targetLongEdgePx: opts.targetLongEdgePx, signal: opts.signal });
  return encoder.encode(decoded, { format: opts.format, quality: opts.quality });
}
