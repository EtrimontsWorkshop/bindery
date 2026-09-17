/**
 * Types shared by text hygiene and the layout layer (Step 5, MDD §5.1).
 * Zero dependency on Foundry or on pdf.js — `PdfTextItemLike` is a
 * DUCK-TYPED shape matching the real `TextItem` from pdf.js, verified
 * empirically (see RAPORT-KROK-5.md): { str, dir, width, height, transform,
 * fontName, hasEOL }. Testable with hand-written arrays without opening a PDF.
 */

import type { LocalizableMessage } from '../localizableMessage.js';

/** Duck-typed subset of pdf.js's TextItem actually used here. */
export interface PdfTextItemLike {
  str: string;
  dir: string;
  /** Width in PDF units (already scaled by the transform), 0 for synthetic items. */
  width: number;
  height: number;
  /** [a, b, c, d, e, f] — the text*CTM matrix at the moment of drawing. */
  transform: readonly number[];
  fontName: string;
  hasEOL: boolean;
}

/**
 * [Step 27 Z1] `message: string` REMOVED — it duplicated `code` with a
 * ready-made Polish sentence that couldn't be localized (the core has no
 * i18n, A1). The renderer (`packages/module`) formats `code`+`params` via
 * `game.i18n.format` — see `LocalizableMessage`.
 */
export interface Diagnostic extends LocalizableMessage {
  severity: 'info' | 'warning' | 'error';
  pageNumber?: number;
  /** [Step 9] The semantic block this diagnostic concerns — MDD §5.3 (CIF Diagnostic). */
  blockId?: string;
}

/**
 * [U2] The position of a filtered-out whitespace item — a HARD boundary for
 * word merging (Step 5 P1). `afterItemIndex` is the original index (in the
 * raw input array BEFORE filtering) of the last kept item before the
 * boundary; -1 when the boundary falls before the first kept item.
 */
export interface WordBoundary {
  afterItemIndex: number;
  gapStart: number;
  gapEnd: number;
}

/** An item after hygiene (Z1) — the original `index` is kept for boundary checks. */
export interface CleanItem {
  /** Index in the original (pre-filter) input array. After duplicate merging: the index of the FIRST occurrence. */
  index: number;
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  fontName: string;
  /** [F0] A positional duplicate shifted < 0.5pt — merged into one item with this flag. */
  syntheticBold: boolean;
}

export interface HygieneMetrics {
  /** After filtering whitespace and merging duplicates — different from the raw phase-0 metric. */
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

/** [F0] MDD §5.1: font fingerprint — ONLY `key` carries meaning for rules. */
export interface FontFingerprint {
  key: string;
  size: number;
  display?: { family: string; weightSuffix?: string; italic?: boolean };
}
