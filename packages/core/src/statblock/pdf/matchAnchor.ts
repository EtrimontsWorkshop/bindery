import type { PageTextElement, ReconstructedLine } from '../extract/types.js';
import type { DetectionConfig } from '../profile/schema.js';

/** Shared text-matching helper — exact trimmed match for plain text, a (safely-compiled) regex otherwise. An invalid regex degrades to "never matches" rather than throwing (A7). */
export function matchesTextPattern(text: string, pattern: string, isRegex?: boolean): boolean {
  const trimmed = text.trim();
  if (!isRegex) return trimmed === pattern;
  try {
    return new RegExp(pattern).test(trimmed);
  } catch {
    return false;
  }
}

/**
 * A line matches a `headingStyle` anchor when EVERY element on it satisfies
 * the style filter (a heading line is assumed uniformly styled — a line
 * mixing heading-styled and body-styled elements isn't a clean heading
 * match) AND, if `anchor.pattern` is ALSO given, the line's full joined
 * text matches it too (style narrows WHICH lines count as headings at
 * all; an additional pattern narrows WHICH heading is the one we want).
 *
 * `largestFontInBlock` has no "block" yet at detection time (that's what
 * we're trying to find) — reinterpreted here as "the largest font size
 * found anywhere on this element's own PAGE", passed in by the caller
 * (`detectStatblocks.ts`, computed once per page). Documented simplification.
 */
function lineMatchesHeadingStyle(line: ReconstructedLine, anchor: DetectionConfig['anchor'], maxFontSizeOnPage: number): boolean {
  const filter = anchor.styleFilter;
  if (!filter) return false;
  const elementMatches = (el: PageTextElement): boolean => {
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
    if (filter.largestFontInBlock && Math.abs(el.fontSize - maxFontSizeOnPage) > 0.01) return false;
    return true;
  };
  if (line.elements.length === 0 || !line.elements.every(elementMatches)) return false;
  if (anchor.pattern !== undefined && !matchesTextPattern(line.text, anchor.pattern, anchor.patternIsRegex)) return false;
  return true;
}

/** Whether this reconstructed line is a match for the profile's start anchor — see `DetectionConfig.anchor` in `profile/schema.ts` for the two kinds. */
export function lineMatchesAnchor(line: ReconstructedLine, anchor: DetectionConfig['anchor'], maxFontSizeOnPage: number): boolean {
  if (anchor.kind === 'textPattern') {
    if (anchor.pattern === undefined) return false;
    // Plain text means "the line contains it": a statblock's start line usually holds more than the text a person would type (a name plus a type, a label plus its value), so an exact whole-line match would almost never fire. Exact matching stays available through a regex (`^…$`).
    if (!anchor.patternIsRegex) return anchor.pattern.trim() !== '' && line.text.includes(anchor.pattern.trim());
    return matchesTextPattern(line.text, anchor.pattern, true);
  }
  return lineMatchesHeadingStyle(line, anchor, maxFontSizeOnPage);
}
