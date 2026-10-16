import { unionRect, type Rect } from '../../../geometry.js';
import { toParamValue } from '../diagnosticParam.js';
import { reconstructLines } from '../reconstructLines.js';
import { elementBBox, elementCenter, type ExtractionBlock, type RawExtractionResult } from '../types.js';
import type { NormalizedRect, RegionSource } from './types.js';

/** Maps a normalized (0..1) rect onto the block's own bbox — (0,0) is (bbox.minX, bbox.minY), (1,1) is (bbox.maxX, bbox.maxY), regardless of which corner that is "visually" (this project's Y-up PDF-space convention). */
function denormalizeRect(blockBbox: Rect, normalized: RegionSource['normalizedRect']): Rect {
  const width = blockBbox.maxX - blockBbox.minX;
  const height = blockBbox.maxY - blockBbox.minY;
  return {
    minX: blockBbox.minX + normalized.minX * width,
    minY: blockBbox.minY + normalized.minY * height,
    maxX: blockBbox.minX + normalized.maxX * width,
    maxY: blockBbox.minY + normalized.maxY * height,
  };
}

/**
 * The inverse of the mapping a region source applies: a rectangle in PDF space as fractions of a block's own bounding
 * box (0,0 is its minX/minY corner, 1,1 its maxX/maxY corner). What a profile author's selection has to be turned into
 * to be read back from the same place in every other statblock. `null` when the block has no extent to measure against.
 */
export function normalizeRectToBlock(rect: Rect, blockBbox: Rect): NormalizedRect | null {
  const width = blockBbox.maxX - blockBbox.minX;
  const height = blockBbox.maxY - blockBbox.minY;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    minX: (rect.minX - blockBbox.minX) / width,
    minY: (rect.minY - blockBbox.minY) / height,
    maxX: (rect.maxX - blockBbox.minX) / width,
    maxY: (rect.maxY - blockBbox.minY) / height,
  };
}

/**
 * "A rectangle normalized relative to the statblock's bounding
 * box." An element is included when its CENTER point falls inside the
 * denormalized rect — the same inclusion rule the old, deleted
 * `inferPatternFromSelection.ts` used for its own mouse-selection filter
 * (center-in-rect, not full containment or any overlap), so a value
 * whose bbox slightly overflows a tightly-drawn capture rectangle is
 * still picked up.
 */
export function extractFromRegionSource(block: ExtractionBlock, source: RegionSource): RawExtractionResult {
  const actualRect = denormalizeRect(block.bbox, source.normalizedRect);
  const matchedElements = block.elements.filter((el) => {
    const center = elementCenter(el);
    return center.x >= actualRect.minX && center.x <= actualRect.maxX && center.y >= actualRect.minY && center.y <= actualRect.maxY;
  });

  if (matchedElements.length === 0) {
    return {
      found: false,
      raw: null,
      matchedElements: [],
      sourceBbox: null,
      diagnostics: [{ severity: 'warning', code: 'STATBLOCK_REGION_EMPTY', params: { normalizedRect: toParamValue(source.normalizedRect) } }],
    };
  }

  const lines = reconstructLines(matchedElements);
  const raw = lines.map((line) => line.text).join('\n');
  const sourceBbox = matchedElements.slice(1).reduce((acc, e) => unionRect(acc, elementBBox(e)), elementBBox(matchedElements[0]!));
  const diagnostics = raw.length === 0 ? [{ severity: 'info' as const, code: 'STATBLOCK_REGION_VALUE_EMPTY', params: {} }] : [];
  return { found: true, raw, matchedElements, sourceBbox, diagnostics };
}
