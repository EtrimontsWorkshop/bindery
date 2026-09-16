import { describe, expect, it } from 'vitest';
import {
  checkFontKeyResolvesInvariant,
  checkFontRoleResolvesInvariant,
  checkCorrelatedWithInvariant,
  checkProvenanceBlockIdsInvariant,
  checkColumnIndexInvariant,
  checkNoUnrepairedGutterCrossingInvariant,
  isReferenceReportGreen,
  missRatio,
  type InvariantResult,
} from '../src/referenceInvariants.js';
import { buildFontKey, type FontRole } from '../src/inventory/fontRegistry.js';
import type { ImageEntry } from '../src/inventory/imageRegistry.js';
import type { CIFDocument } from '../src/cif/types.js';
import type { ColumnRegion } from '../src/layout/columns.js';
import type { TextLine } from '../src/layout/lineCluster.js';

function line(id: string, fontKey: string, overrides: Partial<TextLine> = {}): TextLine {
  return {
    id,
    text: id,
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    columnIndex: -1,
    crossAxisPosition: 0,
    fonts: [{ key: fontKey, size: 10 }],
    dominantFont: { key: fontKey, size: 10 },
    syntheticBold: false,
    ...overrides,
  };
}

describe('[1] checkFontKeyResolvesInvariant', () => {
  it('wszystkie klucze rozwiazuja sie w rejestrze -> 0 chybien', () => {
    const lines = [line('a', 'Body@10'), line('b', 'Heading@18')];
    const result = checkFontKeyResolvesInvariant(lines, new Set(['Body@10', 'Heading@18']));
    expect(result.violations).toBe(0);
    expect(missRatio(result)).toBe(0);
  });

  it('klucz spoza rejestru -> policzone i zaraportowane jako chybienie', () => {
    const lines = [line('a', 'Body@10'), line('b', 'Ghost@7.5')];
    const result = checkFontKeyResolvesInvariant(lines, new Set(['Body@10']));
    expect(result.violations).toBe(1);
    expect(result.examples).toContain('Ghost@7.5');
    expect(missRatio(result)).toBeCloseTo(0.5);
  });
});

describe('[1] TEST NEGATYWNY — stara formula rozmiaru fontu (transform[2]/[3]) CZERWIENI bramke (brief, obowiazkowe)', () => {
  /**
   * Odtwarza DOKLADNIE blad z kroku 9: `inventory.ts` liczyl rozmiar z
   * transform[2]/[3] (os Y), `textGeometry.ts`/linie licza z transform[0]/[1]
   * (os X). Dla tekstu ZE SKALOWANIEM POZIOMYM (Tz, transform[0] != transform[3])
   * te dwie formuly daja INNY rozmiar -> INNY klucz -> bramka MUSI to zlapac.
   */
  const baseFont = 'CondensedBody';
  // transform = [a,b,c,d,e,f]. a=7.5 (skala X po Tz condensed), d=10 (skala Y, "prawdziwy" rozmiar).
  const asymmetricTransform: [number, number, number, number, number, number] = [7.5, 0, 0, 10, 45, 700];

  function oldBuggyFontSize(transform: readonly number[]): number {
    // Stara formula z KROK-9 (usunieta w naprawie) — transform[2]/[3], os Y.
    return Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
  }
  function currentFontSize(transform: readonly number[]): number {
    // Aktualna, poprawna formula (`fontSizeFromTransform`, textGeometry.ts) — transform[0]/[1], os X.
    return Math.hypot(transform[0] ?? 0, transform[1] ?? 0);
  }

  it('bramka ZIELONA z AKTUALNA (poprawna, ujednolicona) formula', () => {
    const correctSize = currentFontSize(asymmetricTransform); // 7.5
    const correctKey = buildFontKey(baseFont, correctSize);
    const lines = [line('l0', correctKey)]; // TextLine.dominantFont.key jak faktycznie produkuje lineCluster.ts dzisiaj
    const registryKeys = new Set([buildFontKey(baseFont, currentFontSize(asymmetricTransform))]); // inventory.ts dzisiaj: ta sama formula
    const result = checkFontKeyResolvesInvariant(lines, registryKeys);
    expect(result.violations).toBe(0);
  });

  it('bramka CZERWONA gdy PRZYWROCONA stara formula (transform[2]/[3]) w rejestrze — dokladnie blad z kroku 9', () => {
    const correctSize = currentFontSize(asymmetricTransform); // 7.5 — to, co NAPRAWDE trafia do TextLine.dominantFont.key
    const correctKey = buildFontKey(baseFont, correctSize);
    const lines = [line('l0', correctKey)];

    // Rejestr zbudowany STARA (przywrocona) formula — symuluje `inventory.ts` SPRZED naprawy.
    const buggySize = oldBuggyFontSize(asymmetricTransform); // 10 — RÓZNE od 7.5
    const buggyKey = buildFontKey(baseFont, buggySize);
    const buggyRegistryKeys = new Set([buggyKey]);

    expect(buggyKey).not.toBe(correctKey); // sam fakt, ze klucze sie ROZNIA, jest sednem bledu z kroku 9
    const result = checkFontKeyResolvesInvariant(lines, buggyRegistryKeys);
    expect(result.violations).toBe(1); // BRAMKA SIE CZERWIENI
    expect(result.examples).toContain(correctKey);
  });
});

describe('[2] checkFontRoleResolvesInvariant', () => {
  it('brak roli dla klucza -> chybienie policzone', () => {
    const lines = [line('a', 'Body@10'), line('b', 'Orphan@5')];
    const roles = new Map<string, FontRole>([['Body@10', 'body']]);
    const result = checkFontRoleResolvesInvariant(lines, roles);
    expect(result.violations).toBe(1);
    expect(result.examples).toContain('Orphan@5');
  });
});

function imageEntry(objId: string | null, overrides: Partial<ImageEntry> = {}): ImageEntry {
  return {
    objId,
    occurrences: [{ page: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, index: 0 }],
    pageRefs: [1],
    maxRelativeArea: 0.1,
    isMaskLayer: false,
    maskEvidence: null,
    ...overrides,
  };
}

describe('[3] checkCorrelatedWithInvariant', () => {
  it('correlatedWith wskazujacy na istniejacy objId -> 0 chybien', () => {
    const images = [imageEntry('img1'), imageEntry('img2', { correlatedWith: 'img1' })];
    const result = checkCorrelatedWithInvariant(images);
    expect(result.violations).toBe(0);
  });

  it('correlatedWith wskazujacy na NIEISTNIEJACY objId -> chybienie policzone', () => {
    const images = [imageEntry('img1'), imageEntry('img2', { correlatedWith: 'ghost' })];
    const result = checkCorrelatedWithInvariant(images);
    expect(result.violations).toBe(1);
    expect(result.examples).toContain('ghost');
  });
});

describe('[4] checkProvenanceBlockIdsInvariant', () => {
  function cifDoc(blockIds: string[]): CIFDocument {
    return {
      schemaVersion: 1,
      source: { fileName: 'x', fileHash: 'h', pageCount: 1, detectedProfileId: null, detectedLanguage: null, extractedAt: 'now' },
      journals: [
        {
          id: 'j0',
          name: 'J',
          rawText: 'x',
          provenance: { pageNumber: 1, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, blockIds },
          pages: [
            {
              id: 'j0-p0',
              name: 'P',
              headingLevel: 1,
              html: '<p>x</p>',
              imageRefs: [],
              rawText: 'x',
              provenance: { pageNumber: 1, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, blockIds },
            },
          ],
        },
      ],
      scenes: [],
      images: [],
      diagnostics: [],
    };
  }

  it('wszystkie blockIds istnieja -> 0 chybien', () => {
    const result = checkProvenanceBlockIdsInvariant(cifDoc(['b0', 'b1']), new Set(['b0', 'b1']));
    expect(result.violations).toBe(0);
  });

  it('blockId wskazujacy na nieistniejacy blok -> policzone', () => {
    const result = checkProvenanceBlockIdsInvariant(cifDoc(['b0', 'ghost']), new Set(['b0']));
    expect(result.violations).toBeGreaterThan(0);
    expect(result.examples).toContain('ghost');
  });
});

describe('[5] checkColumnIndexInvariant', () => {
  it('columnIndex wskazujacy na istniejaca kolumne -> 0 chybien', () => {
    const lines = new Map([[1, [line('a', 'Body@10', { columnIndex: 0 }), line('b', 'Body@10', { columnIndex: 1 })]]]);
    const columns = new Map<number, ColumnRegion[]>([[1, [{ index: 0, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }, { index: 1, bbox: { minX: 2, minY: 0, maxX: 3, maxY: 1 } }]]]);
    const result = checkColumnIndexInvariant(lines, columns);
    expect(result.violations).toBe(0);
  });

  it('columnIndex bez odpowiadajacej kolumny -> policzone', () => {
    const lines = new Map([[1, [line('a', 'Body@10', { columnIndex: 3 })]]]);
    const columns = new Map<number, ColumnRegion[]>([[1, [{ index: 0, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }]]]);
    const result = checkColumnIndexInvariant(lines, columns);
    expect(result.violations).toBe(1);
  });

  it('columnIndex=-1 (rozpinajaca/marginalia) celowo pominiete — nie liczy sie jako chybienie', () => {
    const lines = new Map([[1, [line('a', 'Body@10', { columnIndex: -1 })]]]);
    const columns = new Map<number, ColumnRegion[]>([[1, []]]);
    const result = checkColumnIndexInvariant(lines, columns);
    expect(result.total).toBe(0);
    expect(result.violations).toBe(0);
  });
});

describe('[6] checkNoUnrepairedGutterCrossingInvariant', () => {
  const columns: ColumnRegion[] = [
    { index: 0, bbox: { minX: 45, minY: 0, maxX: 260, maxY: 792 } },
    { index: 1, bbox: { minX: 310, minY: 0, maxX: 540, maxY: 792 } },
  ];

  it('linia rozpinajaca ZE ZERO tokenow w rynnie, confidence wysoka -> POWINNA byc juz rozcieta; jesli nie jest, to REGRESJA (chybienie)', () => {
    const unrepaired = line('l0', 'Body@10', {
      bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 },
      tokens: [
        { text: 'left', bbox: { minX: 45, minY: 700, maxX: 200, maxY: 710 } },
        { text: 'right', bbox: { minX: 320, minY: 700, maxX: 500, maxY: 710 } },
      ],
    });
    const result = checkNoUnrepairedGutterCrossingInvariant([unrepaired], columns, 0.9);
    expect(result.violations).toBe(1);
  });

  it('prawdziwa linia rozpinajaca (token W rynnie) -> NIE liczy sie jako chybienie', () => {
    const trueSpanning = line('l0', 'Body@10', {
      bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 },
      tokens: [{ text: 'spans', bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 } }],
    });
    const result = checkNoUnrepairedGutterCrossingInvariant([trueSpanning], columns, 0.9);
    expect(result.violations).toBe(0);
  });

  it('confidence ponizej progu -> niezmiennik nie sprawdza (bezpiecznik dzialal celowo, brak regresji do zaraportowania)', () => {
    const unrepaired = line('l0', 'Body@10', {
      bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 },
      tokens: [
        { text: 'left', bbox: { minX: 45, minY: 700, maxX: 200, maxY: 710 } },
        { text: 'right', bbox: { minX: 320, minY: 700, maxX: 500, maxY: 710 } },
      ],
    });
    const result = checkNoUnrepairedGutterCrossingInvariant([unrepaired], columns, 0.5);
    expect(result.violations).toBe(0);
  });
});

describe('isReferenceReportGreen', () => {
  it('wszystkie niezmienniki ponizej progu -> raport zielony', () => {
    const results: InvariantResult[] = [
      { invariant: 'a', total: 100, violations: 0, examples: [] },
      { invariant: 'b', total: 100, violations: 1, examples: [] },
    ];
    expect(isReferenceReportGreen({ results, maxAcceptableMissRatio: 0.02 })).toBe(true);
  });

  it('jeden niezmiennik powyzej progu -> raport czerwony', () => {
    const results: InvariantResult[] = [{ invariant: 'a', total: 10, violations: 5, examples: [] }];
    expect(isReferenceReportGreen({ results, maxAcceptableMissRatio: 0.02 })).toBe(false);
  });
});
