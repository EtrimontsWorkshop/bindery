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
  it('liczy czysty tekst ASCII bez sygnalow uszkodzenia', () => {
    const s = tallySignals('Hello world');
    expect(s.totalChars).toBe(11);
    expect(s.outsideBasicLatin).toBe(0);
    expect(s.replacementChar).toBe(0);
    expect(s.privateUse).toBe(0);
    expect(s.combiningMarks).toBe(0);
  });

  it('polskie diakrytyki prekomponowane (NFC) mieszcza sie w Latin Extended-A', () => {
    const s = tallySignals('Siła Zręczność Wytrzymałość');
    expect(s.totalChars).toBeGreaterThan(0);
    expect(s.outsideBasicLatin).toBe(0);
  });

  it('wykrywa znak zastepczy U+FFFD', () => {
    const s = tallySignals('abc�def');
    expect(s.replacementChar).toBe(1);
  });

  it('wykrywa Private Use Area', () => {
    const s = tallySignals('abcdef');
    expect(s.privateUse).toBe(1);
  });

  it('wykrywa ligatury nierozwiniete', () => {
    const s = tallySignals('ﬁle'); // ﬁle
    expect(s.ligatures).toBe(1);
  });

  it('wykrywa soft hyphen', () => {
    const s = tallySignals('wo­rd');
    expect(s.softHyphens).toBe(1);
  });

  it('wykrywa znaki laczace (diakrytyki zdekomponowane, nie NFC)', () => {
    const decomposed = 'é'; // e + combining acute accent, zamiast precomponowanego é
    const s = tallySignals(decomposed);
    expect(s.combiningMarks).toBe(1);
  });
});

describe('mergeSignals', () => {
  it('sumuje sygnaly z wielu probek', () => {
    const a = tallySignals('abc');
    const b = tallySignals('��');
    const merged = mergeSignals([a, b]);
    expect(merged.totalChars).toBe(5);
    expect(merged.replacementChar).toBe(2);
  });

  it('pusta lista daje puste sygnaly', () => {
    expect(mergeSignals([])).toEqual(emptySignals());
  });
});

describe('computeUnicodeConfidence', () => {
  it('zwraca 1 dla idealnie czystego tekstu', () => {
    const s = tallySignals('The quick brown fox jumps over the lazy dog.');
    expect(computeUnicodeConfidence(s)).toBe(1);
  });

  it('zwraca 0 dla pustego tekstu', () => {
    expect(computeUnicodeConfidence(emptySignals())).toBe(0);
  });

  it('degraduje mocno przy duzym udziale znakow zastepczych', () => {
    const s = tallySignals('����������');
    expect(computeUnicodeConfidence(s)).toBeLessThan(0.2);
  });

  it('degraduje przy duzym udziale znakow laczacych (diakrytyki nie w NFC)', () => {
    const decomposed = 'é'.repeat(20);
    const s = tallySignals(decomposed);
    expect(computeUnicodeConfidence(s)).toBeLessThan(0.5);
  });

  it('wynik nigdy nie jest ujemny ani > 1', () => {
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

  it('tekst obecny i czysty -> hasTextLayer=true, suspectedScan=false, wysoka pewnosc', () => {
    const s = tallySignals('Some real book content here, plenty of it.');
    const v = classifyQuality(s.totalChars, s);
    expect(v.hasTextLayer).toBe(true);
    expect(v.suspectedScan).toBe(false);
    expect(v.unicodeConfidence).toBe(1);
  });

  it('tekst obecny ale silnie uszkodzony -> hasTextLayer=true mimo niskiej pewnosci', () => {
    const s = tallySignals('�'.repeat(50));
    const v = classifyQuality(s.totalChars, s);
    expect(v.hasTextLayer).toBe(true);
    expect(v.suspectedScan).toBe(false);
    expect(v.unicodeConfidence).toBeLessThan(0.5);
  });
});

describe('pickSamplePages', () => {
  it('metodyka fazy 0: strony 1, 25%, 50%, 75%, ostatnia', () => {
    expect(pickSamplePages(256)).toEqual([1, 64, 128, 192, 256]);
  });

  it('dokument 1-stronicowy zwraca jedna strone', () => {
    expect(pickSamplePages(1)).toEqual([1]);
  });

  it('dokument 0-stronicowy (skrajny przypadek) zwraca pusta liste', () => {
    expect(pickSamplePages(0)).toEqual([]);
  });

  it('maly dokument (4 strony) nie duplikuje numerow stron', () => {
    const pages = pickSamplePages(4);
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(4);
  });
});
