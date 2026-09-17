/**
 * Text-layer quality detector (MDD §6.2).
 *
 * Methodology empirically verified in phase 0 (spike) on 6 RPG manuals.
 * The spike sample came from a single re-emission pipeline (R-15) — these
 * functions are a safety net for files outside that sample (old PDFs,
 * scans), not just diagnostics for the good case.
 *
 * Pure functions — testable on synthetic strings, without opening a PDF.
 */

export interface QualitySignals {
  totalChars: number;
  /** Characters outside (Basic Latin + Latin-1 Supplement + Latin Extended-A). */
  outsideBasicLatin: number;
  /** U+FFFD — replacement character, a strong signal of a broken ToUnicode. */
  replacementChar: number;
  /** U+E000–U+F8FF — Private Use Area, a strong signal of broken glyph mapping. */
  privateUse: number;
  /** U+FB00–U+FB06 — unexpanded ligatures. */
  ligatures: number;
  /** U+00AD — soft hyphen. */
  softHyphens: number;
  /** U+0300–U+036F — combining marks (decomposed diacritics, not NFC). */
  combiningMarks: number;
}

function isBasicLatinExtended(code: number): boolean {
  // Basic Latin + Latin-1 Supplement + Latin Extended-A + general typography (spaces, dashes, quotation marks)
  return code === 0x20 || (code >= 0x0000 && code <= 0x024f) || (code >= 0x2000 && code <= 0x206f);
}

export function emptySignals(): QualitySignals {
  return {
    totalChars: 0,
    outsideBasicLatin: 0,
    replacementChar: 0,
    privateUse: 0,
    ligatures: 0,
    softHyphens: 0,
    combiningMarks: 0,
  };
}

/** Tallies quality signals for a single piece of text. */
export function tallySignals(text: string): QualitySignals {
  const s = emptySignals();
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    s.totalChars++;
    if (!isBasicLatinExtended(code)) s.outsideBasicLatin++;
    if (code === 0xfffd) s.replacementChar++;
    if (code >= 0xe000 && code <= 0xf8ff) s.privateUse++;
    if (code >= 0xfb00 && code <= 0xfb06) s.ligatures++;
    if (code === 0x00ad) s.softHyphens++;
    if (code >= 0x0300 && code <= 0x036f) s.combiningMarks++;
  }
  return s;
}

/** Sums multiple signal readings (e.g. from several sampled pages) into one. */
export function mergeSignals(all: readonly QualitySignals[]): QualitySignals {
  const merged = emptySignals();
  for (const s of all) {
    merged.totalChars += s.totalChars;
    merged.outsideBasicLatin += s.outsideBasicLatin;
    merged.replacementChar += s.replacementChar;
    merged.privateUse += s.privateUse;
    merged.ligatures += s.ligatures;
    merged.softHyphens += s.softHyphens;
    merged.combiningMarks += s.combiningMarks;
  }
  return merged;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * A 0–1 score. Signals that unambiguously indicate corruption (replacement
 * character, Private Use Area, combining marks — diacritics not in NFC)
 * are weighted heavily; characters outside the basic range are weighted
 * more leniently, since they may be legitimate (other scripts), not just corruption.
 */
export function computeUnicodeConfidence(signals: QualitySignals): number {
  if (signals.totalChars === 0) return 0;
  const corruptRatio =
    (signals.replacementChar + signals.privateUse + signals.combiningMarks) / signals.totalChars;
  const outsideRatio = signals.outsideBasicLatin / signals.totalChars;
  return clamp01(1 - corruptRatio * 5 - outsideRatio * 0.5);
}

export interface QualityVerdict {
  hasTextLayer: boolean;
  unicodeConfidence: number;
  suspectedScan: boolean;
}

/**
 * Classification per the thresholds from MDD §6.2.
 * `glyphCount` is the total number of characters on the sampled pages (before subtracting empty items).
 */
export function classifyQuality(glyphCount: number, signals: QualitySignals): QualityVerdict {
  const suspectedScan = glyphCount === 0;
  const unicodeConfidence = suspectedScan ? 0 : computeUnicodeConfidence(signals);
  return {
    hasTextLayer: !suspectedScan,
    unicodeConfidence,
    suspectedScan,
  };
}

/** Which page numbers to sample for a document with `pageCount` pages (phase 0 methodology: 1, 25%, 50%, 75%, last). */
export function pickSamplePages(pageCount: number): number[] {
  if (pageCount <= 0) return [];
  const pages = new Set<number>([
    1,
    Math.max(1, Math.round(pageCount * 0.25)),
    Math.max(1, Math.round(pageCount * 0.5)),
    Math.max(1, Math.round(pageCount * 0.75)),
    pageCount,
  ]);
  return [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
}
