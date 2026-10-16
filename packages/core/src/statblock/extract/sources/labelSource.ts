import { unionRect } from '../../../geometry.js';
import type { Diagnostic } from '../../../text/types.js';
import { reconstructLines } from '../reconstructLines.js';
import { compileProfileRegex, regexProblemDiagnostic, testProfileRegex, boundedText, type RegexProblem } from '../safeRegex.js';
import { elementBBox, type ExtractionBlock, type PageTextElement, type RawExtractionResult, type ReconstructedLine } from '../types.js';
import type { LabelSource } from './types.js';

/** What a label source may know about the rest of the profile: the other labels, so that a value stops where the next printed label begins ("HP: 12 AC: 15" is two values, not one). */
export interface LabelContext {
  otherLabels?: readonly { pattern: string; isRegex: boolean }[];
}

function notFound(labelPattern: string, diagnostics: Diagnostic[] = []): RawExtractionResult {
  return {
    found: false,
    raw: null,
    matchedElements: [],
    sourceBbox: null,
    diagnostics: diagnostics.length > 0 ? diagnostics : [{ severity: 'warning', code: 'STATBLOCK_LABEL_NOT_FOUND', params: { labelPattern } }],
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A plain (non-regex) label is compared without a trailing colon on either side, so "HP" finds "HP:" and vice versa. */
function stripColon(text: string): string {
  return text.trim().replace(/\s*:$/, '');
}

interface LineSpan {
  line: ReconstructedLine;
  text: string;
  /** Start offset of each element's text in `text` (elements are joined with one space). */
  starts: number[];
}

function spanOf(line: ReconstructedLine): LineSpan {
  const starts: number[] = [];
  let offset = 0;
  for (const element of line.elements) {
    starts.push(offset);
    offset += element.text.length + 1;
  }
  return { line, text: line.elements.map((e) => e.text).join(' '), starts };
}

/** A label as a pattern that finds it inside a line of text: at the start or after a space, and followed by a colon (optionally), then a space or the end. */
function inLinePattern(label: { pattern: string; isRegex: boolean }): { regex: RegExp } | { problem: RegexProblem } {
  const compiled = label.isRegex ? compileProfileRegex(label.pattern) : compileProfileRegex(`(?:^|\\s)${escapeRegex(stripColon(label.pattern))}\\s*:?(?=\\s|$)`);
  return compiled.ok ? { regex: compiled.regex } : { problem: compiled.problem };
}

/**
 * "Text after a label (plain text or regex) until the next label, the end of the current line, or the end of the
 * block." Matching happens at the LINE level (via `reconstructLines`, so column-adjacent unrelated text on the same
 * row is already separated out). The label is first looked for as ONE element's whole text — the usual layout, and
 * the only one profiles written earlier relied on — and then inside the text of a line, so that `[HP:] [12]`, `[HP: 12]`
 * and `[Hit] [Points:] [12]` read alike: how the PDF happened to split a line into text elements says nothing about
 * the page.
 */
export function extractFromLabelSource(block: ExtractionBlock, source: LabelSource, context: LabelContext = {}): RawExtractionResult {
  const labelCompiled = source.labelIsRegex ? compileProfileRegex(source.labelPattern) : null;
  if (labelCompiled && !labelCompiled.ok) return notFound(source.labelPattern, [regexProblemDiagnostic(labelCompiled.problem, source.labelPattern, 'labelPattern')]);
  const labelRegex = labelCompiled && labelCompiled.ok ? labelCompiled.regex : null;

  let nextLabelRegex: RegExp | null = null;
  if (source.stopAt === 'nextLabel') {
    if (!source.nextLabelPattern) {
      return notFound(source.labelPattern, [{ severity: 'error', code: 'STATBLOCK_MISSING_NEXT_LABEL_PATTERN', params: {} }]);
    }
    if (source.nextLabelIsRegex) {
      const nextCompiled = compileProfileRegex(source.nextLabelPattern);
      if (!nextCompiled.ok) return notFound(source.labelPattern, [regexProblemDiagnostic(nextCompiled.problem, source.nextLabelPattern, 'nextLabelPattern')]);
      nextLabelRegex = nextCompiled.regex;
    }
  }

  const lines = reconstructLines(block.elements);
  if (lines.length === 0) return notFound(source.labelPattern);
  const spans = lines.map(spanOf);

  const matchesLabel = (text: string): boolean => (labelRegex ? testProfileRegex(labelRegex, text.trim()) : stripColon(text) === stripColon(source.labelPattern));
  const matchesNextLabel = (text: string): boolean => (nextLabelRegex ? testProfileRegex(nextLabelRegex, text.trim()) : text.trim() === source.nextLabelPattern);

  // The label and where its value starts, in the text of its line.
  let labelSpan: LineSpan | null = null;
  let labelStart = 0;
  let valueStart = 0;
  let firstLabelElement = -1;

  for (const span of spans) {
    const index = span.line.elements.findIndex((e) => matchesLabel(e.text));
    if (index !== -1) {
      const element = span.line.elements[index]!;
      labelSpan = span;
      firstLabelElement = index;
      labelStart = span.starts[index]!;
      valueStart = labelStart + element.text.length;
      if (labelRegex) {
        // A regex that matches only the start of an element ("HP" in "HP 12") leaves the rest of it to the value.
        const trimmed = element.text.trim();
        const leading = element.text.length - element.text.trimStart().length;
        labelRegex.lastIndex = 0;
        const match = labelRegex.exec(boundedText(trimmed));
        if (match && match[0].length > 0) valueStart = labelStart + leading + match.index + match[0].length;
      }
      break;
    }
  }
  if (!labelSpan) {
    const own = inLinePattern({ pattern: source.labelPattern, isRegex: source.labelIsRegex });
    if ('regex' in own) {
      for (const span of spans) {
        own.regex.lastIndex = 0;
        const match = own.regex.exec(boundedText(span.text));
        if (!match) continue;
        const leading = match[0].length - match[0].trimStart().length;
        labelSpan = span;
        labelStart = match.index + leading;
        valueStart = match.index + match[0].length;
        firstLabelElement = span.starts.findIndex((start, i) => start + span.line.elements[i]!.text.length > labelStart);
        break;
      }
    }
  }
  if (!labelSpan) return notFound(source.labelPattern);

  // The value on the label's own line, cut where another label of the profile begins.
  let valueText = labelSpan.text.slice(valueStart);
  const fullValueLength = valueText.length;
  let cutAt = valueText.length;
  for (const other of context.otherLabels ?? []) {
    if (other.pattern === source.labelPattern && other.isRegex === source.labelIsRegex) continue;
    const pattern = inLinePattern(other);
    if (!('regex' in pattern)) continue;
    pattern.regex.lastIndex = 0;
    const found = pattern.regex.exec(boundedText(valueText));
    if (found && found.index < cutAt) cutAt = found.index;
  }
  valueText = valueText.slice(0, cutAt);
  const valueEnd = valueStart + valueText.length;

  // The elements that carry the label and the value: the label's own element(s) — the evidence of where the value
  // came from — and every element that overlaps the value.
  const elementEnd = (span: LineSpan, i: number): number => span.starts[i]! + span.line.elements[i]!.text.length;
  const matchedElements: PageTextElement[] = labelSpan.line.elements.filter((_, i) => i >= firstLabelElement && labelSpan!.starts[i]! < Math.max(valueEnd, labelStart + 1) && elementEnd(labelSpan!, i) > labelStart);
  if (matchedElements.length === 0) matchedElements.push(labelSpan.line.elements[firstLabelElement]!);

  const textParts: string[] = [valueText.trim()];

  // A value that another label cut short ends there; otherwise it may run on over the following lines.
  if (source.stopAt !== 'endOfLine' && cutAt === fullValueLength) {
    const labelLineIndex = spans.indexOf(labelSpan);
    for (let li = labelLineIndex + 1; li < lines.length; li++) {
      const line = lines[li]!;
      if (source.stopAt === 'nextLabel' && matchesNextLabel(line.text)) break;
      textParts.push(line.text);
      matchedElements.push(...line.elements);
    }
  }

  const raw = textParts.filter((part) => part.length > 0).join('\n');
  const diagnostics: Diagnostic[] = [];
  if (raw.length === 0) diagnostics.push({ severity: 'info', code: 'STATBLOCK_LABEL_VALUE_EMPTY', params: { labelPattern: source.labelPattern } });

  const sourceBbox = matchedElements.slice(1).reduce((acc, e) => unionRect(acc, elementBBox(e)), elementBBox(matchedElements[0]!));
  return { found: true, raw, matchedElements, sourceBbox, diagnostics };
}
