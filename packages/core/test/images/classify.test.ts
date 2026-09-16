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
  it('maskEvidence=group -> mask, niezaleznie od czegokolwiek innego', () => {
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

  it('[KROK-15 Z3, A10] obecny na >=5 skorelowanych stronach ORAZ spad drukarski (dwa zgodne sygnaly) -> decoration (U1)', () => {
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5],
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5]));
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-multi-page-correlated');
  });

  it('[KROK-15 Z3, A10] obecny na >=5 skorelowanych stronach BEZ spadu drukarskiego (jeden sygnal) -> undecided, nie decoration', () => {
    // Prawdziwy przypadek z zestawu referencyjnego kroku 14: mapa regionu
    // odwolywana w kilku rozdzialach albo symbol frakcji — powtarza sie, ale
    // NIE jest tlem strony (nie wychodzi poza MediaBox).
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5],
      occurrences: [{ page: 1, bbox: { minX: 100, minY: 100, maxX: 200, maxY: 200 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z11-repeated-no-bleed-evidence');
  });

  it('[zgloszenie uzytkownika, "Archiwa Imperium", pasek-rozdzielacz powtorzony na wielu stronach] obecny na >=5 skorelowanych stronach BEZ spadu, ale ZE skrajnymi proporcjami bboksa (drugi niezalezny sygnal) -> decoration, nie undecided', () => {
    const e = entry({
      pageRefs: [1, 2, 3, 4, 5, 6],
      // Waski poziomy pasek (proporcje 400/10=40, >= progu 6) w SRODKU strony — nie dotyka krawedzi MediaBoksa.
      occurrences: [{ page: 1, bbox: { minX: 100, minY: 400, maxX: 500, maxY: 410 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4, 5, 6]));
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z14-repeated-extreme-aspect-ratio');
  });

  it('[KROK-15 Z3] obecny na 2-4 skorelowanych stronach (ponizej nowego progu 5) w ogole NIE wpada w te regule — spada dalej do zwyklej klasyfikacji', () => {
    const e = entry({ pageRefs: [1, 2, 3, 4], maxRelativeArea: 0.02 });
    const [result] = classifyImages([e], pageBoxMap([1, 2, 3, 4]));
    expect(result!.reason).not.toBe('Z1-multi-page-correlated');
    expect(result!.reason).not.toBe('Z11-repeated-no-bleed-evidence');
  });

  it('[U1] rozbity objId (pageRefs=[1] i pageRefs=[2..6]) scalony przez correlatedWith liczy sie jako wielostronicowy (>=5 po scaleniu)', () => {
    const first = entry({ objId: 'imgA', pageRefs: [1] }); // "pierwsze wystapienie" — samo w sobie wyglada jak tresc jednostronicowa
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

  it('duza powierzchnia strony (>=40%) -> content', () => {
    const e = entry({ maxRelativeArea: 0.55 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-large-relative-area');
  });

  it('[KROK-15 Z3, A10] bbox wychodzacy poza MediaBox ORAZ tekst NA SRODKU (dwa zgodne sygnaly) -> decoration, mimo duzej powierzchni', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]); // tekst pokrywa cala strone -> pokrycie centralne wysokie
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-full-bleed-background');
  });

  it('[na zyczenie uzytkownika] ten sam przypadek co wyzej, ale z options.treatFullBleedAsContent=true -> content zamiast decoration', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes, { treatFullBleedAsContent: true });
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-full-bleed-forced-content');
  });

  it('[na zyczenie uzytkownika] domyslnie (options pominiete) zachowanie identyczne jak przed flaga — nadal decoration', () => {
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 612, maxY: 792 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes, {});
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z1-full-bleed-background');
  });

  it('[KROK-15 Z3, A10] bbox wychodzacy poza MediaBox BEZ tekstu na srodku (jeden sygnal) -> undecided, nie decoration', () => {
    // Prawdziwy przypadek z zestawu referencyjnego kroku 14: pelnostronicowa
    // mapa/ilustracja rozkladowkowa tez legalnie wychodzi poza spad.
    const e = entry({
      maxRelativeArea: 0.95,
      occurrences: [{ page: 1, bbox: { minX: -20, minY: -20, maxX: 630, maxY: 800 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1])); // brak bodyBoxesByPage -> centerTextCoverage=0
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z12-bleeding-no-center-text-evidence');
  });

  it('maskEvidence=geometry (slaby dowod) bez innych sygnalow -> undecided, nie decyduje samodzielnie', () => {
    const e = entry({ maskEvidence: 'geometry', maxRelativeArea: 0.02 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-weak-geometry-mask-evidence');
  });

  it('maskEvidence=geometry SPRZECZNY z duza powierzchnia, ale MALY bbox bezwzgledny -> undecided (sprzeczne sygnaly, nie zgaduj)', () => {
    // Domyslny bbox z helpera `entry()` to 100x100pt — ponizej LARGE_ABSOLUTE_SIZE_PT (300pt),
    // wiec regula nadrzedna Z2 (KROK-8) NIE powinna sie tu wlaczyc.
    const e = entry({ maskEvidence: 'geometry', maxRelativeArea: 0.5 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-conflicting-geometry-mask-vs-large-area');
  });

  it('[KROK-8 Z2] maskEvidence=geometry, ale DUZA powierzchnia WZGLEDNA i DUZY bbox BEZWZGLEDNY -> content (silne sygnaly przebijaja slaby dowod)', () => {
    const e = entry({
      maskEvidence: 'geometry',
      maxRelativeArea: 0.5,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 400, maxY: 500 }, index: 0 }],
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-strong-content-overrides-weak-geometry-evidence');
  });

  it('[KROK-8 Z2] brak dowodu maskowania + umiarkowana powierzchnia (>=10%, <40%) -> content, nie undecided', () => {
    const e = entry({ maskEvidence: null, maxRelativeArea: 0.15 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
  });

  it('[KROK-8 Z2] brak dowodu maskowania, ale powierzchnia PONIZEJ progu umiarkowanego (<10%) -> nadal undecided', () => {
    const e = entry({ maskEvidence: null, maxRelativeArea: 0.05 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-no-strong-signal');
  });

  it('brak jakiegokolwiek mocnego sygnalu -> undecided', () => {
    const e = entry({ maxRelativeArea: 0.01 });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z1-no-strong-signal');
  });

  it('[KROK-17, zgloszony na zywo blad; KROK-43 Z1, naprawa "cicha utrata"] waski pasek-rozdzielacz (proporcje >=6:1, mala powierzchnia) -> undecided, NIE decoration (A5/A10: musi przejsc przez przeglad)', () => {
    // Rzeczywisty przypadek: motyw macek pod naglowkiem, CHA23131 str. 7 (962x84pt).
    const e = entry({
      maxRelativeArea: 0.044,
      occurrences: [{ page: 1, bbox: { minX: 60, minY: 654, maxX: 542, maxY: 697 }, index: 0 }], // 482x43pt ~= 11,2:1
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.reason).toBe('Z13-extreme-aspect-ratio-undecided');
  });

  it('[KROK-17] proporcje ekstremalne, ale PONIZEJ progu (5:1) -> nie wpada w regule paska-rozdzielacza', () => {
    const e = entry({
      maxRelativeArea: 0.044,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 250, maxY: 50 }, index: 0 }], // 5:1
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.reason).not.toBe('Z13-extreme-aspect-ratio-undecided');
  });

  it('[KROK-17] proporcje ekstremalne, ale DUZA powierzchnia wzgledna -> content nadal wygrywa (nie nadpisuje silnego sygnalu)', () => {
    const e = entry({
      maxRelativeArea: 0.5,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 300, maxX: 612, maxY: 400 }, index: 0 }], // szeroki banner, ale duzy % strony
    });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z1-large-relative-area');
  });

  it('wpis inline (objId=null) liczy strony po WLASNYCH pageRefs, nie po korelacji', () => {
    const e = entry({ objId: null, pageRefs: [1] });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).not.toBe('decoration');
  });

  it('determinizm: dwa wywolania z tymi samymi danymi daja identyczny wynik', () => {
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

describe('classifyImages — [KROK-9 Z2] pokrycie tekstem body', () => {
  it('obraz calkowicie pokryty blokiem body (teksturowane tlo z akapitami) -> decoration, mimo umiarkowanej powierzchni', () => {
    // img_p14_5 (Wrath & Glory) — nierozstrzygniety w kroku 8 przez statystyke
    // pikseli (stddev/chroma/gradient nie odrozniaja teksturowanego tla od
    // prawdziwej ilustracji). Ten sam bbox co domyslny z helpera `entry()`.
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const bodyBoxes = new Map([[1, [{ minX: 90, minY: 90, maxX: 210, maxY: 210 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z9-high-body-text-coverage');
  });

  it('obraz z jedynie waskim podpisem na sobie (niskie pokrycie) -> NIE decoration przez ten sygnal', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    // Podpis - waski pasek u dolu bboxa obrazu, pokrywa <15% powierzchni.
    const bodyBoxes = new Map([[1, [{ minX: 100, minY: 195, maxX: 200, maxY: 200 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.reason).not.toBe('Z9-high-body-text-coverage');
    expect(result!.classification).toBe('content'); // wraca do Z2-moderate-area-no-mask-evidence
  });

  it('brak blokow body na tej stronie -> sygnal nieaktywny (0 pokrycia)', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]), new Map());
    expect(result!.reason).not.toBe('Z9-high-body-text-coverage');
  });

  it('domyslny parametr (brak trzeciego argumentu) zachowuje zachowanie sprzed Z2', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('content');
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
  });

  it('wysokie pokrycie tekstem przebija nawet duza powierzchnie wzgledna (>=0.4)', () => {
    const e = entry({ maxRelativeArea: 0.9, maskEvidence: null });
    const bodyBoxes = new Map([[1, [{ minX: 90, minY: 90, maxX: 210, maxY: 210 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.classification).toBe('decoration');
    expect(result!.reason).toBe('Z9-high-body-text-coverage');
  });

  it('[kontrola reczna, false positive] obraz o DUZYM rozmiarze bezwzglednym (>=300pt) NIE jest degradowany mimo wysokiego pokrycia AGREGATOWEGO — tekst przy KRAWEDZI (srodek czysty) to prawdziwa ilustracja, nie tlo', () => {
    const e = entry({
      maxRelativeArea: 0.22,
      maskEvidence: null,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 350 }, index: 0 }], // dluzsza krawedz 350pt >= 300pt
    });
    // [KROK-14 H1] Dwa waskie pasy PRZY KRAWEDZIACH (lewej/prawej), srodek bboksa
    // czysty — geometria prawdziwego "tekst oplywa portret" (nie test sprzed H1,
    // ktory mial JEDEN blok pokrywajacy niemal cala gore obrazu WLACZNIE ze
    // srodkiem — to byl w rzeczywistosci przypadek, ktory H1 ma SLUSZNIE zlapac,
    // patrz test nizej). Pokrycie AGREGATOWE nadal wysokie (30%, > progu 0.15),
    // ale pokrycie CENTRALNE bliskie zeru.
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

  it('[KROK-14 H1] obraz o DUZYM rozmiarze bezwzglednym z tekstem NA SRODKU (nie przy krawedzi) -> undecided, nie content — to jest prawdziwe tlo, ktore stary kod (bez H1) mylnie przepuszczal', () => {
    const e = entry({
      maxRelativeArea: 0.22,
      maskEvidence: null,
      occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 350 }, index: 0 }],
    });
    // Ten sam bbox i to samo pokrycie AGREGATOWE (86%) co dawny test, ale tym
    // razem blok tekstu faktycznie SIEGA centrum bboksa (gorne 300 z 350pt, pelna
    // szerokosc) — dokladnie przypadek "tlo z akapitem POSRODKU" z komentarza przy
    // `maxCenterTextCoverageRatio`.
    const bodyBoxes = new Map([[1, [{ minX: 0, minY: 0, maxX: 100, maxY: 300 }]]]);
    const [result] = classifyImages([e], pageBoxMap([1]), bodyBoxes);
    expect(result!.reason).toBe('Z10-high-center-text-coverage');
    expect(result!.classification).toBe('undecided');
  });
});

describe('classifyImages — [KROK-11 Z4] confidence wypelnione i spojne z reason', () => {
  it('kazdy wynik classifyImages ma confidence w [0,1] rowne confidenceForReason(reason)', () => {
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

  it('twardy dowod maski -> wysoka pewnosc (>=0.9)', () => {
    const [result] = classifyImages([entry({ maskEvidence: 'opcode' })], pageBoxMap([1]));
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('[KROK-11 Z4] jedyny przypadek content PONIZEJ progu 0.6 z briefu: Z2-moderate-area-no-mask-evidence', () => {
    const e = entry({ maxRelativeArea: 0.15, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.reason).toBe('Z2-moderate-area-no-mask-evidence');
    expect(result!.classification).toBe('content');
    expect(result!.confidence).toBeLessThan(0.6);
  });

  it('undecided (brak silnego sygnalu) -> zawsze ponizej 0.6', () => {
    const e = entry({ maxRelativeArea: 0.01, maskEvidence: null });
    const [result] = classifyImages([e], pageBoxMap([1]));
    expect(result!.classification).toBe('undecided');
    expect(result!.confidence).toBeLessThan(0.6);
  });

  it('confidenceForReason zwraca domyslna wartosc dla nierozpoznanego reason (bezpieczne dla przyszlych regul)', () => {
    expect(confidenceForReason('some-future-rule-not-yet-mapped')).toBe(0.5);
  });
});
