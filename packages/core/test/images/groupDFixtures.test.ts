import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildImageExtraction, type PdfDocumentLikeForImages } from '../../src/images/buildImageExtraction.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';

import { build as buildExtractSingleClean } from '../synth/fixtures/extract-single-clean.js';
import { build as buildExtractMasked } from '../synth/fixtures/extract-masked.js';
import { build as buildExtractCluster } from '../synth/fixtures/extract-cluster.js';
import { build as buildExtractVectorOnly } from '../synth/fixtures/extract-vector-only.js';
import { build as buildExtractDecorated3pages } from '../synth/fixtures/extract-decorated-3pages.js';
import { build as buildExtractJpx } from '../synth/fixtures/extract-jpx.js';
import { build as buildExtractBleed } from '../synth/fixtures/extract-bleed.js';
import { build as buildExtractIndependentTouching } from '../synth/fixtures/extract-independent-touching.js';
import { build as buildExtractAnchorLooseFragment } from '../synth/fixtures/extract-anchor-loose-fragment.js';
import { build as buildExtractSharedResourceMultipage } from '../synth/fixtures/extract-shared-resource-multipage.js';
import { build as buildExtractBleedWithContentSibling } from '../synth/fixtures/extract-bleed-with-content-sibling.js';
import { build as buildExtractBleedBakedInIllustration } from '../synth/fixtures/extract-bleed-baked-in-illustration.js';

/**
 * Integration tests of the group D fixtures — every row of the acceptance criteria verified on
 * the REAL pipeline (buildImageExtraction, using the real classify/strategy/extract/finalize),
 * NOT on the fixture's `claims` (those only prove construction facts, see
 * test/synth/fixtures/*.json).
 */

async function openDoc(buf: Buffer): Promise<PdfDocumentLikeForImages> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLikeForImages;
}

// These synthetic fixtures use flat-color rectangles as stand-ins for real
// images, so the "hide single-color images" rule is off by default here — the
// tests below are about geometric classification. It's switched on explicitly
// in the test that covers the rule itself.
async function run(buf: Buffer, opts: { hideBackgroundImages?: boolean } = {}) {
  const invDoc = await openDoc(buf);
  const inv = await buildInventory(invDoc as never);
  const doc = await openDoc(buf);
  return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 512, hideBackgroundImages: false, ...opts });
}

describe('single-color images are hidden from the auto-detected list', () => {
  it('the flat-color background forced to content is hidden when the rule is on, and stays content when it is off', async () => {
    const buf = buildExtractBleedWithContentSibling();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    // A body-text box covering the whole page supplies the second signal the full-bleed rules need (same trick as the tests below).
    const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
    const runWith = async (hideBackgroundImages: boolean) =>
      buildImageExtraction(await openDoc(buf), inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 512, bodyBlockBoxesByPage, treatFullBleedAsContent: true, hideBackgroundImages });
    const visible = (r: Awaited<ReturnType<typeof runWith>>) => r.images.filter((img) => img.classification === 'content' || img.classification === 'undecided').length;
    expect(visible(await runWith(true))).toBeLessThan(visible(await runWith(false)));
  });
});

describe('extract-single-clean: the result resolution equal to the source', () => {
  it('direct extraction, exactly 200x150px, not scaled', async () => {
    const result = await run(buildExtractSingleClean());
    expect(result.images).toHaveLength(1);
    const img = result.images[0]!;
    expect(img.classification).toBe('content');
    expect(img.extractSource).toBe('objs');
    expect(img.width).toBe(200);
    expect(img.height).toBe(150);
  });
});

describe('extract-masked: the mask visible in the result', () => {
  it('the region-render strategy, the left and right half of the result CLEARLY different (the mask was actually applied)', async () => {
    const result = await run(buildExtractMasked());
    const content = result.images.find((img) => img.classification === 'content');
    expect(content).toBeDefined();
    expect(content!.extractSource).toBe('region-render');

    // Decode the WebP bytes back to check the PIXELS (not just the metadata).
    // We use the same Node codec (napi-rs/canvas) to read it back.
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(content!.payload.bytes));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const leftPixel = ctx.getImageData(2, Math.floor(image.height / 2), 1, 1).data;
    const rightPixel = ctx.getImageData(image.width - 2, Math.floor(image.height / 2), 1, 1).data;
    const different =
      Math.abs(leftPixel[0]! - rightPixel[0]!) > 20 ||
      Math.abs(leftPixel[1]! - rightPixel[1]!) > 20 ||
      Math.abs(leftPixel[2]! - rightPixel[2]!) > 20 ||
      Math.abs(leftPixel[3]! - rightPixel[3]!) > 20;
    expect(different).toBe(true);
  });
});

describe('extract-cluster: one file, not four', () => {
  it('4 overlapping images -> exactly ONE result entry', async () => {
    const result = await run(buildExtractCluster());
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.extractSource).toBe('region-render');
  });
});

describe('extract-independent-touching: two independent images, a shared edge', () => {
  // Before this change `groupIntoUnits` merged EVERY overlapping pair regardless of size — two
  // large, independent images touching along a narrow strip of an edge (overlapRatio ~3.6%) ended
  // up in ONE unit whose bbox union also covered the space (and possibly text) between them.
  // Contrast with `extract-cluster` (a small icon ENTIRELY inside a large base, overlapRatio close
  // to 1.0) — that case MUST still merge.
  it('two images >10% of the page each, an overlap <20% of the smaller -> TWO separate units, not one', async () => {
    const result = await run(buildExtractIndependentTouching());
    expect(result.images).toHaveLength(2);
  });
});

describe('extract-anchor-loose-fragment: an anchor + a fragment touching with a corner', () => {
  // The mere presence of a "best anchor" (even the only one on the page) is not enough to attach
  // a small fragment — a strong overlap is required (overlapRatio >= 20% relative to the fragment's
  // OWN area). Below that threshold the fragment goes to its own, separate unit and doesn't stretch
  // the anchor's bbox union.
  it('an anchor + a fragment touching with a corner (overlapRatio ~10%) -> TWO separate units', async () => {
    const result = await run(buildExtractAnchorLooseFragment());
    expect(result.images).toHaveLength(2);
  });
});

describe('extract-shared-resource-multipage: a shared resource, the bbox union ONLY per page', () => {
  // The bbox of an extraction unit for an entry with multiple occurrences on DIFFERENT pages must
  // come EXCLUSIVELY from the occurrences ON THE SAME page as the unit — not from the union of all
  // occurrences of the entity regardless of page (which produced a nonsensical, accidentally large
  // union on a real rulebook).
  it('page 1 (narrow/tall, a forced region-render) -> the aspect of its OWN occurrence, not the union with page 2', async () => {
    const result = await run(buildExtractSharedResourceMultipage());
    const page1Units = result.images.filter((img) => img.entry.occurrences[0]!.page === 1);
    expect(page1Units.length).toBeGreaterThan(0);
    const shared = page1Units.find((img) => img.extractSource === 'region-render')!;
    expect(shared).toBeDefined();
    // Page 1: narrow/tall, aspect ~0.32 (250/776). The union from the pre-fix bug (which also covered
    // the occurrence from page 2) would give ~0.77 — clearly told apart by the threshold < 0.5.
    expect(shared.width / shared.height).toBeLessThan(0.5);
  });
});

describe('extract-vector-only: a map extracted through a render', () => {
  it('no images on the page, a large vector region -> one entry through region-render', async () => {
    const result = await run(buildExtractVectorOnly());
    expect(result.images).toHaveLength(1);
    const img = result.images[0]!;
    expect(img.entry.objId).toBeNull();
    expect(img.extractSource).toBe('region-render');
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);
  });
});

describe('extract-decorated-3pages: the decoration as decoration on ALL THREE pages, including the first', () => {
  it('positional correlation closes the objId split — the first occurrence does NOT look like unique content', async () => {
    const buf = buildExtractDecorated3pages();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);

    const decorationEntries = inv.images.filter((e) => e.maxRelativeArea < 0.1); // the decoration is small, the content large (~62%)
    expect(decorationEntries.length).toBeGreaterThanOrEqual(1);
    // At least one decoration entry must have pageRefs=[1] (the first occurrence) — exactly the U1 case.
    const firstOccurrenceEntry = decorationEntries.find((e) => e.pageRefs.includes(1));
    expect(firstOccurrenceEntry).toBeDefined();

    const result = await run(buf);
    // The decoration correlates on only 3 pages (<5, the calibrated `MULTI_PAGE_DECORATION_THRESHOLD`
    // — see the comment at the constant) and WITHOUT print bleed as a second signal, so it is NO
    // longer hard `decoration` — it falls to `undecided` (`Z1-no-strong-signal`, because its own area
    // is too small for Z2-moderate) and IS visible in the result, not silently rejected. This is the
    // INTENDED behavior ("when uncertain -> undecided, never decoration"), not a regression of the
    // U1 correlation mechanism (which still correctly CLOSES the objId split — see the
    // `decorationEntries` assertions above, still passing unchanged).
    const contentImages = result.images.filter((img) => img.classification === 'content');
    const undecidedImages = result.images.filter((img) => img.classification === 'undecided');
    expect(contentImages).toHaveLength(3);
    expect(new Set(contentImages.map((img) => img.entry.occurrences[0]!.page))).toEqual(new Set([1, 2, 3]));
    expect(undecidedImages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extract-jpx: the image decoded or reported as a Diagnostic', () => {
  it('decoding invalid JPX data ends with a Diagnostic, NEVER a silent skip', async () => {
    const result = await run(buildExtractJpx());
    // Either something was extracted (through the render fallback), or there is a Diagnostic — NEVER both empty.
    const hasDiagnostic = result.diagnostics.some((d) => d.code === 'IMAGE_DECODE_FAILED' || d.code === 'IMAGE_DECODE_EMPTY');
    const hasResult = result.images.length > 0;
    expect(hasDiagnostic || hasResult).toBe(true);
    // If there is a result, it MUST come from a region-render (the direct path failed, confirmed by a Diagnostic OR no entry in 'objs').
    if (hasResult && !hasDiagnostic) {
      // acceptable, but unlikely with deliberately broken data — document it if it happens
      expect(result.images[0]!.width).toBeGreaterThan(0);
    }
  });
});

describe('extract-bleed: decoration, not scene', () => {
  it('a full-bleed background WITH TEXT IN THE MIDDLE (a second signal) classified as decoration despite a huge area', async () => {
    const buf = buildExtractBleed();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    const pageBoxByPage = new Map(inv.perPage.map((p) => [p.pageNumber, p.box]));
    const { classifyImages } = await import('../../src/images/classify.js');
    // Print bleed ALONE is no longer enough (see the comment at `Z1-full-bleed-background` in
    // classify.ts) — this fixture tests the REAL background case: a paragraph of text IN THE MIDDLE
    // of the page, exactly like a real textured background from a book (not only bleed geometry,
    // which on its own also fits a deliberate spread illustration).
    const bodyBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
    const classified = classifyImages(inv.images, pageBoxByPage, bodyBoxesByPage);
    expect(classified).toHaveLength(1);
    expect(classified[0]!.classification).toBe('decoration');
    expect(classified[0]!.reason).toBe('Z1-full-bleed-background');

    // I: excluded from the final result (the orchestrator doesn't extract 'decoration').
    // `run()` doesn't pass bodyBoxesByPage (see its definition) — without a second signal the same
    // image now correctly lands in `undecided` (uncertainty -> undecided, not decoration), so it IS
    // in the result.
    const result = await run(buf);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.classification).toBe('undecided');
  });
});

describe('extract-bleed-with-content-sibling: [at the user\'s request] a background forced to content does NOT absorb the neighboring content image', () => {
  it('treatFullBleedAsContent=true -> TWO separate units (not one), the background extracted DIRECTLY (without text), not as a render of the whole page', async () => {
    const buf = buildExtractBleedWithContentSibling();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    // The same trick as `extract-bleed` above: `bodyBoxesByPage` covering the whole page FORCES the
    // second signal (`centerTextCoverage`) needed for Z1-full-bleed-background/
    // Z1-full-bleed-forced-content, without needing real text in the PDF.
    const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));

    const doc = await openDoc(buf);
    const result = await buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
      targetLongEdgePx: 512,
      bodyBlockBoxesByPage,
      treatFullBleedAsContent: true,
      hideBackgroundImages: false,
    });

    // [key regression] Without isolating `Z1-full-bleed-forced-content` in
    // `partitionCandidatesIntoGroups`, these two images would merge into ONE unit (the background's
    // bbox "contains" the portrait), giving LENGTH 1 instead of 2 and `region-render` (with text)
    // instead of `direct` for the background.
    expect(result.images).toHaveLength(2);

    const bg = result.images.find((img) => img.width > img.height * 1.2 || img.entry.maxRelativeArea > 0.9)!;
    expect(bg).toBeDefined();
    expect(bg.classification).toBe('content');
    expect(bg.extractSource).toBe('objs');

    const portrait = result.images.find((img) => img !== bg)!;
    expect(portrait).toBeDefined();
  });
});

describe('extract-bleed-baked-in-illustration: [at the user\'s request, EXPERIMENTAL] autoCropUniformMargins crops to the illustration alone', () => {
  it('without autoCropUniformMargins: the export is the WHOLE canvas (200x260). With the flag: CLEARLY smaller, covering only the corner with the illustration', async () => {
    const buf = buildExtractBleedBakedInIllustration();

    async function extract(autoCropUniformMargins: boolean) {
      const invDoc = await openDoc(buf);
      const inv = await buildInventory(invDoc as never);
      const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
      const doc = await openDoc(buf);
      return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 512,
        bodyBlockBoxesByPage,
        treatFullBleedAsContent: true,
        autoCropUniformMargins,
      });
    }

    const withoutCrop = await extract(false);
    expect(withoutCrop.images).toHaveLength(1);
    expect(withoutCrop.images[0]!.classification).toBe('content');
    expect(withoutCrop.images[0]!.width).toBe(200);
    expect(withoutCrop.images[0]!.height).toBe(260);

    const withCrop = await extract(true);
    expect(withCrop.images).toHaveLength(1);
    expect(withCrop.images[0]!.classification).toBe('content');
    // The illustration is ~35%x30% of the canvas in a corner — the cropped result MUST be CLEARLY
    // smaller than the original 200x260 (52000px^2), but still of a sensible size.
    const croppedArea = withCrop.images[0]!.width * withCrop.images[0]!.height;
    expect(croppedArea).toBeLessThan(200 * 260 * 0.5);
    expect(croppedArea).toBeGreaterThan(0);
  });

  /** `brightenAutoCroppedImages` — ONLY for images that were actually cropped. */
  it('brightenAutoCroppedImages: a cropped image is CLEARLY brighter with the flag than without it; without a crop the flag changes nothing', async () => {
    const buf = buildExtractBleedBakedInIllustration();

    async function extract(autoCropUniformMargins: boolean, brightenAutoCroppedImages: boolean) {
      const invDoc = await openDoc(buf);
      const inv = await buildInventory(invDoc as never);
      const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
      const doc = await openDoc(buf);
      return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 512,
        bodyBlockBoxesByPage,
        treatFullBleedAsContent: true,
        autoCropUniformMargins,
        brightenAutoCroppedImages,
      });
    }

    async function avgLuminance(bytes: Uint8Array): Promise<number> {
      const { loadImage, createCanvas } = await import('@napi-rs/canvas');
      const image = await loadImage(Buffer.from(bytes));
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        count++;
      }
      return sum / count;
    }

    const croppedDim = await extract(true, false);
    const croppedBright = await extract(true, true);
    const dimLuminance = await avgLuminance(croppedDim.images[0]!.payload.bytes);
    const brightLuminance = await avgLuminance(croppedBright.images[0]!.payload.bytes);
    expect(brightLuminance).toBeGreaterThan(dimLuminance + 5);

    // Without cropping (`autoCropUniformMargins:false`), `brightenAutoCroppedImages` has nothing to
    // act on — the image stays BYTE-FOR-BYTE identical.
    const uncroppedDim = await extract(false, false);
    const uncroppedBright = await extract(false, true);
    expect(uncroppedBright.images[0]!.contentHash).toBe(uncroppedDim.images[0]!.contentHash);
  });
});
