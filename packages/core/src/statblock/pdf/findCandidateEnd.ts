import type { DetectionConfig } from '../profile/schema.js';
import { isSameColumn, type ReadingOrderEntry } from './readingOrder.js';
import { matchesTextPattern } from './matchAnchor.js';

/**
 * [Task 3] Where a candidate that started at `startIndex` ends, per
 * `boundary.kind` — returns an EXCLUSIVE end index into `readingOrder`.
 * `nextAnchorIndex` (the next line that itself matches the anchor, or
 * `null`) is ALWAYS an implicit hard cap regardless of `boundary.kind` —
 * two statblocks can never overlap, so no boundary rule is allowed to run
 * past the start of the next one.
 */
export function findCandidateEnd(readingOrder: readonly ReadingOrderEntry[], startIndex: number, nextAnchorIndex: number | null, boundary: DetectionConfig['boundary']): number {
  const hardCap = nextAnchorIndex ?? readingOrder.length;

  switch (boundary.kind) {
    case 'nextAnchor':
      // Spans columns/pages freely — this is what lets a statblock legitimately break across one.
      return hardCap;

    case 'endOfColumnOrPage': {
      // A hard stop the moment reading order crosses into a different column/page — for books where a statblock never legitimately spans one (so two side-by-side or back-to-back statblocks are never merged).
      let end = startIndex + 1;
      while (end < hardCap && isSameColumn(readingOrder[end]!, readingOrder[startIndex]!)) end++;
      return end;
    }

    case 'verticalGap': {
      // A column/page crossing is NEVER itself a gap violation (reset there) — only a genuine typographic gap WITHIN continuous reading stops the candidate, so it still spans a column/page break when nothing else does.
      const threshold = boundary.gapThreshold!;
      let end = startIndex + 1;
      for (; end < hardCap; end++) {
        const previous = readingOrder[end - 1]!;
        const current = readingOrder[end]!;
        if (!isSameColumn(previous, current)) continue;
        const gap = previous.line.bbox.minY - current.line.bbox.maxY;
        if (gap > threshold) break;
      }
      return end;
    }

    case 'endLabel': {
      // Crosses columns/pages freely looking for the closing marker, same as nextAnchor — the marker line itself is EXCLUDED from the candidate.
      const pattern = boundary.endLabelPattern!;
      const isRegex = boundary.endLabelIsRegex ?? false;
      let end = startIndex + 1;
      for (; end < hardCap; end++) {
        if (matchesTextPattern(readingOrder[end]!.line.text, pattern, isRegex)) break;
      }
      return end;
    }
  }
}
