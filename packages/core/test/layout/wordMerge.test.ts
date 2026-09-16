import { describe, expect, it } from 'vitest';
import { mergeWords, type MergeCandidateItem } from '../../src/layout/wordMerge.js';
import type { WordBoundary } from '../../src/text/types.js';
import type { FontGapProfile, HierarchicalGapProfile } from '../../src/text/gapStatistics.js';

const PAGE = 1;

function candidate(
  index: number,
  str: string,
  x: number,
  opts: Partial<MergeCandidateItem> = {},
): MergeCandidateItem {
  return {
    index,
    str,
    transform: opts.transform ?? [12, 0, 0, 12, x, 700],
    width: opts.width ?? str.length * 6,
    height: opts.height ?? 12,
    fontName: opts.fontName ?? 'F1',
    fontKey: opts.fontKey ?? 'Body@12',
    syntheticBold: opts.syntheticBold ?? false,
  };
}

function flatProfile(fontKey: string, intraWordThreshold = 3, interWordThreshold = 12): FontGapProfile {
  return { fontKey, intraWordThreshold, interWordThreshold, separation: 0.8, sampleCount: 200, reliable: true };
}

function unreliableFlatProfile(fontKey: string): FontGapProfile {
  return { fontKey, intraWordThreshold: 3, interWordThreshold: 12, separation: 0.1, sampleCount: 10, reliable: false };
}

/** Opakowuje profil "plaski" jako hierarchiczny bez wlasnego profilu stronicowego — przypadek domyslny (brak nadpisania per-strona). */
function hierarchical(document: FontGapProfile, byPage: Map<number, FontGapProfile> = new Map()): HierarchicalGapProfile {
  return { fontKey: document.fontKey, document, byPage };
}

function reliableProfile(fontKey: string, intraWordThreshold = 3, interWordThreshold = 12): HierarchicalGapProfile {
  return hierarchical(flatProfile(fontKey, intraWordThreshold, interWordThreshold));
}

function unreliableProfile(fontKey: string): HierarchicalGapProfile {
  return hierarchical(unreliableFlatProfile(fontKey));
}

describe('mergeWords — warunek podstawowy: scalanie ponizej progu', () => {
  it('scala dwa fragmenty tego samego fontu, gap < intraWordThreshold, brak granicy', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap = 85-(72+12) = 1
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.str).toBe('cat');
    expect(tokens[0]!.sourceIndices).toEqual([0, 1]);
  });

  it('scala LANCUCH 3+ fragmentow w jeden token', () => {
    const items = [candidate(0, 'd', 72, { width: 6 }), candidate(1, 'o', 79, { width: 6 }), candidate(2, 'g', 86, { width: 6 })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.str).toBe('dog');
    expect(tokens[0]!.sourceIndices).toEqual([0, 1, 2]);
  });
});

describe('mergeWords — warunek #1: ten sam klucz fontu', () => {
  it('NIE scala gdy klucz fontu sie rozni, nawet przy male gap', () => {
    const items = [candidate(0, 'ca', 72, { width: 12, fontKey: 'A@12' }), candidate(1, 't', 85, { width: 6, fontKey: 'B@12' })];
    const profiles = new Map([['A@12', reliableProfile('A@12')], ['B@12', reliableProfile('B@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — warunek #4 [U2, TWARDY]: granica wyrazu nigdy nie zostaje przekroczona', () => {
  it('NIE scala mimo malego gap, gdy miedzy itemami jest wordBoundary', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 84, gapEnd: 85 }];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, boundaries, profiles, PAGE);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.str)).toEqual(['ca', 't']);
  });

  it('P1: polski jednoliterowy wyraz "w" NIGDY nie sklejony z nastepnym wyrazem, gdy oddziela je granica', () => {
    // "w domu" — spacja miedzy "w" i "domu" wykryta jako wordBoundary przez higiene (Z1/U2)
    const items = [candidate(0, 'w', 72, { width: 6 }), candidate(1, 'domu', 90, { width: 24 })];
    const boundaries: WordBoundary[] = [{ afterItemIndex: 0, gapStart: 78, gapEnd: 90 }];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, boundaries, profiles, PAGE);
    expect(tokens.map((t) => t.str)).toEqual(['w', 'domu']);
  });
});

describe('mergeWords — warunek #6: profil musi byc wiarygodny (separation)', () => {
  it('NIE scala gdy profil fontu jest niepewny (jednomodalny rozklad), mimo malego gap i braku granicy', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const profiles = new Map([['Body@12', unreliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });

  it('brak profilu w ogole (font nigdy nie widziany w statystyce) -> zachowawczo, brak scalenia', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })];
    const tokens = mergeWords(items, 0, [], new Map(), PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — warunek #5: odstep musi byc scisle ponizej progu', () => {
  it('NIE scala gdy gap >= intraWordThreshold', () => {
    const items = [candidate(0, 'the', 72, { width: 18 }), candidate(1, 'cat', 95, { width: 18 })]; // gap=95-90=5 >= 3
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — [KROK-6 odkrycie] odstep UJEMNY (nakladajace sie itemy) nigdy nie scala', () => {
  it('NIE scala gdy itemy naklada sie geometrycznie (gap ujemny), mimo ze "gap < intraWordThreshold" formalnie prawdziwe', () => {
    // "next" zaczyna sie WEWNATRZ "prev" (prev: x=72..172, next zaczyna sie na x=100) -> gap=100-172=-72.
    // Bez dolnej granicy (gap>=0) kazdy ujemny gap "przechodzi" test gap<threshold (np. 3), bo -72<3 jest prawda.
    const items = [candidate(0, 'ABCDEF', 72, { width: 100 }), candidate(1, 'GHIJ', 100, { width: 50 })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 3, 12)]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.str)).toEqual(['ABCDEF', 'GHIJ']);
  });

  it('replikuje dokladnie przypadek z Cienie_posrod_mgie.pdf str. 3: dwie kolumny spisu tresci na tej samej linii bazowej, nakladajace sie', () => {
    const items = [
      candidate(0, 'AQUA NURGLIS', 255.9, { width: 97.7 }),
      candidate(1, 'ANVILGARD', 268.4, { width: 74.5 }), // zaczyna sie PRZED koncem poprzedniego (255.9+97.7=353.6)
    ];
    const profiles = new Map([['Body@12', reliableProfile('Body@12', 74.6, 100.9)]]); // prog dokumentowy realnie zmierzony dla tego fontu
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2); // musza pozostac osobne — to byl realny blad znaleziony kalibracja
  });
});

describe('mergeWords — warunek #2: ta sama linia bazowa', () => {
  it('NIE scala itemow na roznych liniach (cross-axis poza tolerancja), mimo bliskiego gap wzdluz osi', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6, transform: [12, 0, 0, 12, 85, 650] })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(2);
  });
});

describe('mergeWords — bucketowanie po linii bazowej (regresja: wykryte kalibracja na samples/)', () => {
  it('fragment INNEJ linii, ktory sortuje sie MIEDZY dwoma fragmentami tej samej linii po X, nie przeszkadza w scaleniu', () => {
    // Linia A (Y=700): "ca"@x=72 + "t"@x=85 -> powinny scalic sie w "cat" (gap=1).
    // Linia B (Y=650, zupelnie inna linia): "X"@x=80 — MIEDZY 72 i 85 w globalnym sortowaniu po X,
    // ale na INNEJ linii bazowej. Bez bucketowania po linii ten item przerywalby sasiedztwo
    // "ca"/"t" w naiwnym sortowaniu calego strumienia po samej osi along.
    const items = [
      candidate(0, 'ca', 72, { width: 12 }),
      candidate(1, 'X', 80, { transform: [12, 0, 0, 12, 80, 650], width: 8 }),
      candidate(2, 't', 85, { width: 6 }),
    ];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens.map((t) => t.str).sort()).toEqual(['X', 'cat']);
    const catToken = tokens.find((t) => t.str === 'cat')!;
    expect(catToken.sourceIndices).toEqual([0, 2]);
  });
});

describe('mergeWords — syntheticBold i kolejnosc', () => {
  it('propaguje syntheticBold z ktoregokolwiek zrodlowego itemu na scalony token', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6, syntheticBold: true })];
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens[0]!.syntheticBold).toBe(true);
  });

  it('sortuje itemy wzdluz osi czytania przed scalaniem, niezaleznie od kolejnosci wejscia', () => {
    const items = [candidate(1, 't', 85, { width: 6 }), candidate(0, 'ca', 72, { width: 12 })]; // odwrocona kolejnosc
    const profiles = new Map([['Body@12', reliableProfile('Body@12')]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens[0]!.str).toBe('cat');
  });
});

describe('mergeWords — [KROK-6 Z1a] profil hierarchiczny (dokument + strona)', () => {
  it('uzywa progu STRONICOWEGO gdy jest bardziej zachowawczy (mniejszy) niz dokumentowy', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 88, { width: 6 })]; // gap=88-84=4
    const doc = flatProfile('Body@12', 8, 20); // dokumentowy: szeroki, tolerancyjny (np. wyuczony z akapitow)
    const page = flatProfile('Body@12', 3, 12); // stronicowy: ciasny (np. gesty spis tresci)
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[PAGE, page]]))]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    // gap=4: PONIZEJ progu dokumentowego (8) ale POWYZEJ stronicowego (3) -> bardziej zachowawczy (strona) wygrywa -> BRAK scalenia
    expect(tokens).toHaveLength(2);
  });

  it('scala normalnie gdy gap ponizej OBU progow (dokumentowego i stronicowego)', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap=1
    const doc = flatProfile('Body@12', 8, 20);
    const page = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[PAGE, page]]))]]);
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1);
  });

  it('brak profilu stronicowego (np. za malo probek na tej stronie) -> uzywa WYLACZNIE profilu dokumentowego', () => {
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 85, { width: 6 })]; // gap=1
    const doc = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc)]]); // byPage puste — brak wpisu dla PAGE
    const tokens = mergeWords(items, 0, [], profiles, PAGE);
    expect(tokens).toHaveLength(1); // gap=1 < prog dokumentowy 3 -> scala normalnie
  });

  it('inna strona tego samego dokumentu moze miec INNY efektywny prog (izolacja per-strona)', () => {
    const doc = flatProfile('Body@12', 8, 20);
    const tightPageProfile = flatProfile('Body@12', 3, 12);
    const profiles = new Map([['Body@12', hierarchical(doc, new Map([[2, tightPageProfile]]))]]);
    const items = [candidate(0, 'ca', 72, { width: 12 }), candidate(1, 't', 88, { width: 6 })]; // gap=4

    const tokensPage1 = mergeWords(items, 0, [], profiles, 1); // brak profilu strony 1 -> tylko dokumentowy (8) -> gap=4<8 -> scala
    expect(tokensPage1).toHaveLength(1);

    const tokensPage2 = mergeWords(items, 0, [], profiles, 2); // profil strony 2 (3) bardziej zachowawczy -> gap=4>=3 -> NIE scala
    expect(tokensPage2).toHaveLength(2);
  });
});
