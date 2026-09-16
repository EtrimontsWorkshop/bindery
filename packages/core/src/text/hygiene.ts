import { computeUnicodeConfidence, tallySignals } from '../quality.js';
import type { CleanItem, Diagnostic, HygieneResult, PdfTextItemLike, WordBoundary } from './types.js';

/**
 * Higiena wejscia tekstowego (KROK-5 Z1, MDD §5.1). Funkcja czysta — operuje na
 * `TextItem[]` juz wyciagnietym przez wolajacego (`page.getTextContent()`), zero I/O.
 *
 * Kolejnosc krokow ma znaczenie (kazdy zmienia dane dla nastepnego) i jest
 * ZGODNA Z BRIEFEM: filtruj biale znaki -> odrzuc dokladne duplikaty -> scal
 * duplikaty przesuniete (syntheticBold) -> NFC -> ligatury -> soft hyphen -> metryki.
 */

// U+FB00–U+FB06 — ligatury lacinskie, NIE rozwijane przez normalize('NFC') (sa to
// osobne punkty kodowe kompatybilnosci, kanoniczna dekompozycja NFKD by je rozwinela,
// ale NFC ich celowo nie rusza — musimy zrobic to sami, patrz KROK-3/KROK-5).
const LIGATURE_MAP = new Map<string, string>([
  ['ﬀ', 'ff'],
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬅ', 'st'], // "long s" + t — brak osobnego glifu w zwyklym tekscie, zbieznosc semantyczna z "st"
  ['ﬆ', 'st'],
]);
const LIGATURE_RE = /[ﬀ-ﬆ]/g;
const SOFT_HYPHEN_RE = /­/g;

/** Duplikat przesuniety uznajemy za "syntetyczne pogrubienie" ponizej tego progu (KROK-3/4 ustalenie: 0.3pt realny przypadek). */
const SYNTHETIC_BOLD_MAX_SHIFT = 0.5;
/** Ile itemow wprzod szukamy pasujacego duplikatu — duplikaty w realnych PDF-ach sa emitowane bezposrednio po sobie. */
const DUPLICATE_LOOKAHEAD = 3;

function isWhitespaceOnly(str: string): boolean {
  return str.length > 0 && str.trim().length === 0;
}

function sameTransformScale(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function positionDistance(a: readonly number[], b: readonly number[]): number {
  const dx = (a[4] ?? 0) - (b[4] ?? 0);
  const dy = (a[5] ?? 0) - (b[5] ?? 0);
  return Math.hypot(dx, dy);
}

function isExactDuplicate(a: PdfTextItemLike, b: PdfTextItemLike): boolean {
  return a.str === b.str && a.transform.length === b.transform.length && a.transform.every((v, i) => v === b.transform[i]);
}

function isNearDuplicate(a: PdfTextItemLike, b: PdfTextItemLike): boolean {
  if (a.str !== b.str) return false;
  if (!sameTransformScale(a.transform, b.transform)) return false;
  const d = positionDistance(a.transform, b.transform);
  return d > 0 && d < SYNTHETIC_BOLD_MAX_SHIFT;
}

interface IndexedItem {
  index: number;
  item: PdfTextItemLike;
  syntheticBold: boolean;
}

/** Krok 1: rozdziela wejscie na realne itemy i granice wyrazow z itemow bialoznakowych (sasiadujace scalone w jedna granice). */
function extractWordBoundaries(items: readonly PdfTextItemLike[]): { real: IndexedItem[]; boundaries: WordBoundary[] } {
  const real: IndexedItem[] = [];
  const boundaries: WordBoundary[] = [];
  let lastRealIndex = -1;
  let pendingBoundary: WordBoundary | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.str.length === 0) continue; // pusty item — nic do zachowania ani do granicy

    if (isWhitespaceOnly(item.str)) {
      const gapStart = item.transform[4] ?? 0;
      const gapEnd = gapStart + item.width;
      if (pendingBoundary && pendingBoundary.afterItemIndex === lastRealIndex) {
        pendingBoundary.gapEnd = Math.max(pendingBoundary.gapEnd, gapEnd);
      } else {
        pendingBoundary = { afterItemIndex: lastRealIndex, gapStart, gapEnd };
        boundaries.push(pendingBoundary);
      }
      continue;
    }

    real.push({ index: i, item, syntheticBold: false });
    lastRealIndex = i;
    pendingBoundary = null;
  }

  return { real, boundaries };
}

/** Kroki 2-3: dokladne duplikaty odrzucone, przesuniete scalone z syntheticBold=true. */
function dedupePositional(real: readonly IndexedItem[]): IndexedItem[] {
  const result: IndexedItem[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < real.length; i++) {
    if (consumed.has(i)) continue;
    const current = real[i]!;
    let syntheticBold = false;

    for (let j = i + 1; j < real.length && j <= i + DUPLICATE_LOOKAHEAD; j++) {
      if (consumed.has(j)) continue;
      const candidate = real[j]!;
      if (isExactDuplicate(current.item, candidate.item)) {
        consumed.add(j); // dokladny duplikat — odrzucony, zachowujemy pierwsze wystapienie
        break;
      }
      if (isNearDuplicate(current.item, candidate.item)) {
        consumed.add(j); // przesuniety duplikat — scalony, oznaczony jako syntheticBold
        syntheticBold = true;
        break;
      }
    }
    result.push({ index: current.index, item: current.item, syntheticBold });
  }

  return result;
}

function expandLigatures(str: string): string {
  return str.replace(LIGATURE_RE, (ch) => LIGATURE_MAP.get(ch) ?? ch);
}

export function runHygiene(items: readonly PdfTextItemLike[]): HygieneResult {
  const diagnostics: Diagnostic[] = [];

  const { real, boundaries } = extractWordBoundaries(items);
  const deduped = dedupePositional(real);

  const cleanItems: CleanItem[] = deduped.map((d) => {
    let str = d.item.str.normalize('NFC');
    str = expandLigatures(str);
    str = str.replace(SOFT_HYPHEN_RE, '');
    return {
      index: d.index,
      str,
      transform: d.item.transform,
      width: d.item.width,
      height: d.item.height,
      fontName: d.item.fontName,
      syntheticBold: d.syntheticBold,
    };
  });

  const nonEmptyItemCount = cleanItems.length;
  const fragmented = cleanItems.filter((c) => c.str.trim().length > 0 && c.str.trim().length < 3).length;
  const fragmentationRatio = nonEmptyItemCount > 0 ? fragmented / nonEmptyItemCount : 0;

  const joinedText = cleanItems.map((c) => c.str).join('');
  const signals = tallySignals(joinedText);
  const unicodeConfidence = computeUnicodeConfidence(signals);

  if (unicodeConfidence < 0.5) {
    diagnostics.push({
      severity: 'warning',
      code: 'UNICODE_LOW_CONFIDENCE',
      params: { confidence: unicodeConfidence.toFixed(2) },
    });
  }

  return {
    items: cleanItems,
    wordBoundaries: boundaries,
    diagnostics,
    metrics: {
      fragmentationRatio,
      unicodeConfidence,
      puaCharCount: signals.privateUse,
      combiningCharCount: signals.combiningMarks,
      nonEmptyItemCount,
    },
  };
}

/** Czy jakakolwiek granica wyrazu wypada MIEDZY dwoma oryginalnymi indeksami (wlacznie z lewym, wylacznie prawym) — [U2] twardy zakaz scalania (KROK-5 P1). */
export function hasBoundaryBetween(boundaries: readonly WordBoundary[], leftOriginalIndex: number, rightOriginalIndex: number): boolean {
  return boundaries.some((b) => b.afterItemIndex >= leftOriginalIndex && b.afterItemIndex < rightOriginalIndex);
}
