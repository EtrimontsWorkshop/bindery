/**
 * Typy wspolne dla higieny tekstu i warstwy ukladu (KROK-5, MDD §5.1).
 * Zero zaleznosci od Foundry ani od pdf.js — `PdfTextItemLike` to ksztalt
 * DUCK-TYPED odpowiadajacy prawdziwemu `TextItem` z pdf.js, zweryfikowany
 * empirycznie (patrz RAPORT-KROK-5.md): { str, dir, width, height, transform,
 * fontName, hasEOL }. Testowalne na recznie napisanych tablicach bez otwierania PDF-a.
 */

import type { LocalizableMessage } from '../localizableMessage.js';

/** Duck-typed podzbior pdf.js TextItem faktycznie uzywany tutaj. */
export interface PdfTextItemLike {
  str: string;
  dir: string;
  /** Szerokosc w jednostkach PDF (juz przeskalowana przez transform), 0 dla itemow syntetycznych. */
  width: number;
  height: number;
  /** [a, b, c, d, e, f] — macierz tekstu*CTM w momencie rysowania. */
  transform: readonly number[];
  fontName: string;
  hasEOL: boolean;
}

/**
 * [KROK-27 Z1] `message: string` USUNIETE — dublowalo `code` gotowym
 * polskim zdaniem, ktorego nie dalo sie zlokalizowac (rdzen nie ma i18n, A1).
 * Renderujacy (`packages/module`) formatuje `code`+`params` przez
 * `game.i18n.format` — patrz `LocalizableMessage`.
 */
export interface Diagnostic extends LocalizableMessage {
  severity: 'info' | 'warning' | 'error';
  pageNumber?: number;
  /** [KROK-9] Blok semantyczny, ktorego dotyczy diagnostyka — MDD §5.3 (CIF Diagnostic). */
  blockId?: string;
}

/**
 * [U2] Pozycja odfiltrowanego itemu bialoznakowego — TWARDA granica scalania
 * wyrazow (KROK-5 P1). `afterItemIndex` to oryginalny indeks (w surowej
 * tablicy wejsciowej PRZED filtrowaniem) ostatniego zachowanego itemu przed
 * granica; -1 gdy granica wypada przed pierwszym zachowanym itemem.
 */
export interface WordBoundary {
  afterItemIndex: number;
  gapStart: number;
  gapEnd: number;
}

/** Item po higienie (Z1) — oryginalny `index` zachowany do sprawdzania granic. */
export interface CleanItem {
  /** Indeks w oryginalnej (przed-filtrowanej) tablicy wejsciowej. Po scaleniu duplikatow: indeks PIERWSZEGO wystapienia. */
  index: number;
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  fontName: string;
  /** [F0] Duplikat pozycyjny przesuniety < 0.5pt — scalony w jeden item z ta flaga. */
  syntheticBold: boolean;
}

export interface HygieneMetrics {
  /** Po odfiltrowaniu bialych znakow i scaleniu duplikatow — inaczej niz surowa metryka fazy 0. */
  fragmentationRatio: number;
  unicodeConfidence: number;
  puaCharCount: number;
  combiningCharCount: number;
  nonEmptyItemCount: number;
}

export interface HygieneResult {
  items: CleanItem[];
  wordBoundaries: WordBoundary[];
  diagnostics: Diagnostic[];
  metrics: HygieneMetrics;
}

export type StreamAngle = 0 | 90 | 180 | 270;

/** [F0] MDD §5.1: fingerprint fontu, WYLACZNIE `key` jest nosny dla regul. */
export interface FontFingerprint {
  key: string;
  size: number;
  display?: { family: string; weightSuffix?: string; italic?: boolean };
}
