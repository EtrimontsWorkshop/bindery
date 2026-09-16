/**
 * Detektor jakości warstwy tekstowej (MDD §6.2).
 *
 * Metodyka zweryfikowana empirycznie w fazie 0 (spike) na 6 podręcznikach RPG.
 * Próbka spike'u pochodziła z jednego pipeline'u re-emisji (R-15) — te funkcje są
 * siatką bezpieczeństwa dla plików spoza tej próbki (starych PDF-ów, skanów),
 * nie tylko diagnostyką dla przypadku dobrego.
 *
 * Czyste funkcje — testowalne na syntetycznych stringach, bez otwierania PDF-a.
 */

export interface QualitySignals {
  totalChars: number;
  /** Znaki spoza (Basic Latin + Latin-1 Supplement + Latin Extended-A). */
  outsideBasicLatin: number;
  /** U+FFFD — znak zastępczy, silny sygnał uszkodzonego ToUnicode. */
  replacementChar: number;
  /** U+E000–U+F8FF — Private Use Area, silny sygnał uszkodzonego mapowania glifów. */
  privateUse: number;
  /** U+FB00–U+FB06 — ligatury nierozwinięte. */
  ligatures: number;
  /** U+00AD — soft hyphen. */
  softHyphens: number;
  /** U+0300–U+036F — znaki łączące (diakrytyki zdekomponowane, nie NFC). */
  combiningMarks: number;
}

function isBasicLatinExtended(code: number): boolean {
  // Basic Latin + Latin-1 Supplement + Latin Extended-A + typografia ogólna (spacje, myślniki, cudzysłowy)
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

/** Zlicza sygnały jakości dla pojedynczego fragmentu tekstu. */
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

/** Sumuje wiele odczytów sygnałów (np. z kilku próbkowanych stron) w jeden. */
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
 * Wynik 0–1. Sygnały jednoznacznie korumpujące (znak zastępczy, Private Use Area,
 * znaki łączące — diakrytyki nie w NFC) ważone mocno; znaki spoza zakresu podstawowego
 * ważone łagodniej, bo mogą być legalne (inne skrypty), nie tylko uszkodzeniem.
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
 * Klasyfikacja per progi z MDD §6.2.
 * `glyphCount` to suma znaków na próbkowanych stronach (przed odjęciem pustych itemów).
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

/** Które numery stron próbkować dla dokumentu o `pageCount` stronach (metodyka fazy 0: 1, 25%, 50%, 75%, ostatnia). */
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
