import { describe, expect, it } from 'vitest';
import { classifyImages, confidenceForReason } from '../../src/images/classify.js';
import type { ImageEntry } from '../../src/inventory/imageRegistry.js';
import type { Rect } from '../../src/geometry.js';

const PAGE_BOX: Rect = { minX: 0, minY: 0, maxX: 612, maxY: 792 };

function entry(overrides: Partial<ImageEntry> = {}): ImageEntry {
  return {
    objId: 'img1',
    occurrences: [{ page: 1, bbox: { minX: 100, minY: 100, maxX: 200, maxY: 200 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea: 0.02,
    isMaskLayer: false,
    maskEvidence: null,
    ...overrides,
  };
}

function pageBoxMap(pages: number[]): Map<number, Rect> {
  return new Map(pages.map((p) => [p, PAGE_BOX]));
}

describe('classifyImages', () => {
  it('maskEvidence=group -> mask, regardless of anything else', () => {
    const e = entry({ maskEvidence: 'group', maxRelativeArea: 0.9, pageRefs: [1, 2, 3] });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3]));
    expect(result!.classification).toBe('mask');
    expect(result!.reason).toBe('Z1-mask-evidence-group');
  });

  it('maskEvidence=opcode -> mask', () => {
    const e = entry({ maskEvidence: 'opcode' });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('mask');
  });

  it('present on >=5 correlated pages AND print bleed (two agreeing signals) -> decoration', () => {
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5],
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5]));
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-multi-page-correlated');
  });

  it('present on >=5 correlated pages WITHOUT print bleed (one signal) -> undecided, not decoration', () => {
    // A real case from the reference set: a region map referenced in several chapters, or a
    // faction symbol — it repeats, but is NOT a page background (it doesn't extend past the MediaBox).
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5],
      occurrences: [{ page: 1, bbox: { minX: 100, minY: 100, maxX: 200, maxY: 200 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z11-repeated-no-bleed-evidence');
  });

  it('[a divider strip repeated across many pages] present on >=5 correlated pages WITHOUT bleed, but WITH an extreme bbox aspect ratio (a second independent signal) -> decoration, not undecided', () => {
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5, 6],
      // A narrow horizontal strip (aspect ratio 400/10=40, >= the threshold 6) in the MIDDLE of the page — doesn't touch the MediaBox edge.
      occurrences: [{ page: 1, bbox: { minX: 100, minY: 400, maxX: 500, maxY: 410 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5, 6]));
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z14-repeated-extreme-aspect-ratio');
  });

  it('present on 2-4 correlated pages (below the new threshold 5) does NOT fall into this rule at all — it falls through to the ordinary classification', () => {
    const e = entry({ pageRefs: [1, 2, 3, 4], maxRelativeArea: 0.02 });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4]));
    expect(result!.reason).not.toBe('Z1-multi-page-correlated');
    expect(result!.reason).not.toBe('Z11-repeated-no-bleed-evidence');
  });

  it('a split objId (pageRefs=[1] and pageRefs=[2..6]) merged through correlatedWith counts as multi-page (>=5 after the merge)', () => {
    const first = entry({ objId: 'imgA', pageRefs: [1] }); // "first occurrence" — on its own it looks like single-page content
    const rest = entry({
      objId: 'imgB',
      correlatedWith: 'imgA',
      pageRefs: [2, 3, 4, 5, 6],
      occurrences: [
        { page: 2, bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, index: 0 },
        { page: 3, bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, index: 0 },
        { page: 4, bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, index: 0 },
        { page: 5, bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, index: 0 },
        { page: 6, bbox: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, index: 0 },
      ],
    });
    const [firstResult, restResult] = classifyImages([first, rest], pageBoxMap([1, 2, 3, 4, 5, 6]));
    expect(firstResult!.reason).toBe('Z11-repeated-no-bleed-evidence');
    expect(restResult!.reason).toBe('Z11-repeated-no-bleed-evidence');
  });

  it('a large page area (>=40%) -> content', () => {
    const e = entry({ maxRelativeArea: 0.55 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-large-relative-area');
  });

  it('a bbox extending past the MediaBox AND text IN THE MIDDLE (two agreeing signals) -> decoration, despite a large area', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]); // text covers the whole page -> high central coverage
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-full-bleed-background');
  });

  it('[at the user\'s request] the same case as above, but with options.treatFullBleedAsContent=true -> content instead of decoration', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes, { treatFullBleedAsContent: true });
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-full-bleed-forced-content');
  });

  it('[at the user\'s request] by default (options omitted) the behavior is identical to before the flag — still decoration', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes, {});
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-full-bleed-background');
  });

  it('a bbox extending past the MediaBox WITHOUT text in the middle (one signal) -> undecided, not decoration', () => {
    // A real case from the reference set: a full-page map/spread illustration legitimately
    // extends past the bleed too.
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1])); // no bodyBoxesByPage -> centerTextCoverage=0
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z12-bleeding-no-center-text-evidence');
  });

  describe('tiny undecided images and pictures hidden under a later picture', () => {
    const at = (objId: string, bbox: Rect, index: number, area: number, opacity?: number): ImageEntry =>
      entry({ objId, maxRelativeArea: area, occurrences: [{ page: 1, bbox, index, ...(opacity !== undefined ? { opacity } : {}) }] });
    const classifyAll = (entries: ImageEntry[], hideTinyImages = true) => classifyImages(entries, pageBoxMap([1]), new Map(), { hideTinyImages });
    const reasonOf = (results: ReturnType<typeof classifyAll>, e: ImageEntry) => results.find((c) => c.entry === e)!;

    it('an undecided image below 0.5% of the page is decoration when hiding is on', () => {
      const tiny = at('tiny', { minX: 10, minY: 10, maxX: 60, maxY: 25 }, 0, 0.003);
      expect(reasonOf(classifyAll([tiny]), tiny).reason).toBe('Z16-tiny-undecided');
      expect(reasonOf(classifyAll([tiny], false), tiny).classification).toBe('undecided');
    });

    it('an undecided image just above 0.5% stays', () => {
      const small = at('small', { minX: 10, minY: 10, maxX: 80, maxY: 50 }, 0, 0.006);
      expect(reasonOf(classifyAll([small]), small).classification).toBe('undecided');
    });

    it('on a page with a crowd of tiny images (a form) the small undecided ones are form elements; the same image elsewhere stays', () => {
      const tinyOnes = Array.from({ length: 15 }, (_, i) => at(`t${i}`, { minX: 10 + i * 5, minY: 10, maxX: 14 + i * 5, maxY: 14 }, i, 0.001));
      const banner = at('banner', { minX: 40, minY: 700, maxX: 260, maxY: 760 }, 20, 0.024);
      expect(reasonOf(classifyAll([...tinyOnes, banner]), banner).reason).toBe('Z18-form-page-element');
      expect(reasonOf(classifyAll([banner]), banner).classification).toBe('undecided');
      expect(reasonOf(classifyAll([...tinyOnes.slice(0, 14), banner]), banner).classification).toBe('undecided');
    });

    it('a larger image on a form page (above 6% of the page) is left alone', () => {
      const tinyOnes = Array.from({ length: 15 }, (_, i) => at(`t${i}`, { minX: 10 + i * 5, minY: 10, maxX: 14 + i * 5, maxY: 14 }, i, 0.001));
      const art = at('art', { minX: 100, minY: 200, maxX: 400, maxY: 500 }, 20, 0.18);
      expect(reasonOf(classifyAll([...tinyOnes, art]), art).classification).not.toBe('decoration');
    });

    it('the bottom of a stack (covered 75% or more by a later opaque picture) is decoration', () => {
      const bottom = at('bottom', { minX: 54, minY: 25, maxX: 558, maxY: 347 }, 3, 0.33);
      const top = at('top', { minX: 61, minY: 35, maxX: 578, maxY: 354 }, 8, 0.34);
      const results = classifyAll([bottom, top], false);
      expect(reasonOf(results, bottom).reason).toBe('Z17-covered-by-later-picture');
      expect(reasonOf(results, top).classification).toBe('content');
    });

    it('a picture only partly covered (68%) stays', () => {
      const under = at('under', { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 3, 0.3);
      const over = at('over', { minX: 32, minY: 0, maxX: 200, maxY: 100 }, 8, 0.3);
      expect(reasonOf(classifyAll([under, over], false), under).classification).not.toBe('decoration');
    });

    it('a picture covered by one painted EARLIER, or by a translucent one, stays', () => {
      const a = at('a', { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 8, 0.3);
      const earlier = at('earlier', { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 3, 0.3);
      expect(reasonOf(classifyAll([a, earlier], false), a).classification).not.toBe('decoration');
      const glass = at('glass', { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 9, 0.3, 0.3);
      expect(reasonOf(classifyAll([a, glass], false), a).classification).not.toBe('decoration');
    });
  });

  const BLEED_BBOX = { minX: -20, minY: -20, maxX: 630, maxY: 800 };

  it('a bleeding image painted translucent everywhere (a watermark) -> decoration', () => {
    const e = entry({ maxRelativeArea: 0.5, occurrences: [{ page: 1, bbox: BLEED_BBOX, index: 0, opacity: 0.1 }], maxOpacity: 0.1 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z12-bleeding-translucent-overlay');
  });

  it('a bleeding image that is opaque somewhere (no maxOpacity) stays undecided', () => {
    const e = entry({ maxRelativeArea: 0.5, occurrences: [{ page: 1, bbox: BLEED_BBOX, index: 0 }] });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z12-bleeding-no-center-text-evidence');
  });

  it('a bleeding image that is only mildly translucent (above the watermark range) stays undecided', () => {
    const e = entry({ maxRelativeArea: 0.5, occurrences: [{ page: 1, bbox: BLEED_BBOX, index: 0, opacity: 0.9 }], maxOpacity: 0.9 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.reason).toBe('Z12-bleeding-no-center-text-evidence');
  });

  it('a bleeding image that another image cuts out through a mask -> decoration (a paper scrap or stain)', () => {
    const holder = entry({ objId: 'mask1', maskEvidence: 'group', masksImageObjId: 'img1' });
    const target = entry({ maxRelativeArea: 0.5, occurrences: [{ page: 1, bbox: BLEED_BBOX, index: 1 }] });
    const result = classifyImages([holder, target], pageBoxMap([1])).find((c) => c.entry === target)!;
    expect(result.classification).toBe('decoration');
    expect(result.reason).toBe('Z12-bleeding-masked-cutout');
  });

  describe('small masked strips (adhesive tape, paper scraps)', () => {
    const maskHolder = (target: string) => entry({ objId: 'mask1', maskEvidence: 'group', masksImageObjId: target });
    const strip = (overrides: Partial<ImageEntry>) => entry({ objId: 'tape1', maxRelativeArea: 0.018, intrinsicWidth: 219, intrinsicHeight: 77, ...overrides });
    const classifyStrip = (e: ImageEntry, masked = true) => classifyImages(masked ? [maskHolder(e.objId!), e] : [e], pageBoxMap([1])).find((c) => c.entry === e)!;

    it('a masked, elongated, small raster -> decoration', () => {
      const result = classifyStrip(strip({}));
      expect(result.classification).toBe('decoration');
      expect(result.reason).toBe('Z15-small-masked-raster');
    });

    it('a square-ish masked emblem is not hit (the aspect gate)', () => {
      expect(classifyStrip(strip({ intrinsicWidth: 203, intrinsicHeight: 218, maxRelativeArea: 0.027 })).reason).toBe('Z1-no-strong-signal');
    });

    it('a masked raster longer than the size limit is not hit', () => {
      expect(classifyStrip(strip({ intrinsicWidth: 472, intrinsicHeight: 105 })).reason).toBe('Z1-no-strong-signal');
    });

    it('an unmasked strip is not hit', () => {
      expect(classifyStrip(strip({}), false).reason).toBe('Z1-no-strong-signal');
    });

    it('a strip covering 3.5% of the page is not hit', () => {
      expect(classifyStrip(strip({ maxRelativeArea: 0.035 })).reason).not.toBe('Z15-small-masked-raster');
    });

    it('an unknown intrinsic size is not hit', () => {
      expect(classifyStrip(strip({ intrinsicWidth: null, intrinsicHeight: null })).reason).toBe('Z1-no-strong-signal');
    });
  });

  it('maskEvidence=geometry (weak evidence) with no other signals -> undecided, doesn\'t decide on its own', () => {
    const e = entry({ maskEvidence: 'geometry', maxRelativeArea: 0.02 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-weak-geometry-mask-evidence');
  });

  it('maskEvidence=geometry CONTRADICTING a large area, but a SMALL absolute bbox -> undecided (conflicting signals, don\'t guess)', () => {
    // The default bbox from the `entry()` helper is 100x100pt — below LARGE_ABSOLUTE_SIZE_PT (300pt),
    // so the overriding rule Z2 should NOT kick in here.
    const e = entry({ maskEvidence: 'geometry', maxRelativeArea: 0.5 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-conflicting-geometry-mask-vs-large-area');
  });

  it('maskEvidence=geometry, but a LARGE RELATIVE area and a LARGE ABSOLUTE bbox -> content (strong signals override weak evidence)', () => {
    const e = entry({
      maskEvidence: 'geometry',
      maxRelativeArea: 0.5,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 400, maxY: 500 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-strong-content-overrides-weak-geometry-evidence');
  });

  it('no mask evidence + a moderate area (>=10%, <40%) -> content, not undecided', () => {
    const e = entry({ maskEvidence: null, maxRelativeArea: 0.15 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
  });

  it('no mask evidence, but the area BELOW the moderate threshold (<10%) -> still undecided', () => {
    const e = entry({ maskEvidence: null, maxRelativeArea: 0.05 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-no-strong-signal');
  });

  it('no strong signal at all -> undecided', () => {
    const e = entry({ maxRelativeArea: 0.01 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-no-strong-signal');
  });

  it('a narrow divider strip (aspect ratio >=6:1, a small area) -> undecided, NOT decoration (it must go through the review)', () => {
    // A real case: a tentacle motif under a heading, p. 7 of a quick-start PDF (962x84pt).
    const e = entry({
      maxRelativeArea: 0.044,
      occurrences: [{ page: 1, bbox: { minX: 60, minY: 654, maxX: 542, maxY: 697 }, index: 0 }], // 482x43pt ~= 11,2:1
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z13-extreme-aspect-ratio-undecided');
  });

  it('an extreme aspect ratio, but BELOW the threshold (5:1) -> doesn\'t fall into the divider-strip rule', () => {
    const e = entry({
      maxRelativeArea: 0.044,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 250, maxY: 50 }, index: 0 }], // 5:1
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.reason).not.toBe('Z13-extreme-aspect-ratio-undecided');
  });

  it('an extreme aspect ratio, but a LARGE relative area -> content still wins (doesn\'t override a strong signal)', () => {
    const e = entry({
      maxRelativeArea: 0.5,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 300, maxX: 612, maxY: 400 }, index: 0 }], // a wide banner, but a large % of the page
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-large-relative-area');
  });

  it('an inline entry (objId=null) counts pages by its OWN pageRefs, not by correlation', () => {
    const e = entry({ objId: null, pageRefs: [1] });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).not.toBe('decoration');
  });

  it('determinism: two calls with the same data give an identical result', () => {
    const entries = [
      entry({ objId: 'a', maskEvidence: 'group' }),
      entry({ objId: 'b', pageRefs: [1, 2] }),
      entry({ objId: 'c', maxRelativeArea: 0.5 }),
    ];
    const r1 = classifyImages(entries, pageBoxMap([1, 2]));
    const r2 = classifyImages(entries, pageBoxMap([1, 2]));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe('classifyImages — body text coverage', () => {
  it('an image entirely covered by a body block (a textured background with paragraphs) -> decoration, despite a moderate area', () => {
    // A case left undecided by pixel statistics (stddev/chroma/gradient don't tell a textured
    // background from a real illustration). The same bbox as the default from the `entry()` helper.
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const bodyBoxes = new Map([[1, [{ minX: 90, minY: 90, maxX: 210, maxY: 210 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z9-high-body-text-coverage');
  });

  it('an image with only a narrow caption on it (low coverage) -> NOT decoration through this signal', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    // A caption — a narrow strip at the bottom of the image bbox, covering <15% of its area.
    const bodyBoxes = new Map([[1, [{ minX: 100, minY: 195, maxX: 200, maxY: 200 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.reason).not.toBe('Z9-high-body-text-coverage');
    expect(result!.classification).toBe('content'); // falls back to Z2-moderate-area-no-mask-evidence
  });

  it('no body blocks on this page -> the signal is inactive (0 coverage)', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]), new Map());
    expect(result!.reason).not.toBe('Z9-high-body-text-coverage');
  });

  it('the default parameter (no third argument) keeps the behavior from before this signal', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
  });

  it('a high text coverage overrides even a large relative area (>=0.4)', () => {
    const e = entry({ maxRelativeArea: 0.9, maskEvidence: null });
    const bodyBoxes = new Map([[1, [{ minX: 90, minY: 90, maxX: 210, maxY: 210 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z9-high-body-text-coverage');
  });

  it('[a manual check, false positive] an image of a LARGE absolute size (>=300pt) is NOT demoted despite a high AGGREGATE coverage — text at the EDGE (a clean center) is a real illustration, not a background', () => {
    const e = entry({
      maxRelativeArea: 0.22,
      maskEvidence: null,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 350 }, index: 0 }], // the longer edge 350pt >= 300pt
    });
    // Two narrow strips AT THE EDGES (left/right), the center of the bbox clean — the geometry of a
    // real "text flows around a portrait" (not the earlier test, which had ONE block covering almost
    // the whole top of the image INCLUDING the center — that was in fact a case the check should
    // RIGHTLY catch, see the test below). AGGREGATE coverage is still high (30%, > the 0.15
    // threshold), but CENTRAL coverage is close to zero.
    const bodyBoxes = new Map([
      [1, [
        { minX: 0, minY: 0, maxX: 15, maxY: 350 },
        { minX: 85, minY: 0, maxX: 100, maxY: 350 },
      ]],
    ]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.reason).not.toBe('Z9-high-body-text-coverage');
    expect(result!.reason).not.toBe('Z10-high-center-text-coverage');
    expect(result!.classification).toBe('content');
  });

  it('an image of a LARGE absolute size with text IN THE MIDDLE (not at the edge) -> undecided, not content — this is a real background, which the old code (without the center check) wrongly let through', () => {
    const e = entry({
      maxRelativeArea: 0.22,
      maskEvidence: null,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 350 }, index: 0 }],
    });
    // The same bbox and the same AGGREGATE coverage (86%) as the earlier test, but this time the
    // text block actually REACHES the center of the bbox (the top 300 of 350pt, full width) —
    // exactly the "background with a paragraph IN THE MIDDLE" case from the comment at
    // `maxCenterTextCoverageRatio`.
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 100, maxY: 300 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.reason).toBe('Z10-high-center-text-coverage');
    expect(result!.classification).toBe('undecided');
  });
});

describe('classifyImages — confidence filled in and consistent with reason', () => {
  it('every classifyImages result has a confidence in [0,1] equal to confidenceForReason(reason)', () => {
    const entries = [
      entry({ maskEvidence: 'group' }),
      entry({ maxRelativeArea: 0.9, maskEvidence: null }),
      entry({ maxRelativeArea: 0.15, maskEvidence: null }),
      entry({ maxRelativeArea: 0.01, maskEvidence: null }),
    ];
    const results = classifyImages(entries, pageBoxMap([1]));
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(r.confidence).toBe(confidenceForReason(r.reason));
    }
  });

  it('hard mask evidence -> high confidence (>=0.9)', () => {
    const [result] = classifyImages([entry({ maskEvidence: 'opcode' })], pageBoxMap([1]));
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('the only content case BELOW the 0.6 threshold: Z2-moderate-area-no-mask-evidence', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
    expect(result!.classification).toBe('content');
    expect(result!.confidence).toBeLessThan(0.6);
  });

  it('undecided (no strong signal) -> always below 0.6', () => {
    const e = entry({ maxRelativeArea: 0.01, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.confidence).toBeLessThan(0.6);
  });

  it('confidenceForReason returns a default value for an unrecognized reason (safe for future rules)', () => {
    expect(confidenceForReason('some-future-rule-not-yet-mapped')).toBe(0.5);
  });
});
