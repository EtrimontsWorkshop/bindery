import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildImageExtraction, type PdfDocumentLikeForImages } from '../../src/images/buildImageExtraction.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';
import { build as buildImagesLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildImagesOverlapping } from '../synth/fixtures/images-overlapping.js';
import { build as buildExtractDecorated3pages } from '../synth/fixtures/extract-decorated-3pages.js';

async function openDoc(buf: Buffer): Promise<PdfDocumentLikeForImages> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLikeForImages;
}

async function run(buf: Buffer) {
  const invDoc = await openDoc(buf);
  const inv = await buildInventory(invDoc as never);
  const doc = await openDoc(buf);
  return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 256 });
}

/**
 * Integration tests of the orchestrator on fixtures built independently of it — deliberately
 * limited to what those fixtures actually justify: the mask (region-render instead of the raw
 * mask-less resource) and the cluster (one result, not N). Scenarios that require specific
 * classification thresholds (unambiguous content, a purely vector region covering the page, a
 * decoration on many pages next to real content) have their OWN, deliberately built fixtures
 * (`test/synth/fixtures/extract-*.ts`) — see `buildImageExtraction.groupD.test.ts`.
 */
describe('buildImageExtraction — an integration of the full pipeline on real fixtures', () => {
  it('a masked image (small, below the large-area threshold) goes through a region-render, not a raw extraction without the mask', async () => {
    const result = await run(buildImagesLuminosityMask());
    // The mask form itself ('mask') is excluded from the result; only the masked resource remains.
    expect(result.images).toHaveLength(1);
    const maskedContent = result.images[0]!;
    expect(maskedContent.classification).not.toBe('mask');
    expect(maskedContent.extractSource).toBe('region-render');
    expect(maskedContent.width).toBeGreaterThan(0);
  }, 30000);

  it('a cluster of overlapping images (a base + 4 icons on it) gives ONE entry; a completely separate image gives a SECOND', async () => {
    const result = await run(buildImagesOverlapping());
    // 6 images: 5 mutually overlapping (a cluster) + 1 completely separate (no overlap).
    expect(result.images).toHaveLength(2);
    const clustered = result.images.find((img) => img.extractSource === 'region-render');
    expect(clustered).toBeDefined();
  }, 30000);

  it('determinism: two runs on the same file give identical metadata and hashes (we don\'t compare the raw render pixels, only the content hash)', async () => {
    const buf = buildImagesLuminosityMask();
    const r1 = await run(buf);
    const r2 = await run(buf);
    const strip = (r: Awaited<ReturnType<typeof run>>) =>
      r.images
        .map((img) => ({
          objId: img.entry.objId,
          classification: img.classification,
          contentHash: img.contentHash,
          width: img.width,
          height: img.height,
          targetKind: img.targetKind,
        }))
        .sort((a, b) => (a.objId ?? '').localeCompare(b.objId ?? ''));
    expect(JSON.stringify(strip(r1))).toBe(JSON.stringify(strip(r2)));
    expect(r1.correlationClosedByBBox).toBe(r2.correlationClosedByBBox);
    expect(r1.correlationClosedByHash).toBe(r2.correlationClosedByHash);
  }, 30000);

  it('an AbortSignal interrupts IN THE MIDDLE — after the first of three units, not only when already aborted at the start', async () => {
    // `extract-decorated-3pages` has 3 pages, EACH with its own extraction unit (a separate content
    // image per page) — enough to tell "aborted at the start" (test below) from "aborted DURING the
    // loop over units".
    const buf = buildExtractDecorated3pages();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    const doc = await openDoc(buf);
    const controller = new AbortController();
    let progressCalls = 0;
    await expect(
      buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 256,
        signal: controller.signal,
        onProgress: (done) => {
          progressCalls++;
          if (done === 1) controller.abort(); // abort AFTER the first unit, BEFORE the second
        },
      }),
    ).rejects.toThrow();
    // Proof that the abort really happened IN THE MIDDLE (at least one unit had been processed
    // BEFORE the AbortError was raised), not right at the start.
    expect(progressCalls).toBeGreaterThanOrEqual(1);
    expect(progressCalls).toBeLessThan(3);
  }, 30000);

  it('an already aborted AbortSignal aborts the whole extraction immediately, even when there are no units to process', async () => {
    const invDoc = await openDoc(buildImagesLuminosityMask());
    const inv = await buildInventory(invDoc as never);
    const doc = await openDoc(buildImagesLuminosityMask());
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 256, signal: controller.signal }),
    ).rejects.toThrow();
  }, 30000);
});
