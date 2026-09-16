import { describe, expect, it } from 'vitest';
import { buildActorsForDocument, type PdfDocumentLike, type PdfPageLike } from '../../src/profiles/buildActorsForDocument.js';
import { validateProfile } from '../../src/profiles/schema.js';
import { DEFAULT_PLAYER_CHARACTER_KEYWORDS } from '../../src/profiles/pageRoute.js';
import type { FontRole } from '../../src/inventory/fontRegistry.js';

/** Profil minimalny — ten sam ksztalt co `assembleStatblocks.test.ts`. */
function coc7Profile() {
  const result = validateProfile({
    schemaVersion: 2,
    id: 'coc7-niczas-pl',
    gameLine: 'coc7',
    language: 'pl',
    title: 'x',
    publication: 'x',
    provides: ['actors'],
    fingerprint: { minScore: 0.5 },
    pages: { include: [[1, -1]] },
    patterns: {
      characteristicGrid: {
        kind: 'labelledPairs',
        labels: { S: 'strength', WYG: 'charisma', KON: 'constitution' },
        valuePattern: '^(\\d{1,3}|[–—-])$',
        minPairs: 3,
        terminate: { onRepeatedLabel: true },
      },
      entityName: { kind: 'fontRoleCandidate', excludeRoles: ['body'] },
    },
    entityAssembly: {
      anchor: 'characteristicGrid',
      attach: [{ pattern: 'entityName', strategy: 'nearestAbove', maxDistancePt: 120 }],
      nameConfidenceThreshold: 0.7,
      namePlaceholder: 'NPC ze str. {page} (#{ordinal})',
    },
  });
  if (!result.ok) throw new Error(`profil testowy niepoprawny: ${result.issues.join('; ')}`);
  return result.profile;
}

interface FakeItem {
  str: string;
  transform: number[];
  width: number;
  fontName?: string;
}

function makeItem(text: string, x: number, y: number, fontName?: string): FakeItem {
  return { str: text, transform: [1, 0, 0, 1, x, y], width: text.length * 8, fontName };
}

function makePage(items: FakeItem[]): PdfPageLike {
  let cleaned = false;
  return {
    getOperatorList: async () => ({}),
    getTextContent: async () => ({ items }),
    commonObjs: { has: () => false, get: () => undefined },
    cleanup: () => {
      cleaned = true;
    },
    get __cleaned() {
      return cleaned;
    },
  } as PdfPageLike & { __cleaned: boolean };
}

function makeDoc(pages: readonly PdfPageLike[]): PdfDocumentLike {
  return {
    numPages: pages.length,
    getPage: async (n: number) => pages[n - 1]!,
  };
}

const fontRoles = new Map<string, FontRole>([['heading-font', 'heading']]);

describe('buildActorsForDocument — [KROK-20 Z2]', () => {
  it('zbiera aktorow ze WSZYSTKICH stron dokumentu, po jednym wpisie na trafiony statblok', async () => {
    const page1 = makePage([
      makeItem('Jakas Postac', 100, 300, 'heading-font'),
      ...['S', '40', 'WYG', '25', 'KON', '35'].map((t, i) => makeItem(t, 100 + i * 15, 280)),
    ]);
    const page2 = makePage([makeItem('Sama proza, brak statbloku.', 100, 300)]);
    const doc = makeDoc([page1, page2]);

    const { actors } = await buildActorsForDocument(doc, { profile: coc7Profile(), fontRoles });
    // Trafnosc samego dopasowania nazwy jest juz pokryta osobno (entityAssembly.test.ts)
    // — tu liczy sie WYLACZNIE to, ze orkiestracja przechodzi WSZYSTKIE strony i zbiera po jednym wpisie na trafiony statblok.
    expect(actors).toHaveLength(1);
    expect(actors[0]!.provenance.pageNumber).toBe(1);
    expect(actors[0]!.statistics['strength']?.raw).toBe('40');
    // [KROK-39 Z1] Trasa `npc` — brak wzorcow `playerCharacter` w tym profilu testowym.
    expect(actors[0]!.route).toBe('npc');
  });

  it('[KROK-39 Z1] pomija strony gotowych Badaczy (trasa playerCharacter), gdy profil NIE MA dla niej wzorcow — z jawnym Diagnostic, nie po cichu', async () => {
    const pcKeywordItems = DEFAULT_PLAYER_CHARACTER_KEYWORDS.slice(0, 3).map((kw, i) => makeItem(kw, 100 + i * 60, 500));
    const pcPage = makePage([...pcKeywordItems, ...['S', '40', 'WYG', '25', 'KON', '35'].map((t, i) => makeItem(t, 100 + i * 15, 280))]);
    const doc = makeDoc([pcPage]);

    const { actors, diagnostics } = await buildActorsForDocument(doc, { profile: coc7Profile(), fontRoles });
    expect(actors).toHaveLength(0);
    expect(diagnostics).toEqual([{ severity: 'info', code: 'PLAYER_CHARACTER_ROUTE_UNSUPPORTED', pageNumber: 1 }]);
  });

  it('sprzata kazda strone (`page.cleanup()`) po przetworzeniu — nie zostawia otwartych obiektow pdf.js', async () => {
    const page = makePage([makeItem('cokolwiek', 0, 0)]) as PdfPageLike & { __cleaned: boolean };
    const doc = makeDoc([page]);
    await buildActorsForDocument(doc, { profile: coc7Profile(), fontRoles });
    expect(page.__cleaned).toBe(true);
  });

  it('przerywa z AbortError, gdy sygnal jest juz przerwany przed startem', async () => {
    const doc = makeDoc([makePage([])]);
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await buildActorsForDocument(doc, { profile: coc7Profile(), fontRoles, signal: controller.signal });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('dokument bez zadnego statbloku -> pusta tablica, nie wyjatek', async () => {
    const doc = makeDoc([makePage([makeItem('Sama proza.', 0, 0)])]);
    const { actors } = await buildActorsForDocument(doc, { profile: coc7Profile(), fontRoles });
    expect(actors).toEqual([]);
  });
});
