import { createCanvas } from '@napi-rs/canvas';
import { renderRegionShared, type PdfPageForRender, type RegionRenderer, type RenderRegionOptions } from './regionRenderer.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import type { Rect } from '../geometry.js';

/**
 * Implementacja Node (`@napi-rs/canvas`, backend Skia) — WYLACZNIE do testow i
 * `tools/calibrate-images.ts`. CELOWO NIEEKSPORTOWANA z `src/index.ts`: to
 * natywny dodatek (`.node` binarny per platforma), ktorego bundler (Vite w
 * `packages/module`) nie potrafi zbundlowac do przegladarki — gdyby ten import
 * byl osiagalny z publicznego barrelu, `packages/module`'s build probowalby go
 * rozwiazac i albo padnie, albo wciagnie natywny binarny plik w kod
 * przegladarki. Ten sam wzorzec ostroznosci co zewnetryzacja `pdfjs-dist` w
 * `vite.config.ts` (packages/core) — importuj ten plik WYLACZNIE bezposrednio
 * ze zrodel core (`../../src/images/nodeCanvasRenderer.js`), nigdy przez
 * zbudowany `@bindery/core`.
 */
export const nodeCanvasRegionRenderer: RegionRenderer = {
  renderRegion(page: PdfPageForRender, bbox: Rect, opts: RenderRegionOptions): Promise<DecodedImage> {
    return renderRegionShared(page, bbox, opts, (w, h) => {
      const canvas = createCanvas(w, h);
      return canvas.getContext('2d');
    });
  },
};
