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
  it('all keys resolve in the registry -> 0 misses', () => {
    const lines = [line('a', 'Body@10'), line('b', 'Heading@18')];
    const result = checkFontKeyResolvesInvariant(lines, new Set(['Body@10', 'Heading@18']));
    expect(result.violations).toBe(0);
    expect(missRatio(result)).toBe(0);
  });

  it('a key outside the registry -> counted and reported as a miss', () => {
    const lines = [line('a', 'Body@10'), line('b', 'Ghost@7.5')];
    const result = checkFontKeyResolvesInvariant(lines, new Set(['Body@10']));
    expect(result.violations).toBe(1);
    expect(result.examples).toContain('Ghost@7.5');
    expect(missRatio(result)).toBeCloseTo(0.5);
  });
});

describe('[1] A NEGATIVE TEST — the old font size formula (transform[2]/[3]) turns the gate RED', () => {
  /**
   * Reproduces EXACTLY a past bug: `inventory.ts` computed the size from transform[2]/[3] (the Y
   * axis), while `textGeometry.ts`/lines compute from transform[0]/[1] (the X axis). For text WITH
   * HORIZONTAL SCALING (Tz, transform[0] != transform[3]) these two formulas give a DIFFERENT size ->
   * a DIFFERENT key -> the gate MUST catch it.
   */
  const baseFont = 'CondensedBody';
  // transform = [a,b,c,d,e,f]. a=7.5 (the X scale after a condensed Tz), d=10 (the Y scale, the "real" size).
  const asymmetricTransform: [number, number, number, number, number, number] = [7.5, 0, 0, 10, 45, 700];

  function oldBuggyFontSize(transform: readonly number[]): number {
    // The old formula (removed in the fix) — transform[2]/[3], the Y axis.
    return Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
  }
  function currentFontSize(transform: readonly number[]): number {
    // The current, correct formula (`fontSizeFromTransform`, textGeometry.ts) — transform[0]/[1], the X axis.
    return Math.hypot(transform[0] ?? 0, transform[1] ?? 0);
  }

  it('the gate GREEN with the CURRENT (correct, unified) formula', () => {
    const correctSize = currentFontSize(asymmetricTransform); // 7.5
    const correctKey = buildFontKey(baseFont, correctSize);
    const lines = [line('l0', correctKey)]; // TextLine.dominantFont.key as lineCluster.ts actually produces it today
    const registryKeys = new Set([buildFontKey(baseFont, currentFontSize(asymmetricTransform))]); // inventory.ts today: the same formula
    const result = checkFontKeyResolvesInvariant(lines, registryKeys);
    expect(result.violations).toBe(0);
  });

  it('the gate RED when the old formula (transform[2]/[3]) is RESTORED in the registry — exactly a past bug', () => {
    const correctSize = currentFontSize(asymmetricTransform); // 7.5 — what REALLY ends up in TextLine.dominantFont.key
    const correctKey = buildFontKey(baseFont, correctSize);
    const lines = [line('l0', correctKey)];

    // A registry built with the OLD (restored) formula — simulates `inventory.ts` from BEFORE the fix.
    const buggySize = oldBuggyFontSize(asymmetricTransform); // 10 — DIFFERENT from 7.5
    const buggyKey = buildFontKey(baseFont, buggySize);
    const buggyRegistryKeys = new Set([buggyKey]);

    expect(buggyKey).not.toBe(correctKey); // the mere fact that the keys DIFFER is the heart of the bug
    const result = checkFontKeyResolvesInvariant(lines, buggyRegistryKeys);
    expect(result.violations).toBe(1); // THE GATE GOES RED
    expect(result.examples).toContain(correctKey);
  });
});

describe('[2] checkFontRoleResolvesInvariant', () => {
  it('no role for a key -> a miss counted', () => {
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
  it('correlatedWith pointing at an existing objId -> 0 misses', () => {
    const images = [imageEntry('img1'), imageEntry('img2', { correlatedWith: 'img1' })];
    const result = checkCorrelatedWithInvariant(images);
    expect(result.violations).toBe(0);
  });

  it('correlatedWith pointing at a NONEXISTENT objId -> a miss counted', () => {
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
      source: { fileName: 'x', fileHash: 'h', pageCount: 1, detectedLanguage: null, extractedAt: 'now' },
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

  it('all blockIds exist -> 0 misses', () => {
    const result = checkProvenanceBlockIdsInvariant(cifDoc(['b0', 'b1']), new Set(['b0', 'b1']));
    expect(result.violations).toBe(0);
  });

  it('a blockId pointing at a nonexistent block -> counted', () => {
    const result = checkProvenanceBlockIdsInvariant(cifDoc(['b0', 'ghost']), new Set(['b0']));
    expect(result.violations).toBeGreaterThan(0);
    expect(result.examples).toContain('ghost');
  });
});

describe('[5] checkColumnIndexInvariant', () => {
  it('a columnIndex pointing at an existing column -> 0 misses', () => {
    const lines = new Map([[1, [line('a', 'Body@10', { columnIndex: 0 }), line('b', 'Body@10', { columnIndex: 1 })]]]);
    const columns = new Map<number, ColumnRegion[]>([[1, [{ index: 0, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }, { index: 1, bbox: { minX: 2, minY: 0, maxX: 3, maxY: 1 } }]]]);
    const result = checkColumnIndexInvariant(lines, columns);
    expect(result.violations).toBe(0);
  });

  it('a columnIndex without a matching column -> counted', () => {
    const lines = new Map([[1, [line('a', 'Body@10', { columnIndex: 3 })]]]);
    const columns = new Map<number, ColumnRegion[]>([[1, [{ index: 0, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }]]]);
    const result = checkColumnIndexInvariant(lines, columns);
    expect(result.violations).toBe(1);
  });

  it('columnIndex=-1 (spanning/marginalia) deliberately skipped — doesn\'t count as a miss', () => {
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

  it('a spanning line WITH ZERO tokens in the gutter, high confidence -> SHOULD already be split; if it isn\'t, it is a REGRESSION (a miss)', () => {
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

  it('a true spanning line (a token IN the gutter) -> does NOT count as a miss', () => {
    const trueSpanning = line('l0', 'Body@10', {
      bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 },
      tokens: [{ text: 'spans', bbox: { minX: 45, minY: 700, maxX: 500, maxY: 710 } }],
    });
    const result = checkNoUnrepairedGutterCrossingInvariant([trueSpanning], columns, 0.9);
    expect(result.violations).toBe(0);
  });

  it('confidence below the threshold -> the invariant isn\'t checked (the safeguard acted deliberately, no regression to report)', () => {
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
  it('all invariants below the threshold -> the report green', () => {
    const results: InvariantResult[] = [
      { invariant: 'a', total: 100, violations: 0, examples: [] },
      { invariant: 'b', total: 100, violations: 1, examples: [] },
    ];
    expect(isReferenceReportGreen({ results, maxAcceptableMissRatio: 0.02 })).toBe(true);
  });

  it('one invariant above the threshold -> the report red', () => {
    const results: InvariantResult[] = [{ invariant: 'a', total: 10, violations: 5, examples: [] }];
    expect(isReferenceReportGreen({ results, maxAcceptableMissRatio: 0.02 })).toBe(false);
  });
});
