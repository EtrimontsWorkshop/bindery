import { createCanvas } from '@napi-rs/canvas';
import { renderRegionShared, type PdfPageForRender, type RegionRenderer, type RenderRegionOptions } from './regionRenderer.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import type { Rect } from '../geometry.js';

/**
 * Node implementation (`@napi-rs/canvas`, Skia backend) — EXCLUSIVELY for
 * tests and `tools/calibrate-images.ts`. DELIBERATELY NOT EXPORTED from
 * `src/index.ts`: it's a native addon (a per-platform `.node` binary) that
 * the bundler (Vite in `packages/module`) can't bundle for the browser — if
 * this import were reachable from the public barrel, `packages/module`'s
 * build would try to resolve it and either fail outright or pull a native
 * binary file into browser code. The same caution pattern as externalizing
 * `pdfjs-dist` in `vite.config.ts` (packages/core) — import this file
 * EXCLUSIVELY directly from core's sources
 * (`../../src/images/nodeCanvasRenderer.js`), never through the built
 * `@bindery/core`.
 */
export const nodeCanvasRegionRenderer: RegionRenderer = {
  renderRegion(page: PdfPageForRender, bbox: Rect, opts: RenderRegionOptions): Promise<DecodedImage> {
    return renderRegionShared(page, bbox, opts, (w, h) => {
      const canvas = createCanvas(w, h);
      return canvas.getContext('2d');
    });
  },
};
