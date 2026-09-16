import { describe, expect, it } from 'vitest';
import { buildSemanticBlocks, type BlockBuilderInput } from '../../src/semantic/blockBuilder.js';
import type { OrderedLine } from '../../src/layout/readingOrder.js';
import type { TextLine } from '../../src/layout/lineCluster.js';
import type { FontRole } from '../../src/inventory/fontRegistry.js';
import type { VectorRegion } from '../../src/inventory/vectorRegistry.js';
import type { ColumnRegion } from '../../src/layout/columns.js';

function line(id: string, text: string, minX: number, maxX: number, y: number, fontKey = 'Body@10', columnIndex = 0): TextLine {
  return {
    id,
    text,
    bbox: { minX, minY: y, maxX, maxY: y + 10 },
    columnIndex,
    crossAxisPosition: y,
    fonts: [{ key: fontKey, size: 10 }],
    dominantFont: { key: fontKey, size: 10 },
    syntheticBold: false,
  };
}

function ordered(l: TextLine, angle: 0 | 90 | 180 | 270 = 0): OrderedLine {
  return { line: l, streamAngle: angle };
}

function baseInput(overrides: Partial<BlockBuilderInput> = {}): BlockBuilderInput {
  return {
    pageNumber: 1,
    orderedLines: [],
    fontRoles: new Map(),
    vectors: [],
    images: [],
    runningElementKindByLineId: new Map(),
    columns: [],
    ...overrides,
  };
}

describe('buildSemanticBlocks — granice bloku', () => {
  it('regularne linie tej samej kolumny/fontu z typowa interlinia tworza JEDEN blok', () => {
    const lines = [
      line('l0', 'First line of the paragraph', 72, 300, 700),
      line('l1', 'Second line continuing on', 72, 300, 688),
      line('l2', 'Third line finishing it up', 72, 300, 676),
    ];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines.map((l) => l.id)).toEqual(['l0', 'l1', 'l2']);
  });

  it('odstep znaczaco wiekszy niz typowa interlinia dzieli na DWA bloki (nowy akapit)', () => {
    // Kilka regularnych odstepow (12pt) ustala "typowa" mediane, zanim pojawi sie wyraznie wiekszy (48pt).
    const lines = [
      line('l0', 'Paragraph one line one text here', 72, 300, 700),
      line('l1', 'Paragraph one line two text here', 72, 300, 688), // gap=12
      line('l2', 'Paragraph one line three text here', 72, 300, 676), // gap=12
      line('l3', 'Paragraph one line four text here', 72, 300, 664), // gap=12
      line('l4', 'Paragraph two starts way below here', 72, 300, 616), // gap=48 >> mediana(12)*1.8
    ];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.lines.map((l) => l.id)).toEqual(['l0', 'l1', 'l2', 'l3']);
    expect(blocks[1]!.lines.map((l) => l.id)).toEqual(['l4']);
  });

  it('zmiana klucza fontu dominujacego dzieli blok, nawet przy regularnej interlinii', () => {
    const lines = [
      line('l0', 'Heading text goes here', 72, 300, 700, 'Heading@18'),
      line('l1', 'Body text starts right after', 72, 300, 688, 'Body@10'),
      line('l2', 'Body text continues normally', 72, 300, 676, 'Body@10'),
    ];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.lines.map((l) => l.id)).toEqual(['l0']);
    expect(blocks[1]!.lines.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('zmiana kolumny dzieli blok', () => {
    const lines = [line('l0', 'left col text here now', 72, 280, 700, 'Body@10', 0), line('l1', 'right col text here now', 320, 550, 700, 'Body@10', 1)];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks).toHaveLength(2);
  });

  it('wciecie pierwszej linii ponad progiem dzieli blok (nowy akapit mimo tego samego fontu/kolumny)', () => {
    const lines = [
      line('l0', 'First paragraph text here now', 72, 300, 700),
      line('l1', 'Continuation of first paragraph', 72, 300, 688),
      line('l2', 'New paragraph, indented start here', 100, 320, 676), // wciecie 100 vs 72 (28pt > prog 8pt)
    ];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks).toHaveLength(2);
  });

  it('[U3] krawedz regionu wektorowego dzieli blok mimo regularnej interlinii/fontu/kolumny', () => {
    const fillRegion: VectorRegion = { kind: 'fill', bbox: { minX: 60, minY: 670, maxX: 310, maxY: 705 }, page: 1, relativeArea: 0.1, groupSubtype: null };
    const lines = [
      line('l0', 'Inside the framed sidebar region', 72, 300, 700), // wewnatrz regionu
      line('l1', 'Still inside the framed region here', 72, 300, 688), // wewnatrz
      line('l2', 'Outside the region now continuing', 72, 300, 640), // POZA regionem (Y ponizej 670)
    ];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)), vectors: [fillRegion] }));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks[0]!.lines.map((l) => l.id)).toEqual(['l0', 'l1']);
  });
});

describe('buildSemanticBlocks — klasyfikacja BlockKind', () => {
  it('header/footer z Z5 ma priorytet nad wszystkim innym', () => {
    const l = line('h0', 'Chapter One - 5', 72, 200, 760);
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: [ordered(l)], runningElementKindByLineId: new Map([['h0', 'header']]) }),
    );
    expect(blocks[0]!.kind).toBe('header');
    expect(blocks[0]!.matchedRuleId).toBe('Z5-running-element');
  });

  it('strumien o kacie != 0 zawsze klasyfikowany jako marginalia', () => {
    const l = line('m0', 'Sidebar note running vertically', 560, 580, 400);
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: [ordered(l, 90)] }));
    expect(blocks[0]!.kind).toBe('marginalia');
  });

  it('rola heading + blok krotki -> heading', () => {
    const l = line('t0', 'Chapter Title', 72, 300, 700, 'Heading@18');
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: [ordered(l)], fontRoles: new Map([['Heading@18', 'heading' as FontRole]]) }),
    );
    expect(blocks[0]!.kind).toBe('heading');
    expect(blocks[0]!.matchedRuleId).toBe('Z6-heading-role');
  });

  it('rola body + wiele linii -> body', () => {
    const lines = [line('b0', 'Body text line one here now', 72, 300, 700), line('b1', 'Body text line two here now', 72, 300, 688)];
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: lines.map((l) => ordered(l)), fontRoles: new Map([['Body@10', 'body' as FontRole]]) }),
    );
    expect(blocks[0]!.kind).toBe('body');
  });

  it('wypunktowanie kropkowe (5+ kropek) -> table, niezaleznie od roli fontu', () => {
    const l = line('toc0', 'Chapter One ..................... 12', 72, 400, 700);
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: [ordered(l)] }));
    expect(blocks[0]!.kind).toBe('table');
    expect(blocks[0]!.matchedRuleId).toBe('Z6-dot-leader');
  });

  it('[U3] blok wewnatrz regionu wektorowego fill, NA UBOCZU ukladu kolumnowego -> sidebar', () => {
    const fillRegion: VectorRegion = { kind: 'fill', bbox: { minX: 400, minY: 400, maxX: 550, maxY: 700 }, page: 1, relativeArea: 0.2, groupSubtype: null };
    const sidebarLine = line('s0', 'Sidebar tip text inside the box', 410, 540, 650, 'Body@10', 1);
    const mainLine = line('main0', 'Main column body text here now', 72, 300, 650, 'Body@10', 0);
    // Jedyna WYKRYTA kolumna (Z3) pokrywa TYLKO glowny tekst — sidebar (x=410-540) lezy
    // POZA jej bboxem, wiec spelnia warunek "na uboczu" (patrz isOffToTheSideOfColumns).
    const mainColumn: ColumnRegion = { index: 0, bbox: { minX: 72, minY: 400, maxX: 300, maxY: 700 } };
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: [ordered(mainLine), ordered(sidebarLine)], vectors: [fillRegion], columns: [mainColumn] }),
    );
    const sidebarBlock = blocks.find((b) => b.lines.some((l) => l.id === 's0'));
    expect(sidebarBlock!.kind).toBe('sidebar');
  });

  it('[KROK-6, odkrycie] blok wewnatrz regionu wektorowego fill, ale WEWNATRZ wykrytej kolumny (nie na uboczu) -> NIE sidebar', () => {
    // To samo tlo/uklad co wyzej, ale wykryta kolumna jest SZEROKA (obejmuje oba
    // bloki) — np. duzy dekoracyjny fill na cala strone nie powinien zamieniac
    // zwyklego body tekstu w sidebar tylko dlatego, ze strona ma >1 kolumne gdzies indziej.
    const fillRegion: VectorRegion = { kind: 'fill', bbox: { minX: 60, minY: 400, maxX: 550, maxY: 700 }, page: 1, relativeArea: 0.9, groupSubtype: null };
    const mainLine = line('main0', 'Main column body text here now', 72, 300, 650, 'Body@10', 0);
    const otherLine = line('other0', 'Other column body text here too', 320, 540, 650, 'Body@10', 1);
    const wideColumn: ColumnRegion = { index: 0, bbox: { minX: 72, minY: 400, maxX: 300, maxY: 700 } };
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: [ordered(mainLine), ordered(otherLine)], vectors: [fillRegion], columns: [wideColumn] }),
    );
    const mainBlock = blocks.find((b) => b.lines.some((l) => l.id === 'main0'));
    expect(mainBlock!.kind).not.toBe('sidebar');
  });

  it('brak zadnego dopasowania -> unknown', () => {
    const l = line('u0', 'Some text with no matching role at all', 72, 300, 700, 'Weird@10');
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: [ordered(l)] }));
    expect(blocks[0]!.kind).toBe('unknown');
  });
});

describe('buildSemanticBlocks — [KROK-9 Z1a] rola accent -> reguly strukturalne', () => {
  it('accent, jedna linia, izolowana (gora kolumny, brak sasiada) -> heading', () => {
    const l = line('a0', 'Section Title In Accent Font', 72, 300, 700, 'Accent@11');
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: [ordered(l)], fontRoles: new Map([['Accent@11', 'accent' as FontRole]]) }),
    );
    expect(blocks[0]!.kind).toBe('heading');
    expect(blocks[0]!.matchedRuleId).toBe('Z9-accent-isolated-heading');
  });

  it('accent, jedna linia, BEZ izolacji (sasiad blisko powyzej i ponizej) -> NIE heading', () => {
    // 5 linii o regularnej interlinii (12pt, >=3 probki gora niz do wyliczenia
    // mediany) — srodkowa linia jest w foncie accent, ale odstepy do sasiadow
    // sa TYPOWE (12pt), wiec accent nie moze "przebic sie" do heading bez
    // prawdziwej izolacji pionowej.
    const lines = [
      line('b0', 'Body text line one here now', 72, 300, 700, 'Body@10'),
      line('b1', 'Body text line two here now', 72, 300, 688, 'Body@10'),
      line('a0', 'Accent text inline emphasis run', 72, 300, 676, 'Accent@11'),
      line('b2', 'Body text line three here now', 72, 300, 664, 'Body@10'),
      line('b3', 'Body text line four here now', 72, 300, 652, 'Body@10'),
    ];
    const blocks = buildSemanticBlocks(
      baseInput({
        orderedLines: lines.map((l) => ordered(l)),
        fontRoles: new Map([
          ['Body@10', 'body' as FontRole],
          ['Accent@11', 'accent' as FontRole],
        ]),
      }),
    );
    const accentBlock = blocks.find((b) => b.lines.some((l) => l.id === 'a0'));
    expect(accentBlock!.kind).not.toBe('heading');
  });

  it('accent, wiele linii, wewnatrz kolumny -> body', () => {
    const lines = [
      line('a0', 'Accent multi-line paragraph text one', 72, 300, 700, 'Accent@10'),
      line('a1', 'Accent multi-line paragraph text two', 72, 300, 688, 'Accent@10'),
    ];
    const blocks = buildSemanticBlocks(
      baseInput({ orderedLines: lines.map((l) => ordered(l)), fontRoles: new Map([['Accent@10', 'accent' as FontRole]]) }),
    );
    expect(blocks[0]!.kind).toBe('body');
    expect(blocks[0]!.matchedRuleId).toBe('Z9-accent-multiline-in-column-body');
  });

  it('accent, sasiedztwo obrazu -> caption', () => {
    const l = line('c0', 'Fot. Jan Kowalski', 72, 300, 700, 'Accent@9');
    const blocks = buildSemanticBlocks(
      baseInput({
        orderedLines: [ordered(l)],
        fontRoles: new Map([['Accent@9', 'accent' as FontRole]]),
        images: [{ bbox: { minX: 60, minY: 705, maxX: 310, maxY: 780 } }],
      }),
    );
    expect(blocks[0]!.kind).toBe('caption');
    expect(blocks[0]!.matchedRuleId).toBe('Z9-caption-near-image');
  });
});

describe('buildSemanticBlocks — matchedRuleId zawsze wypelnione', () => {
  it('kazdy blok ma matchedRuleId (MDD wymaga tego wprost)', () => {
    const lines = [line('a', 'text a here now for testing', 72, 300, 700), line('b', 'text b here now for testing', 72, 300, 500)];
    const blocks = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(blocks.every((b) => typeof b.matchedRuleId === 'string' && b.matchedRuleId.length > 0)).toBe(true);
  });
});

describe('buildSemanticBlocks — determinizm id', () => {
  it('id blokow sa stabilne (nie zaleza od globalnego licznika miedzy wywolaniami)', () => {
    const lines = [line('a', 'text a here now for testing', 72, 300, 700)];
    const first = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    const second = buildSemanticBlocks(baseInput({ orderedLines: lines.map((l) => ordered(l)) }));
    expect(first.map((b) => b.id)).toEqual(second.map((b) => b.id));
  });
});
