import { describe, expect, it } from 'vitest';
import {
  buildFontGapProfiles,
  buildHierarchicalGapProfiles,
  collectGapSamples,
  computeReliableGlyphCoverage,
  effectiveGapProfileForPage,
  type GapAwareItem,
  type GapSample,
} from '../../src/text/gapStatistics.js';

/** A deterministic generator (LCG) — repeatable "random" samples without a dependency on Math.random. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function bimodalSamples(fontKey: string, n: number, seed: number, page = 1): GapSample[] {
  const rand = lcg(seed);
  const samples: GapSample[] = [];
  for (let i = 0; i < n; i++) {
    // half of the samples around 2pt (intra-word kerning), half around 15pt (an inter-word space)
    const gap = i % 2 === 0 ? 1.5 + rand() * 1 : 14 + rand() * 2;
    samples.push({ fontKey, gap, page });
  }
  return samples;
}

function unimodalSamples(fontKey: string, n: number, seed: number, page = 1): GapSample[] {
  const rand = lcg(seed);
  const samples: GapSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({ fontKey, gap: 5 + rand() * 1, page }); // all in one narrow band
  }
  return samples;
}

/** A tight distribution (a "table of contents" candidate) — modes close together, a low intra-word threshold. */
function tightBimodalSamples(fontKey: string, n: number, seed: number, page: number): GapSample[] {
  const rand = lcg(seed);
  const samples: GapSample[] = [];
  for (let i = 0; i < n; i++) {
    const gap = i % 2 === 0 ? 0.5 + rand() * 0.3 : 3 + rand() * 0.5;
    samples.push({ fontKey, gap, page });
  }
  return samples;
}

describe('buildFontGapProfiles — a bimodal distribution', () => {
  it('detects a valley between the modes with a high separation and sensible thresholds', () => {
    const samples = bimodalSamples('Body@12', 400, 1);
    const profiles = buildFontGapProfiles(samples, new Map([['Body@12', 12]]));
    const p = profiles.get('Body@12')!;
    expect(p.reliable).toBe(true);
    expect(p.separation).toBeGreaterThan(0.3);
    expect(p.intraWordThreshold).toBeGreaterThan(1.5);
    expect(p.intraWordThreshold).toBeLessThan(10);
    expect(p.interWordThreshold).toBeGreaterThan(p.intraWordThreshold);
    expect(p.interWordThreshold).toBeLessThan(20);
    expect(p.sampleCount).toBe(400);
  });
});

describe('buildFontGapProfiles — a unimodal distribution (a safeguard)', () => {
  it('a low separation -> the profile marked uncertain, uses the font-size fallback', () => {
    const samples = unimodalSamples('Mono@10', 400, 2);
    const profiles = buildFontGapProfiles(samples, new Map([['Mono@10', 10]]));
    const p = profiles.get('Mono@10')!;
    expect(p.reliable).toBe(false);
    expect(p.intraWordThreshold).toBeCloseTo(10 * 0.25);
    expect(p.interWordThreshold).toBeCloseTo(10 * 0.6);
  });
});

describe('buildFontGapProfiles — too few samples (a safeguard)', () => {
  it('below the sample-count threshold -> the fallback immediately, regardless of the distribution shape', () => {
    const samples: GapSample[] = [
      { fontKey: 'Rare@14', gap: 2, page: 1 },
      { fontKey: 'Rare@14', gap: 15, page: 1 },
      { fontKey: 'Rare@14', gap: 2.1, page: 1 },
    ];
    const profiles = buildFontGapProfiles(samples, new Map([['Rare@14', 14]]));
    const p = profiles.get('Rare@14')!;
    expect(p.reliable).toBe(false);
    expect(p.sampleCount).toBe(3);
    expect(p.intraWordThreshold).toBeCloseTo(14 * 0.25);
  });

  it('a font with no samples (never occurred in gaps) still gets a fallback from InventoryResult.fonts', () => {
    const profiles = buildFontGapProfiles([], new Map([['Ghost@8', 8]]));
    const p = profiles.get('Ghost@8')!;
    expect(p.sampleCount).toBe(0);
    expect(p.reliable).toBe(false);
    expect(p.intraWordThreshold).toBeCloseTo(8 * 0.25);
  });
});

describe('buildFontGapProfiles — no extrapolation between fonts', () => {
  it('two fonts with different distributions get INDEPENDENT profiles', () => {
    const samples = [...bimodalSamples('A@12', 400, 3), ...unimodalSamples('B@20', 400, 4)];
    const profiles = buildFontGapProfiles(samples, new Map([['A@12', 12], ['B@20', 20]]));
    expect(profiles.get('A@12')!.reliable).toBe(true);
    expect(profiles.get('B@20')!.reliable).toBe(false);
    expect(profiles.get('A@12')!.intraWordThreshold).not.toBeCloseTo(profiles.get('B@20')!.intraWordThreshold, 0);
  });
});

describe('collectGapSamples — geometry', () => {
  function item(fontKey: string, x: number, width: number, transform?: number[]): GapAwareItem {
    return { fontKey, width, transform: transform ?? [12, 0, 0, 12, x, 700] };
  }

  it('computes the gap as (the start of the next) - (the end of the previous), assigned to the previous item\'s font and page', () => {
    const items = [item('F@12', 72, 18), item('F@12', 92, 18)]; // end of the first=90, start of the second=92 -> gap=2
    const samples = collectGapSamples(items, 7);
    expect(samples).toEqual([{ fontKey: 'F@12', gap: 2, page: 7 }]);
  });

  it('items on different baselines (different Y) don\'t generate a gap between each other', () => {
    const items = [item('F@12', 72, 18), item('F@12', 72, 18, [12, 0, 0, 12, 72, 650])];
    const samples = collectGapSamples(items, 1);
    expect(samples).toHaveLength(0);
  });

  it('sorts by position along the reading direction before computing gaps (the input order is irrelevant)', () => {
    const items = [item('F@12', 200, 18), item('F@12', 72, 18)]; // given in reverse X order
    const samples = collectGapSamples(items, 1);
    expect(samples[0]!.gap).toBeCloseTo(110); // 200-(72+18)=110
  });
});

describe('buildHierarchicalGapProfiles — a hierarchical profile', () => {
  it('a page with enough samples gets its OWN profile in byPage', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const tocPageSamples = tightBimodalSamples('Body@12', 400, 5, 3); // page 3 = "table of contents"
    const samples = [...docSamples, ...tocPageSamples];
    const hier = buildHierarchicalGapProfiles(samples, new Map([['Body@12', 12]]));
    const h = hier.get('Body@12')!;
    expect(h.document.reliable).toBe(true);
    expect(h.byPage.has(3)).toBe(true);
    expect(h.byPage.get(3)!.reliable).toBe(true);
    // The profile of page 3 (a tight distribution) must have a LOWER threshold than the document one (averaged over a much wider distribution).
    expect(h.byPage.get(3)!.intraWordThreshold).toBeLessThan(h.document.intraWordThreshold);
  });

  it('a page below the sample-count threshold does NOT get its own entry in byPage (we don\'t guess from a handful of samples)', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const fewSamplesOnPage2: GapSample[] = [
      { fontKey: 'Body@12', gap: 2, page: 2 },
      { fontKey: 'Body@12', gap: 15, page: 2 },
    ];
    const hier = buildHierarchicalGapProfiles([...docSamples, ...fewSamplesOnPage2], new Map([['Body@12', 12]]));
    const h = hier.get('Body@12')!;
    expect(h.byPage.has(2)).toBe(false);
  });

  it('a page with many samples but a unimodal distribution STILL gets an entry (the font-size fallback) — exactly the case that "defended" the table of contents in practice', () => {
    // A real case: a table-of-contents page has many samples, but ALL the gaps are already
    // between entries (each entry is one Tj with no internal fragmentation) — the distribution is
    // unimodal, findValley finds no valley. Rejecting such a profile (as the first version did)
    // would leave this page with the DOCUMENT threshold, which is too tolerant — exactly the same
    // bug as before. The fallback (0.25x size) is a legitimate, conservative estimate "from this
    // page" (we have >= MIN_PAGE_SAMPLE_COUNT samples), not a guess from a handful.
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const unimodalPageSamples = unimodalSamples('Body@12', 400, 9, 4);
    const hier = buildHierarchicalGapProfiles([...docSamples, ...unimodalPageSamples], new Map([['Body@12', 12]]));
    const pageProfile = hier.get('Body@12')!.byPage.get(4);
    expect(pageProfile).toBeDefined();
    expect(pageProfile!.reliable).toBe(false); // no own valley — but still used (see effectiveGapProfileForPage)
    expect(pageProfile!.intraWordThreshold).toBeCloseTo(12 * 0.25);
  });

  it('a page below the PAGE threshold (fewer than MIN_PAGE_SAMPLE_COUNT), but above a handful, still rejected', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const tenSamplesOnPage5: GapSample[] = Array.from({ length: 10 }, (_, i) => ({ fontKey: 'Body@12', gap: 2 + i * 0.1, page: 5 }));
    const hier = buildHierarchicalGapProfiles([...docSamples, ...tenSamplesOnPage5], new Map([['Body@12', 12]]));
    expect(hier.get('Body@12')!.byPage.has(5)).toBe(false);
  });
});

describe('effectiveGapProfileForPage — the more conservative of two thresholds', () => {
  it('no page profile -> returns the document profile unchanged', () => {
    const hier = { fontKey: 'F@12', document: { fontKey: 'F@12', intraWordThreshold: 8, interWordThreshold: 20, separation: 0.9, sampleCount: 400, reliable: true }, byPage: new Map() };
    const effective = effectiveGapProfileForPage(hier, 1);
    expect(effective).toBe(hier.document);
  });

  it('the page profile more conservative (a smaller threshold) -> the effective threshold = min(document, page)', () => {
    const document = { fontKey: 'F@12', intraWordThreshold: 8, interWordThreshold: 20, separation: 0.9, sampleCount: 400, reliable: true };
    const page = { fontKey: 'F@12', intraWordThreshold: 3, interWordThreshold: 12, separation: 0.8, sampleCount: 60, reliable: true };
    const hier = { fontKey: 'F@12', document, byPage: new Map([[3, page]]) };
    const effective = effectiveGapProfileForPage(hier, 3);
    expect(effective.intraWordThreshold).toBe(3);
    expect(effective.interWordThreshold).toBe(12);
    expect(effective.reliable).toBe(true);
  });

  it('the document profile unreliable, but the page reliable -> use the page profile', () => {
    const document = { fontKey: 'F@12', intraWordThreshold: 3, interWordThreshold: 7.2, separation: 0, sampleCount: 400, reliable: false };
    const page = { fontKey: 'F@12', intraWordThreshold: 2, interWordThreshold: 9, separation: 0.7, sampleCount: 80, reliable: true };
    const hier = { fontKey: 'F@12', document, byPage: new Map([[5, page]]) };
    const effective = effectiveGapProfileForPage(hier, 5);
    expect(effective).toBe(page);
  });
});

describe('computeReliableGlyphCoverage — a glyph-weighted metric', () => {
  it('counts the share of glyphs belonging to fonts with a reliable profile, not the share of font keys', () => {
    const fonts = [
      { key: 'Body@10', glyphCount: 900 }, // text dominates, a reliable profile
      { key: 'Heading@24', glyphCount: 50 }, // a rare heading, unreliable (too few samples)
      { key: 'Footnote@6', glyphCount: 50 }, // a rare footnote, unreliable
    ];
    const profiles = new Map([
      ['Body@10', { fontKey: 'Body@10', document: { fontKey: 'Body@10', intraWordThreshold: 2, interWordThreshold: 10, separation: 0.8, sampleCount: 300, reliable: true }, byPage: new Map() }],
      ['Heading@24', { fontKey: 'Heading@24', document: { fontKey: 'Heading@24', intraWordThreshold: 6, interWordThreshold: 14.4, separation: 0, sampleCount: 5, reliable: false }, byPage: new Map() }],
      // Footnote@6 has no entry in profiles at all (never observed in gaps) — also counts as unreliable.
    ]);
    const coverage = computeReliableGlyphCoverage(fonts, profiles);
    // 3 font keys: 1/3 has a reliable profile (33%) -- BUT weighted by glyphs: 900/1000 = 90%.
    expect(coverage).toBeCloseTo(0.9);
  });

  it('0 glyphs in total -> 0, not NaN', () => {
    expect(computeReliableGlyphCoverage([], new Map())).toBe(0);
  });

  it('all fonts unreliable -> coverage 0', () => {
    const fonts = [{ key: 'A@10', glyphCount: 100 }];
    const profiles = new Map([['A@10', { fontKey: 'A@10', document: { fontKey: 'A@10', intraWordThreshold: 2.5, interWordThreshold: 6, separation: 0, sampleCount: 10, reliable: false }, byPage: new Map() }]]);
    expect(computeReliableGlyphCoverage(fonts, profiles)).toBe(0);
  });
});
