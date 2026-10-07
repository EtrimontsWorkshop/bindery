import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory, type PdfDocumentLike } from '../../src/inventory/inventory.js';

import { build as buildImagesDecorated } from '../synth/fixtures/images-decorated.js';
import { build as buildImagesLuminosityMask } from '../synth/fixtures/images-luminosity-mask.js';
import { build as buildImagesBleedBackground } from '../synth/fixtures/images-bleed-background.js';
import { build as buildImagesOverlapping } from '../synth/fixtures/images-overlapping.js';
import { build as buildImagesMaskOpcode } from '../synth/fixtures/images-mask-opcode.js';
import { build as buildImagesMaskGeometry } from '../synth/fixtures/images-mask-geometry.js';
import { build as buildVectorsRectangle } from '../synth/fixtures/vectors-rectangle.js';
import { build as buildFontsNoSuffix } from '../synth/fixtures/fonts-no-suffix.js';
import { build as buildFontsSubsetPrefix } from '../synth/fixtures/fonts-subset-prefix.js';

/** pdfjs-dist's PDFDocumentProxy is structurally compatible with PdfDocumentLike. */
async function openFixture(buf: Buffer): Promise<PdfDocumentLike> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLike;
}

describe('buildInventory — images-decorated (pageRefs)', () => {
  it('a decoration shared by 3 pages does NOT get a stable objId on every page (a pdf.js discovery)', async () => {
    const doc = await openFixture(buildImagesDecorated());
    const inv = await buildInventory(doc);
    expect(inv.pageCount).toBe(3);

    // EMPIRICAL DISCOVERY: pdf.js does NOT assign the same PDF resource a stable objId from its
    // first occurrence. The first use (page 1) gets a local id like "img_p0_1"; only after repeated
    // use does pdf.js "promote" the resource to a shared id like "g_d0_..." — that id IS stable on
    // subsequent pages (2 and 3), but differs from the first occurrence. Consequence: the same PDF
    // image falls apart into TWO ImageEntries from the point of view of a single-pass inventory
    // without decoding pixels — merging would need a content fingerprint, deferred to the image
    // classification stage.
    const withTwoPages = inv.images.filter((img) => img.pageRefs.length === 2);
    expect(withTwoPages).toHaveLength(1); // the decoration after pdf.js "promotion" (pages 2+3)

    const withOnePage = inv.images.filter((img) => img.pageRefs.length === 1);
    // 54 unique images x 3 pages = 162, + the first (non-promoted) occurrence of the decoration on page 1
    expect(withOnePage.length).toBe(163);

    // Positional correlation by the quantized bbox CLOSES exactly this case: the decoration has an
    // identical bbox on every use (a fixed element of the page template), so both split entries
    // should end up linked.
    const twoPageEntry = withTwoPages[0]!;
    const decorFirstUse = withOnePage.find((img) => img.correlatedWith === twoPageEntry.objId);
    expect(decorFirstUse).toBeDefined();
    expect(decorFirstUse!.occurrences[0]!.bbox).toEqual(twoPageEntry.occurrences[0]!.bbox);
  });
});

describe('buildInventory — images-luminosity-mask (the group path)', () => {
  it('the mask has isMaskLayer=true, maskEvidence="group"', async () => {
    const doc = await openFixture(buildImagesLuminosityMask());
    const inv = await buildInventory(doc);
    const masked = inv.images.filter((img) => img.maskEvidence === 'group');
    expect(masked).toHaveLength(1);
    expect(masked[0]!.isMaskLayer).toBe(true);
  });
});

describe('buildInventory — images-mask-opcode (the opcode path)', () => {
  it('a paintImageMaskXObject mask has isMaskLayer=true, maskEvidence="opcode"', async () => {
    const doc = await openFixture(buildImagesMaskOpcode());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(2);

    // pdf.js assigns its own object ids (e.g. "mask_p0_1"/"img_p0_2"), independent of the names of
    // the /XObject dictionary keys used in the content stream — we don't assume specific strings,
    // we only tell them apart by maskEvidence.
    const maskEntry = inv.images.find((img) => img.maskEvidence === 'opcode');
    expect(maskEntry?.isMaskLayer).toBe(true);

    const contentEntry = inv.images.find((img) => img.maskEvidence === null);
    expect(contentEntry?.isMaskLayer).toBe(false);
  });
});

describe('buildInventory — images-mask-geometry (the geometry path, a positive case)', () => {
  it('Over1 gets maskEvidence="geometry" (the bbox identical to Under1, index diff=2); Control1 without evidence', async () => {
    const doc = await openFixture(buildImagesMaskGeometry());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(3);

    const geometryMatches = inv.images.filter((img) => img.maskEvidence === 'geometry');
    expect(geometryMatches).toHaveLength(1);
    expect(geometryMatches[0]!.isMaskLayer).toBe(false); // geometry is weak evidence — doesn't set isMaskLayer

    const withoutEvidence = inv.images.filter((img) => img.maskEvidence === null);
    expect(withoutEvidence).toHaveLength(2); // Under1 i Control1
  });
});

describe('buildInventory — images-bleed-background (the bbox not clipped)', () => {
  it('a bbox with negative coordinates preserved without clipping to the MediaBox', async () => {
    const doc = await openFixture(buildImagesBleedBackground());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(1);
    const bbox = inv.images[0]!.occurrences[0]!.bbox;
    expect(bbox.minX).toBeLessThan(0);
    expect(bbox.minY).toBeLessThan(0);
    expect(bbox.maxX).toBeGreaterThan(612); // wider than the MediaBox
    expect(bbox.maxY).toBeGreaterThan(792);
  });
});

describe('buildInventory — images-overlapping (clustering)', () => {
  it('5 overlapping images in one clusterId, the sixth separate; no false geometry hits', async () => {
    const doc = await openFixture(buildImagesOverlapping());
    const inv = await buildInventory(doc);
    expect(inv.images).toHaveLength(6);

    const clusterCounts = new Map<string, number>();
    for (const img of inv.images) {
      if (!img.clusterId) continue;
      clusterCounts.set(img.clusterId, (clusterCounts.get(img.clusterId) ?? 0) + 1);
    }
    const sizes = [...clusterCounts.values()].sort((a, b) => b - a);
    // Fixture: a base + 4 icons overlapping it (directly confirmed empirically after fixing the CTM
    // bug in walkOperators — the geometry shows that ALL 4 icons (not 3) really overlap the base), +
    // 1 icon completely separate (no overlap).
    expect(sizes[0]).toBe(5); // a base + 4 overlapping icons
    expect(sizes[1]).toBe(1); // an isolated icon no. 6

    // None of these images should get geometry-mask-evidence merely because the bboxes overlap —
    // geometry ALSO requires the `index` proximity (<=3) AND >=95% coverage; the images of this
    // fixture are drawn far apart.
    const falsePositives = inv.images.filter((img) => img.maskEvidence === 'geometry');
    expect(falsePositives).toHaveLength(0);
  });
});

describe('buildInventory — vectors-rectangle (constructPath through a real pdf.js)', () => {
  it('fill and fillStroke (B) give correct VectorRegions, including TWO events for fillStroke', async () => {
    const doc = await openFixture(buildVectorsRectangle());
    const inv = await buildInventory(doc);
    expect(inv.vectors).toHaveLength(3); // 1x fill + (1x fill + 1x stroke for fillStroke/B)

    const fillOnly = inv.vectors.find((v) => v.bbox.minX === 100);
    expect(fillOnly?.kind).toBe('fill');
    expect(fillOnly?.bbox).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 150 });

    const fillStrokePair = inv.vectors.filter((v) => v.bbox.minX === 350);
    expect(fillStrokePair.map((v) => v.kind).sort()).toEqual(['fill', 'stroke']);
    expect(fillStrokePair[0]!.bbox).toEqual({ minX: 350, minY: 400, maxX: 430, maxY: 480 });
  });
});

describe('buildInventory — fonts (fonts-no-suffix, fonts-subset-prefix)', () => {
  it('fonts-no-suffix: 3 font keys, each with an assigned role, regardless of the lack of suffixes', async () => {
    const doc = await openFixture(buildFontsNoSuffix());
    const inv = await buildInventory(doc);
    expect(inv.fonts.length).toBeGreaterThanOrEqual(3);
    for (const font of inv.fonts) {
      expect(inv.fontRoles.get(font.key)).toBeDefined();
    }
    const bodyCount = [...inv.fontRoles.values()].filter((r) => r === 'body').length;
    expect(bodyCount).toBe(1); // exactly one "body" font (the largest share)
  });

  it('fonts-subset-prefix: the AAAAAH+ prefix stripped from key/baseFont, kept in subsetPrefix', async () => {
    const doc = await openFixture(buildFontsSubsetPrefix());
    const inv = await buildInventory(doc);
    const withPrefix = inv.fonts.filter((f) => f.subsetPrefix !== null);
    expect(withPrefix.length).toBeGreaterThan(0);
    for (const f of withPrefix) {
      expect(f.key).not.toMatch(/^[A-Z]{6}\+/);
      expect(f.baseFont).not.toMatch(/^[A-Z]{6}\+/);
      expect(f.subsetPrefix).toMatch(/^[A-Z]{6}$/);
    }
  });
});

describe('buildInventory — AbortSignal', () => {
  it('aborts processing in the middle of the document (3 pages)', async () => {
    const doc = await openFixture(buildImagesDecorated());
    const controller = new AbortController();
    let pagesSeen = 0;
    await expect(
      buildInventory(doc, {
        signal: controller.signal,
        onProgress: (done) => {
          pagesSeen = done;
          if (done === 1) controller.abort();
        },
      }),
    ).rejects.toThrow(/AbortSignal/);
    expect(pagesSeen).toBeLessThan(3);
  });
});

describe('buildInventory — determinism', () => {
  it('two runs on the same file give an identical result (after serialization)', async () => {
    function serialize(inv: Awaited<ReturnType<typeof buildInventory>>) {
      return JSON.stringify(inv, (_key, value) => (value instanceof Set ? [...value].sort() : value), 2);
    }
    const buf = buildImagesOverlapping();
    const inv1 = await buildInventory(await openFixture(buf));
    const inv2 = await buildInventory(await openFixture(buf));
    expect(serialize(inv1)).toBe(serialize(inv2));
  });
});
