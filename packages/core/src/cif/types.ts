import type { Rect } from '../geometry.js';
import type { ImageTargetKind } from '../images/finalize.js';
import type { Diagnostic } from '../text/types.js';

/**
 * CIF — Canonical Intermediate Format. A neutral
 * format: it contains no concepts from any specific game system or Foundry.
 */

export interface Provenance {
  pageNumber: number;
  bbox: Rect;
  blockIds: string[];
}

/**
 * `rawText` carries the original content of EVERY element (an empty string
 * when a scene has no accompanying text at all — heading/caption).
 */
export interface CIFScene {
  id: string;
  name: string;
  imageRef: string;
  /** null = not detected. Do NOT guess — automatic grid detection is out of MVP scope. */
  suggestedGrid: { sizePx: number; offsetX: number; offsetY: number } | null;
  rawText: string;
  provenance: Provenance;
}

/** A system-neutral image (map/handout/portrait), independent of whether it ends up on a scene or in a journal. */
export interface CIFImage {
  id: string;
  targetKind: ImageTargetKind;
  width: number;
  height: number;
  format: string;
  /** Reference to the image bytes — filled in by the import layer (outside the CIF, which is pure data), NOT the binary content itself. */
  assetRef: string;
  /** Caption/accompanying text (a nearby `caption` block), if any. */
  caption?: string;
  /**
   * `'content'` or `'undecided'` — ONLY these two values enter the CIF
   * (`decoration`/`mask` are rejected earlier, see `buildCIFDocument.ts`).
   * The review screen uses this field for default checking/sorting —
   * `packages/module` does NOT compute the classification itself, it only READS
   * what `core` has already decided (`check:boundary`).
   */
  classification: 'content' | 'undecided';
  /** See `ClassifiedImage.confidence` in `images/classify.ts`. */
  confidence: number;
  /**
   * Automatic grid-detection suggestion from
   * pixels (`images/detectGrid.ts`) — best-effort, `undefined` when nothing
   * was found. ONLY a suggestion to pre-fill the manual calibrator
   * (`GridPicker`, `packages/module`) — `packages/core` does NOT decide
   * whether it is "confident enough" to show (that decision is UI policy,
   * see the comment in `detectGrid.ts`).
   */
  suggestedGrid?: { size: number; offsetX: number; offsetY: number; confidence: number };
  rawText: string;
  provenance: Provenance;
}

/** A single journal page — the equivalent of `JournalEntryPage` (Foundry), but neutral. */
export interface CIFJournalPage {
  id: string;
  name: string;
  /** 1-6, the heading level FROM WHICH this page was created (Foundry `title.level`). */
  headingLevel: number;
  /** HTML already SANITIZED — ready for `JournalEntryPage.text.content`. */
  html: string;
  /** `CIFImage.id` of images embedded in this page's content, in order of occurrence. */
  imageRefs: string[];
  rawText: string;
  provenance: Provenance;
}

/** A single journal entry — the equivalent of `JournalEntry` (Foundry), but neutral; the bookmark tree flattened into (JournalEntry -> pages), see `buildJournalHierarchy.ts`. */
export interface CIFJournal {
  id: string;
  name: string;
  pages: CIFJournalPage[];
  rawText: string;
  provenance: Provenance;
}

export interface CIFDocument {
  schemaVersion: 1;
  source: {
    fileName: string;
    fileHash: string;
    pageCount: number;
    detectedLanguage: string | null;
    /** ISO 8601. */
    extractedAt: string;
  };
  journals: CIFJournal[];
  scenes: CIFScene[];
  images: CIFImage[];
  diagnostics: Diagnostic[];
}
