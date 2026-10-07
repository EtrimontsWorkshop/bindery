import { describe, expect, it } from 'vitest';
import {
  classifyQuality,
  computeUnicodeConfidence,
  emptySignals,
  mergeSignals,
  pickSamplePages,
  tallySignals,
} from '../src/quality.js';

describe('tallySignals', () => {
  it('counts pure ASCII text with no corruption signals', () => {
    const s = tallySignals('Hello world');
    expect(s.totalChars).toBe(11);
    expect(s.outsideBasicLatin).toBe(0);
    expect(s.replacementChar).toBe(0);
    expect(s.privateUse).toBe(0);
    expect(s.combiningMarks).toBe(0);
  });

  it('precomposed Polish diacritics (NFC) fit within Latin Extended-A', () => {
    const s = tallySignals('Siła Zręczność Wytrzymałość');
    expect(s.totalChars).toBeGreaterThan(0);
    expect(s.outsideBasicLatin).toBe(0);
  });

  it('detects the replacement character U+FFFD', () => {
    const s = tallySignals('abc�def');
    expect(s.replacementChar).toBe(1);
  });

  it('detects Private Use Area', () => {
    const s = tallySignals('abcdef');
    expect(s.privateUse).toBe(1);
  });

  it('detects unexpanded ligatures', () => {
    const s = tallySignals('ﬁle'); // ﬁle
    expect(s.ligatures).toBe(1);
  });

  it('detects a soft hyphen', () => {
    const s = tallySignals('wo­rd');
    expect(s.softHyphens).toBe(1);
  });

  it('detects combining marks (decomposed diacritics, not NFC)', () => {
    const decomposed = 'é'; // e + combining acute accent, instead of the precomposed é
    const s = tallySignals(decomposed);
    expect(s.combiningMarks).toBe(1);
  });
});

describe('mergeSignals', () => {
  it('sums the signals from many samples', () => {
    const a = tallySignals('abc');
    const b = tallySignals('��');
    const merged = mergeSignals([a, b]);
    expect(merged.totalChars).toBe(5);
    expect(merged.replacementChar).toBe(2);
  });

  it('an empty list gives empty signals', () => {
    expect(mergeSignals([])).toEqual(emptySignals());
  });
});

describe('computeUnicodeConfidence', () => {
  it('returns 1 for perfectly clean text', () => {
    const s = tallySignals('The quick brown fox jumps over the lazy dog.');
    expect(computeUnicodeConfidence(s)).toBe(1);
  });

  it('returns 0 for empty text', () => {
    expect(computeUnicodeConfidence(emptySignals())).toBe(0);
  });

  it('degrades strongly with a large share of replacement characters', () => {
    const s = tallySignals('����������');
    expect(computeUnicodeConfidence(s)).toBeLessThan(0.2);
  });

  it('degrades with a large share of combining marks (diacritics not in NFC)', () => {
    const decomposed = 'é'.repeat(20);
    const s = tallySignals(decomposed);
    expect(computeUnicodeConfidence(s)).toBeLessThan(0.5);
  });

  it('the result is never negative or > 1', () => {
    const worst = tallySignals('�'.repeat(1000));
    const c = computeUnicodeConfidence(worst);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe('classifyQuality', () => {
  it('glyphCount === 0 -> suspectedScan, hasTextLayer=false, confidence=0', () => {
    const v = classifyQuality(0, emptySignals());
    expect(v.suspectedScan).toBe(true);
    expect(v.hasTextLayer).toBe(false);
    expect(v.unicodeConfidence).toBe(0);
  });

  it('text present and clean -> hasTextLayer=true, suspectedScan=false, high confidence', () => {
    const s = tallySignals('Some real book content here, plenty of it.');
    const v = classifyQuality(s.totalChars, s);
    expect(v.hasTextLayer).toBe(true);
    expect(v.suspectedScan).toBe(false);
    expect(v.unicodeConfidence).toBe(1);
  });

  it('text present but heavily corrupted -> hasTextLayer=true despite a low confidence', () => {
    const s = tallySignals('�'.repeat(50));
    const v = classifyQuality(s.totalChars, s);
    expect(v.hasTextLayer).toBe(true);
    expect(v.suspectedScan).toBe(false);
    expect(v.unicodeConfidence).toBeLessThan(0.5);
  });
});

describe('pickSamplePages', () => {
  it('the spike methodology: pages 1, 25%, 50%, 75%, the last', () => {
    expect(pickSamplePages(256)).toEqual([1, 64, 128, 192, 256]);
  });

  it('a 1-page document returns one page', () => {
    expect(pickSamplePages(1)).toEqual([1]);
  });

  it('a 0-page document (an extreme case) returns an empty list', () => {
    expect(pickSamplePages(0)).toEqual([]);
  });

  it('a small document (4 pages) doesn\'t duplicate page numbers', () => {
    const pages = pickSamplePages(4);
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(4);
  });
});
