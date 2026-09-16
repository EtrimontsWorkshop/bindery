import type { ColumnRegion } from './layout/columns.js';
import type { TextLine } from './layout/lineCluster.js';
import type { FontRole } from './inventory/fontRegistry.js';
import type { ImageEntry } from './inventory/imageRegistry.js';
import type { CIFDocument } from './cif/types.js';

/**
 * Bramka niezmienników REFERENCYJNYCH (KROK-10, zadanie drugie) — dopelnienie
 * istniejacej bramki GEOMETRYCZNEJ (§11.3, `mediaBoxInvariant.test.ts`).
 * Rozjazd formuly rozmiaru fontu z kroku 9 (`inventory.ts` liczyl z
 * transform[2]/[3], `textGeometry.ts` z transform[0]/[1]) to CZWARTY
 * przypadek tej samej klasy bledow (KROK 4: ksztalt argumentow `cm`; KROK 5:
 * ksztalt argumentow `constructPath`; KROK 6: `item.width` juz w przestrzeni
 * urzadzenia) — wszystkie ciche, zaden nie rzucil wyjatku, wszystkie wykryte
 * przypadkiem. Zasada: `undefined` jako cichy tryb awarii jest wrogiem —
 * kazdy klucz przekazywany miedzy etapami potoku MUSI sie rozwiazywac;
 * nierozwiazanie ma byc LICZONE I RAPORTOWANE, nie tolerowane.
 */

export interface InvariantResult {
  invariant: string;
  total: number;
  violations: number;
  /** Pierwsze kilka przykladow (klucze/id) do debugowania — nie caly zbior. */
  examples: string[];
}

function missRatio(r: InvariantResult): number {
  return r.total > 0 ? r.violations / r.total : 0;
}

/** [1] Kazdy `TextLine.dominantFont.key` istnieje w rejestrze fontow (`InventoryResult.fonts`) — lapie DOKLADNIE rozjazd formuly z kroku 9. */
export function checkFontKeyResolvesInvariant(lines: readonly TextLine[], fontKeys: ReadonlySet<string>): InvariantResult {
  const examples: string[] = [];
  let violations = 0;
  for (const line of lines) {
    if (!fontKeys.has(line.dominantFont.key)) {
      violations++;
      if (examples.length < 10) examples.push(line.dominantFont.key);
    }
  }
  return { invariant: 'font-key-resolves-in-registry', total: lines.length, violations, examples };
}

/** [2] Chybienia `fontRoles.get()` od strony KONSUMENTA (blockBuilder itd.) — powinno byc ≈0, ten sam sygnal co [1] z drugiej strony potoku. */
export function checkFontRoleResolvesInvariant(lines: readonly TextLine[], fontRoles: ReadonlyMap<string, FontRole>): InvariantResult {
  const examples: string[] = [];
  let violations = 0;
  for (const line of lines) {
    if (!fontRoles.has(line.dominantFont.key)) {
      violations++;
      if (examples.length < 10) examples.push(line.dominantFont.key);
    }
  }
  return { invariant: 'font-role-resolves-for-consumer', total: lines.length, violations, examples };
}

/** [3] Kazdy `correlatedWith` wskazuje na ISTNIEJACY `ImageEntry.objId` — lapie rozjazd korelacji (KROK-5/6). */
export function checkCorrelatedWithInvariant(images: readonly ImageEntry[]): InvariantResult {
  const objIds = new Set(images.map((e) => e.objId).filter((id): id is string => id !== null));
  const withCorrelation = images.filter((e) => e.correlatedWith !== undefined);
  const examples: string[] = [];
  let violations = 0;
  for (const e of withCorrelation) {
    if (!objIds.has(e.correlatedWith!)) {
      violations++;
      if (examples.length < 10) examples.push(e.correlatedWith!);
    }
  }
  return { invariant: 'correlated-with-points-to-existing-entry', total: withCorrelation.length, violations, examples };
}

/** [4] Kazdy `Provenance.blockIds` wskazuje na ISTNIEJACY blok — lapie gubienie w budowie CIF (KROK-9). */
export function checkProvenanceBlockIdsInvariant(document: CIFDocument, validBlockIds: ReadonlySet<string>): InvariantResult {
  const examples: string[] = [];
  let total = 0;
  let violations = 0;
  for (const journal of document.journals) {
    for (const id of journal.provenance.blockIds) {
      total++;
      if (!validBlockIds.has(id)) {
        violations++;
        if (examples.length < 10) examples.push(id);
      }
    }
    for (const page of journal.pages) {
      for (const id of page.provenance.blockIds) {
        total++;
        if (!validBlockIds.has(id)) {
          violations++;
          if (examples.length < 10) examples.push(id);
        }
      }
    }
  }
  return { invariant: 'provenance-blockids-point-to-existing-blocks', total, violations, examples };
}

/** [5] Kazdy `columnIndex >= 0` wskazuje na ISTNIEJACA kolumne (per strona) — lapie rozjazd indeksow (KROK-6). */
export function checkColumnIndexInvariant(linesByPage: ReadonlyMap<number, readonly TextLine[]>, columnsByPage: ReadonlyMap<number, readonly ColumnRegion[]>): InvariantResult {
  const examples: string[] = [];
  let total = 0;
  let violations = 0;
  for (const [pageNumber, lines] of linesByPage) {
    const columns = columnsByPage.get(pageNumber) ?? [];
    const validIndices = new Set(columns.map((c) => c.index));
    for (const line of lines) {
      if (line.columnIndex < 0) continue; // -1 = rozpinajaca/marginalia, celowo poza tym niezmiennikiem
      total++;
      if (!validIndices.has(line.columnIndex)) {
        violations++;
        if (examples.length < 10) examples.push(`p${pageNumber}:${line.id}(col=${line.columnIndex})`);
      }
    }
  }
  return { invariant: 'columnindex-points-to-existing-column', total, violations, examples };
}

/**
 * [6] REGRESJA ZADANIA GLOWNEGO: zadna linia rozpinajaca nie przecina
 * WYKRYTEJ (confidence >= progu) rynny bez ANI JEDNEGO tokenu wewnatrz niej —
 * po przebiegu naprawczym (`gutterRepair.ts`) takie linie NIE POWINNY juz
 * istniec (zostalyby rozciete). Uruchamiane PO naprawie jako "belt and
 * suspenders" — jesli to kiedykolwiek zwroci >0, `repairGutterCrossingLines`
 * ma bug (nie zlapal czegos, co sam powinien byl zlapac).
 */
export function checkNoUnrepairedGutterCrossingInvariant(
  spanningLines: readonly TextLine[],
  columns: readonly ColumnRegion[],
  columnConfidence: number,
  confidenceThreshold = 0.85,
): InvariantResult {
  const examples: string[] = [];
  let violations = 0;
  if (columnConfidence >= confidenceThreshold && columns.length >= 2) {
    const sorted = [...columns].sort((a, b) => a.bbox.minX - b.bbox.minX);
    const gutters: { minX: number; maxX: number }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      gutters.push({ minX: sorted[i]!.bbox.maxX, maxX: sorted[i + 1]!.bbox.minX });
    }
    for (const line of spanningLines) {
      const crossed = gutters.filter((g) => line.bbox.minX < g.minX && line.bbox.maxX > g.maxX);
      if (crossed.length === 0) continue;
      const tokens = line.tokens ?? [];
      const hasTokenInGutter = crossed.some((g) => tokens.some((t) => t.bbox.maxX > g.minX && t.bbox.minX < g.maxX));
      if (!hasTokenInGutter && tokens.length > 0) {
        violations++;
        if (examples.length < 10) examples.push(line.id);
      }
    }
  }
  return { invariant: 'no-unrepaired-gutter-crossing', total: spanningLines.length, violations, examples };
}

export interface ReferenceInvariantsReport {
  results: InvariantResult[];
  /** Wskaznik chybien PONIZEJ tego progu liczy sie jako "OK" per niezmiennik — brief: "≈0". */
  maxAcceptableMissRatio: number;
}

/** Czy WSZYSTKIE niezmienniki w raporcie miesza sie ponizej progu chybien (bramka zielona/czerwona). */
export function isReferenceReportGreen(report: ReferenceInvariantsReport): boolean {
  return report.results.every((r) => missRatio(r) <= report.maxAcceptableMissRatio);
}

export { missRatio };
