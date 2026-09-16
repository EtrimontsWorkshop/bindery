import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildInventory } from '../../src/inventory/inventory.js';
import { buildTextLayout, type PdfDocumentLike } from '../../src/text/buildTextLayout.js';
import { buildPageLayouts } from '../../src/layout/buildPageLayout.js';

import { build as buildFalseMerge } from '../synth/fixtures/layout-2col-false-merge.js';
import { build as buildTrueSpanning } from '../synth/fixtures/layout-2col-true-spanning.js';
import { build as buildLowConfidence } from '../synth/fixtures/layout-2col-lowconfidence.js';

/**
 * Testy integracyjne grupy E (KROK-10 Z5) — dyskryminator "linia przecina
 * rynne" zweryfikowany na PRAWDZIWYM potoku (buildPageLayouts, ktory spina
 * detekcje kolumn + przebieg naprawczy `gutterRepair.ts`), nie tylko na
 * recznie zbudowanych `TextLine` (patrz `test/layout/gutterRepair.test.ts`
 * dla tamtych, szybszych testow jednostkowych samego dyskryminatora).
 *
 * `layout-2col-false-merge` i `layout-2col-true-spanning` sa CELOWO
 * nierozlaczne (brief): fixture dowodzacy rozcinania bez fixture'a
 * dowodzacego NIErozcinania nie dowodzi niczego.
 */

async function openFixture(buf: Buffer): Promise<PdfDocumentLike> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLike;
}

async function runFullPipeline(buf: Buffer) {
  const doc = await openFixture(buf);
  const inv = await buildInventory(doc as never);
  const fontSizeByKey = new Map(inv.fonts.map((f) => [f.key, f.size]));
  const doc2 = await openFixture(buf);
  const textLayout = await buildTextLayout(doc2, fontSizeByKey);
  const result = buildPageLayouts(textLayout, inv);
  return { inv, textLayout, result };
}

describe('grupa E — falszywe sklejenie kolumn (layout-2col-false-merge)', () => {
  it('linia laczaca dwie kolumny na tej samej wysokosci zostaje ROZCIETA (teraz przez Z1, PRZED gutterRepair)', async () => {
    // [KROK-11, odkrycie] Ten konkretny fixture (etykieta wiekszego fontu na
    // brzegu zlaczonej linii) jest teraz rozcinany przez `lineEdgeSplit.ts`
    // (Z1) WCZESNIEJ niz `gutterRepair.ts` w ogole dostaje szanse zadzialac —
    // wynikowe fragmenty sa juz zbyt WASKIE, zeby przecinac rynne, wiec
    // `GUTTER_FALSE_MERGE_REPAIRED` juz nie leci (nic nie zostaje do naprawy).
    // Koncowy efekt (poprawny podzial na kolumny) jest IDENTYCZNY jak wtedy,
    // gdy to gutterRepair.ts robil cala prace (KROK-10) — zmienil sie tylko
    // MECHANIZM i jego diagnostyka.
    const { result } = await runFullPipeline(buildFalseMerge());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    const edgeSplitDiag = result.diagnostics.find((d) => d.code === 'INLINE_HEADING_EDGE_SPLIT');
    expect(edgeSplitDiag).toBeDefined();
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const leftFragment = primary.lines.find((l) => l.text.includes('Short left end here'));
    const rightFragment = primary.lines.find((l) => l.text.includes('Sidebar Title'));
    expect(leftFragment).toBeDefined();
    expect(rightFragment).toBeDefined();
    // Rozciete na WLASCIWE kolumny — lewy fragment w kolumnie 0, prawy w kolumnie 1.
    expect(leftFragment!.columnIndex).toBe(0);
    expect(rightFragment!.columnIndex).toBe(1);
    // Zaden fragment NIE zawiera tekstu z drugiej strony rynny.
    expect(leftFragment!.text).not.toContain('Sidebar');
    expect(rightFragment!.text).not.toContain('Short left end');
  });
});

describe('grupa E — prawdziwa linia rozpinajaca (layout-2col-true-spanning)', () => {
  it('naglowek z tokenami WEWNATRZ obszaru rynny NIE zostaje ruszony — dyskryminator dziala w obie strony', async () => {
    const { result } = await runFullPipeline(buildTrueSpanning());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    // Brak diagnostyki naprawy — nic nie zostalo rozciete.
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const heading = primary.lines.find((l) => l.text.includes('Full Width Heading'));
    expect(heading).toBeDefined();
    // Pozostaje NIEPRZYPISANY do zadnej kolumny (spanning/marginalia w kolejnosci czytania), nie rozciety.
    expect(heading!.columnIndex).toBe(-1);
    expect(heading!.text).toBe(
      'Full Width Heading Spans The Gutter Right Through It Completely From Edge To Edge',
    );
  });
});

describe('grupa E — bezpiecznik progu ufnosci (layout-2col-lowconfidence)', () => {
  it('kolumny wykryte, ale NIEPEWNIE (confidence < 0.85) — falszywy wzorzec etykiety brzegowej i tak zostaje rozciety przez Z1 (niezalezny od confidence)', async () => {
    // [KROK-11, odkrycie] `lineEdgeSplit.ts` (Z1) dziala PRZED
    // `detectColumns`/`gutterRepair.ts` na SUROWYCH liniach i w OGOLE nie
    // patrzy na confidence kolumn — dla TEGO KONKRETNEGO wzorca (etykieta
    // wiekszego fontu na brzegu zlaczonej linii) Z1 rozcina go bezwarunkowo,
    // nawet gdy kolumny sa wykryte niepewnie. Bezpiecznik progu ufnosci
    // `gutterRepair.ts` (KROK-10) POZOSTAJE w kodzie i dziala identycznie jak
    // wczesniej — nadal weryfikowany bezposrednio, na poziomie funkcji, w
    // `gutterRepair.test.ts` ("confidence ponizej progu -> nietkniete") — ten
    // fixture po prostu juz nie demonstruje go w pelnym potoku dla TEGO
    // wzorca, bo Z1 zdazyl pierwszy. To NIE regresja: koncowy tekst jest
    // POPRAWNY (rozdzielony), tylko mechanizm sie zmienil.
    const { result } = await runFullPipeline(buildLowConfidence());
    const page = result.pages[0]!;
    expect(page.columns).toHaveLength(2);

    expect(result.diagnostics.find((d) => d.code === 'INLINE_HEADING_EDGE_SPLIT')).toBeDefined();
    expect(result.diagnostics.find((d) => d.code === 'GUTTER_FALSE_MERGE_REPAIRED')).toBeUndefined();

    const primary = page.streams.find((s) => s.angle === 0)!;
    const leftFragment = primary.lines.find((l) => l.text.includes('Short left end here'));
    const rightFragment = primary.lines.find((l) => l.text.includes('Sidebar Title'));
    expect(leftFragment).toBeDefined();
    expect(rightFragment).toBeDefined();
    expect(leftFragment!.text).not.toContain('Sidebar');
  });
});
