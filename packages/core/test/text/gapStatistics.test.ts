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

/** Generator deterministyczny (LCG) — powtarzalne "losowe" probki bez zaleznosci od Math.random. */
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
    // pol probek wokol 2pt (kerning wewnatrzwyrazowy), pol wokol 15pt (spacja miedzywyrazowa)
    const gap = i % 2 === 0 ? 1.5 + rand() * 1 : 14 + rand() * 2;
    samples.push({ fontKey, gap, page });
  }
  return samples;
}

function unimodalSamples(fontKey: string, n: number, seed: number, page = 1): GapSample[] {
  const rand = lcg(seed);
  const samples: GapSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({ fontKey, gap: 5 + rand() * 1, page }); // wszystkie w waskim, jednym paśmie
  }
  return samples;
}

/** Rozklad ciasny (kandydat na "spis tresci") — mody blisko siebie, niski prog wewnatrzwyrazowy. */
function tightBimodalSamples(fontKey: string, n: number, seed: number, page: number): GapSample[] {
  const rand = lcg(seed);
  const samples: GapSample[] = [];
  for (let i = 0; i < n; i++) {
    const gap = i % 2 === 0 ? 0.5 + rand() * 0.3 : 3 + rand() * 0.5;
    samples.push({ fontKey, gap, page });
  }
  return samples;
}

describe('buildFontGapProfiles — rozklad dwumodalny', () => {
  it('wykrywa dolina miedzy modami z wysoka separation i sensownymi progami', () => {
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

describe('buildFontGapProfiles — rozklad jednomodalny (zabezpieczenie)', () => {
  it('separation niska -> profil oznaczony niepewny, uzywa fallbacku z rozmiaru fontu', () => {
    const samples = unimodalSamples('Mono@10', 400, 2);
    const profiles = buildFontGapProfiles(samples, new Map([['Mono@10', 10]]));
    const p = profiles.get('Mono@10')!;
    expect(p.reliable).toBe(false);
    expect(p.intraWordThreshold).toBeCloseTo(10 * 0.25);
    expect(p.interWordThreshold).toBeCloseTo(10 * 0.6);
  });
});

describe('buildFontGapProfiles — za malo probek (zabezpieczenie)', () => {
  it('ponizej progu liczby probek -> fallback natychmiast, niezaleznie od ksztaltu rozkladu', () => {
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

  it('font bez zadnych probek (nigdy nie wystapil w gapach) nadal dostaje fallback z InventoryResult.fonts', () => {
    const profiles = buildFontGapProfiles([], new Map([['Ghost@8', 8]]));
    const p = profiles.get('Ghost@8')!;
    expect(p.sampleCount).toBe(0);
    expect(p.reliable).toBe(false);
    expect(p.intraWordThreshold).toBeCloseTo(8 * 0.25);
  });
});

describe('buildFontGapProfiles — brak ekstrapolacji miedzy fontami', () => {
  it('dwa fonty z roznymi rozkladami dostaja NIEZALEZNE profile', () => {
    const samples = [...bimodalSamples('A@12', 400, 3), ...unimodalSamples('B@20', 400, 4)];
    const profiles = buildFontGapProfiles(samples, new Map([['A@12', 12], ['B@20', 20]]));
    expect(profiles.get('A@12')!.reliable).toBe(true);
    expect(profiles.get('B@20')!.reliable).toBe(false);
    expect(profiles.get('A@12')!.intraWordThreshold).not.toBeCloseTo(profiles.get('B@20')!.intraWordThreshold, 0);
  });
});

describe('collectGapSamples — geometria', () => {
  function item(fontKey: string, x: number, width: number, transform?: number[]): GapAwareItem {
    return { fontKey, width, transform: transform ?? [12, 0, 0, 12, x, 700] };
  }

  it('liczy odstep jako (start kolejnego) - (koniec poprzedniego), przypisany do fontu poprzednika i strony', () => {
    const items = [item('F@12', 72, 18), item('F@12', 92, 18)]; // koniec pierwszego=90, start drugiego=92 -> gap=2
    const samples = collectGapSamples(items, 7);
    expect(samples).toEqual([{ fontKey: 'F@12', gap: 2, page: 7 }]);
  });

  it('itemy na roznych liniach bazowych (rozne Y) nie generuja gapu miedzy soba', () => {
    const items = [item('F@12', 72, 18), item('F@12', 72, 18, [12, 0, 0, 12, 72, 650])];
    const samples = collectGapSamples(items, 1);
    expect(samples).toHaveLength(0);
  });

  it('sortuje po pozycji wzdluz kierunku czytania przed liczeniem gapow (kolejnosc wejscia nieistotna)', () => {
    const items = [item('F@12', 200, 18), item('F@12', 72, 18)]; // podane w odwrotnej kolejnosci X
    const samples = collectGapSamples(items, 1);
    expect(samples[0]!.gap).toBeCloseTo(110); // 200-(72+18)=110
  });
});

describe('buildHierarchicalGapProfiles — [KROK-6 Z1a] profil hierarchiczny', () => {
  it('strona z wystarczajaca liczba probek dostaje WLASNY profil w byPage', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const tocPageSamples = tightBimodalSamples('Body@12', 400, 5, 3); // strona 3 = "spis tresci"
    const samples = [...docSamples, ...tocPageSamples];
    const hier = buildHierarchicalGapProfiles(samples, new Map([['Body@12', 12]]));
    const h = hier.get('Body@12')!;
    expect(h.document.reliable).toBe(true);
    expect(h.byPage.has(3)).toBe(true);
    expect(h.byPage.get(3)!.reliable).toBe(true);
    // Profil strony 3 (ciasny rozklad) musi miec NIZSZY prog niz dokumentowy (usredniony po duzo szerszym rozkladzie).
    expect(h.byPage.get(3)!.intraWordThreshold).toBeLessThan(h.document.intraWordThreshold);
  });

  it('strona ponizej progu liczby probek NIE dostaje wlasnego wpisu w byPage (brief: "nie zgaduj z kilku probek")', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const fewSamplesOnPage2: GapSample[] = [
      { fontKey: 'Body@12', gap: 2, page: 2 },
      { fontKey: 'Body@12', gap: 15, page: 2 },
    ];
    const hier = buildHierarchicalGapProfiles([...docSamples, ...fewSamplesOnPage2], new Map([['Body@12', 12]]));
    const h = hier.get('Body@12')!;
    expect(h.byPage.has(2)).toBe(false);
  });

  it('strona z duzo probek ale jednomodalnym rozkladem NADAL dostaje wpis (fallback z rozmiaru fontu) — to wlasnie ten przypadek "obronil" spis tresci w praktyce', () => {
    // Realny przypadek (RAPORT-KROK-6.md): strona spisu tresci ma duzo probek, ale
    // WSZYSTKIE odstepy sa juz miedzy-pozycyjne (kazda pozycja to jeden Tj bez
    // wewnetrznej fragmentacji) — rozklad jest jednomodalny, findValley nie
    // znajduje doliny. Odrzucenie takiego profilu (jak w pierwszej wersji Z1a)
    // zostawialoby te strone z progiem DOKUMENTOWYM, ktory jest zbyt tolerancyjny —
    // dokladnie ten sam blad co w kroku 5. Fallback (0.25x rozmiar) to legalny,
    // konserwatywny szacunek "z tej strony" (mamy >= MIN_PAGE_SAMPLE_COUNT probek),
    // nie zgadywanie z garstki.
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const unimodalPageSamples = unimodalSamples('Body@12', 400, 9, 4);
    const hier = buildHierarchicalGapProfiles([...docSamples, ...unimodalPageSamples], new Map([['Body@12', 12]]));
    const pageProfile = hier.get('Body@12')!.byPage.get(4);
    expect(pageProfile).toBeDefined();
    expect(pageProfile!.reliable).toBe(false); // brak wlasnej doliny — ale nadal uzyty (patrz effectiveGapProfileForPage)
    expect(pageProfile!.intraWordThreshold).toBeCloseTo(12 * 0.25);
  });

  it('strona ponizej progu STRONICOWEGO (mniej niz MIN_PAGE_SAMPLE_COUNT), ale powyzej garstki, nadal odrzucona', () => {
    const docSamples = bimodalSamples('Body@12', 400, 1, 1);
    const tenSamplesOnPage5: GapSample[] = Array.from({ length: 10 }, (_, i) => ({ fontKey: 'Body@12', gap: 2 + i * 0.1, page: 5 }));
    const hier = buildHierarchicalGapProfiles([...docSamples, ...tenSamplesOnPage5], new Map([['Body@12', 12]]));
    expect(hier.get('Body@12')!.byPage.has(5)).toBe(false);
  });
});

describe('effectiveGapProfileForPage — [KROK-6 Z1a] bardziej zachowawczy z dwoch progow', () => {
  it('brak profilu strony -> zwraca profil dokumentowy bez zmian', () => {
    const hier = { fontKey: 'F@12', document: { fontKey: 'F@12', intraWordThreshold: 8, interWordThreshold: 20, separation: 0.9, sampleCount: 400, reliable: true }, byPage: new Map() };
    const effective = effectiveGapProfileForPage(hier, 1);
    expect(effective).toBe(hier.document);
  });

  it('profil strony bardziej zachowawczy (mniejszy prog) -> efektywny prog = min(dokument, strona)', () => {
    const document = { fontKey: 'F@12', intraWordThreshold: 8, interWordThreshold: 20, separation: 0.9, sampleCount: 400, reliable: true };
    const page = { fontKey: 'F@12', intraWordThreshold: 3, interWordThreshold: 12, separation: 0.8, sampleCount: 60, reliable: true };
    const hier = { fontKey: 'F@12', document, byPage: new Map([[3, page]]) };
    const effective = effectiveGapProfileForPage(hier, 3);
    expect(effective.intraWordThreshold).toBe(3);
    expect(effective.interWordThreshold).toBe(12);
    expect(effective.reliable).toBe(true);
  });

  it('profil dokumentu niewiarygodny, ale strona wiarygodna -> uzyj profilu strony', () => {
    const document = { fontKey: 'F@12', intraWordThreshold: 3, interWordThreshold: 7.2, separation: 0, sampleCount: 400, reliable: false };
    const page = { fontKey: 'F@12', intraWordThreshold: 2, interWordThreshold: 9, separation: 0.7, sampleCount: 80, reliable: true };
    const hier = { fontKey: 'F@12', document, byPage: new Map([[5, page]]) };
    const effective = effectiveGapProfileForPage(hier, 5);
    expect(effective).toBe(page);
  });
});

describe('computeReliableGlyphCoverage — [KROK-6 Z1b] metryka wazona glifami', () => {
  it('liczy udzial glifow nalezacych do fontow z wiarygodnym profilem, nie udzial kluczy fontow', () => {
    const fonts = [
      { key: 'Body@10', glyphCount: 900 }, // dominuje tekst, wiarygodny profil
      { key: 'Heading@24', glyphCount: 50 }, // rzadki naglowek, niewiarygodny (za malo probek)
      { key: 'Footnote@6', glyphCount: 50 }, // rzadki przypis, niewiarygodny
    ];
    const profiles = new Map([
      ['Body@10', { fontKey: 'Body@10', document: { fontKey: 'Body@10', intraWordThreshold: 2, interWordThreshold: 10, separation: 0.8, sampleCount: 300, reliable: true }, byPage: new Map() }],
      ['Heading@24', { fontKey: 'Heading@24', document: { fontKey: 'Heading@24', intraWordThreshold: 6, interWordThreshold: 14.4, separation: 0, sampleCount: 5, reliable: false }, byPage: new Map() }],
      // Footnote@6 nie ma wpisu w profiles w ogole (nigdy nie zaobserwowany w gapach) — tez liczy sie jako niewiarygodny.
    ]);
    const coverage = computeReliableGlyphCoverage(fonts, profiles);
    // 3 klucze fontow: 1/3 ma wiarygodny profil (33%) -- ALE wazone glifami: 900/1000 = 90%.
    expect(coverage).toBeCloseTo(0.9);
  });

  it('0 glifow calkowitych -> 0, nie NaN', () => {
    expect(computeReliableGlyphCoverage([], new Map())).toBe(0);
  });

  it('wszystkie fonty niewiarygodne -> coverage 0', () => {
    const fonts = [{ key: 'A@10', glyphCount: 100 }];
    const profiles = new Map([['A@10', { fontKey: 'A@10', document: { fontKey: 'A@10', intraWordThreshold: 2.5, interWordThreshold: 6, separation: 0, sampleCount: 10, reliable: false }, byPage: new Map() }]]);
    expect(computeReliableGlyphCoverage(fonts, profiles)).toBe(0);
  });
});
