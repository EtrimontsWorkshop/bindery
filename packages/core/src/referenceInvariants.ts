import type { ColumnRegion } from './layout/columns.js';
import type { TextLine } from './layout/lineCluster.js';
import type { FontRole } from './inventory/fontRegistry.js';
import type { ImageEntry } from './inventory/imageRegistry.js';
import type { CIFDocument } from './cif/types.js';

/**
 * REFERENCE invariants gate (Step 10, second task) — complements the
 * existing GEOMETRIC gate (§11.3, `mediaBoxInvariant.test.ts`). The font
 * size formula mismatch from step 9 (`inventory.ts` computed from
 * transform[2]/[3], `textGeometry.ts` from transform[0]/[1]) is the FOURTH
 * occurrence of the same bug class (Step 4: the shape of `cm` arguments;
 * Step 5: the shape of `constructPath` arguments; Step 6: `item.width`
 * already in device space) — all silent, none threw an exception, all
 * found by accident. Principle: `undefined` as a silent failure mode is
 * the enemy — every key passed between pipeline stages MUST resolve;
 * failure to resolve must be COUNTED AND REPORTED, not tolerated.
 */

export interface InvariantResult {
  invariant: string;
  total: number;
  violations: number;
  /** The first few examples (keys/ids) for debugging — not the whole set. */
  examples: string[];
}

function missRatio(r: InvariantResult): number {
  return r.total > 0 ? r.violations / r.total : 0;
}

/** [1] Every `TextLine.dominantFont.key` exists in the font registry (`InventoryResult.fonts`) — catches EXACTLY the formula mismatch from step 9. */
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

/** [2] Misses of `fontRoles.get()` from the CONSUMER side (blockBuilder etc.) — should be ≈0, the same signal as [1] from the other side of the pipeline. */
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

/** [3] Every `correlatedWith` points to an EXISTING `ImageEntry.objId` — catches correlation mismatches (Step 5/6). */
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

/** [4] Every `Provenance.blockIds` points to an EXISTING block — catches data loss in CIF construction (Step 9). */
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

/** [5] Every `columnIndex >= 0` points to an EXISTING column (per page) — catches index mismatches (Step 6). */
export function checkColumnIndexInvariant(linesByPage: ReadonlyMap<number, readonly TextLine[]>, columnsByPage: ReadonlyMap<number, readonly ColumnRegion[]>): InvariantResult {
  const examples: string[] = [];
  let total = 0;
  let violations = 0;
  for (const [pageNumber, lines] of linesByPage) {
    const columns = columnsByPage.get(pageNumber) ?? [];
    const validIndices = new Set(columns.map((c) => c.index));
    for (const line of lines) {
      if (line.columnIndex < 0) continue; // -1 = spanning/marginalia, deliberately outside this invariant
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
 * [6] MAIN-TASK REGRESSION: no spanning line crosses a DETECTED (confidence
 * >= the threshold) gutter without EVEN ONE token inside it — after the
 * repair pass (`gutterRepair.ts`), such lines SHOULD NO LONGER exist (they
 * would have been split). Run AFTER the repair as "belt and suspenders" —
 * if this ever returns >0, `repairGutterCrossingLines` has a bug (it
 * missed something it itself should have caught).
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
  /** A miss ratio BELOW this threshold counts as "OK" per invariant — brief: "≈0". */
  maxAcceptableMissRatio: number;
}

/** Whether ALL invariants in the report stay below the miss-ratio threshold (green/red gate). */
export function isReferenceReportGreen(report: ReferenceInvariantsReport): boolean {
  return report.results.every((r) => missRatio(r) <= report.maxAcceptableMissRatio);
}

export { missRatio };
