import { unionRect } from '../../../geometry.js';
import { toParamValue } from '../diagnosticParam.js';
import { reconstructLines } from '../reconstructLines.js';
import { elementBBox, type ExtractionBlock, type PageTextElement, type RawExtractionResult } from '../types.js';
import type { StyleFilter, StyleFilterSource } from './types.js';

const FONT_SIZE_EPSILON = 0.01;

function matchesBaseCriteria(el: PageTextElement, filter: StyleFilter): boolean {
  if (filter.fontNamePattern !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(filter.fontNamePattern);
    } catch {
      return false;
    }
    if (!regex.test(el.fontName)) return false;
  }
  if (filter.minFontSize !== undefined && el.fontSize < filter.minFontSize) return false;
  if (filter.maxFontSize !== undefined && el.fontSize > filter.maxFontSize) return false;
  if (filter.bold !== undefined && el.bold !== filter.bold) return false;
  if (filter.italic !== undefined && el.italic !== filter.italic) return false;
  return true;
}

/**
 * [Task 2] "Filters by style (font, size, bold), e.g. 'the largest font in
 * the block'." `largestFontInBlock` composes with the other criteria: it
 * narrows to the largest `fontSize` among elements that ALREADY pass
 * `fontNamePattern`/`bold`/`italic` (or among every element in the block,
 * when no other criteria are given) — so "largest bold font in block" and
 * "largest font in block" both work from the same option set.
 */
export function extractFromStyleFilterSource(block: ExtractionBlock, source: StyleFilterSource): RawExtractionResult {
  const filter = source.filter;
  let matchedElements = block.elements.filter((el) => matchesBaseCriteria(el, filter));

  if (filter.largestFontInBlock) {
    if (matchedElements.length === 0) {
      return {
        found: false,
        raw: null,
        matchedElements: [],
        sourceBbox: null,
        diagnostics: [{ severity: 'warning', code: 'STATBLOCK_STYLE_FILTER_NO_MATCH', params: { filter: toParamValue(filter) } }],
      };
    }
    const maxSize = Math.max(...matchedElements.map((e) => e.fontSize));
    matchedElements = matchedElements.filter((e) => Math.abs(e.fontSize - maxSize) <= FONT_SIZE_EPSILON);
  }

  if (matchedElements.length === 0) {
    return {
      found: false,
      raw: null,
      matchedElements: [],
      sourceBbox: null,
      diagnostics: [{ severity: 'warning', code: 'STATBLOCK_STYLE_FILTER_NO_MATCH', params: { filter: toParamValue(filter) } }],
    };
  }

  const lines = reconstructLines(matchedElements);
  const raw = lines.map((line) => line.text).join('\n');
  const sourceBbox = matchedElements.slice(1).reduce((acc, e) => unionRect(acc, elementBBox(e)), elementBBox(matchedElements[0]!));
  return { found: true, raw, matchedElements, sourceBbox, diagnostics: [] };
}
