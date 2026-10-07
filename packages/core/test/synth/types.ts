/** A numeric range — both bounds optional, at least one required in practice. */
export interface ClaimRange {
  min?: number;
  max?: number;
}

export type ClaimValue = number | ClaimRange | string[] | boolean;

/**
 * Layer 1 (self-check) — properties of the fixture verified by running it through pdf.js. The keys
 * correspond to the metrics computed in verifyClaims.ts.
 */
export interface FixtureClaims {
  pageCount?: number;
  /** The share of non-empty items with str.length < 3. */
  fragmentationRatio?: ClaimRange;
  /** The share of items with transform[1]!==0 || transform[2]!==0, computed over ALL items. */
  rotatedItemRatio?: ClaimRange;
  /** The number of items with str === "" (before filtering). */
  emptyItemCount?: number | ClaimRange;
  /** All text items (empty + non-empty). */
  totalItemCount?: number | ClaimRange;
  /** Non-empty items made up solely of whitespace (e.g. a single space). */
  whitespaceOnlyItemCount?: number | ClaimRange;
  /** Items with a non-empty str. */
  nonEmptyItemCount?: number | ClaimRange;
  /** The unicode quality confidence from the quality detector (src/quality.ts), 0-1. */
  unicodeConfidence?: ClaimRange;
  /** Pairs of items with an identical str and an identical transform matrix. */
  exactPositionalDuplicateCount?: number | ClaimRange;
  /** Pairs of items with an identical str, the matrix shifted by < 1pt. */
  nearPositionalDuplicateCount?: number | ClaimRange;
  /** The number of image operations from getOperatorList(), summed over all pages. */
  imageCount?: number | ClaimRange;
  /** The minimum number of images on EACH page (not the sum) — for "N images per page" fixtures. */
  minImagesPerPage?: number;
  combiningCharCount?: number | ClaimRange;
  ligatureCount?: number | ClaimRange;
  puaCharCount?: number | ClaimRange;
  /** The expected set of names (commonObjs.get(x).name) of the fonts used — compared as a set. */
  distinctFontKeys?: string[];
  /** Whether a beginGroup with smask.subtype === "Luminosity" occurred in the operator list. */
  hasLuminosityGroup?: boolean;
  /** The number of pages with zero glyphs (a proxy for a scan). */
  zeroGlyphPageCount?: number;
  /** Whether any image extends past the MediaBox (print bleed). */
  hasBleedingImage?: boolean;
  /** Whether on any page two different images have overlapping bboxes. */
  hasOverlappingImages?: boolean;
}

export interface FixtureGroundTruth {
  id: string;
  description: string;
  targetPhase: number;
  claims: FixtureClaims;
  /** Ground truth for the layout stage — deliberately not consumed now, only stored. */
  expected?: unknown;
}

export interface Fixture {
  id: string;
  build(): Buffer;
  groundTruth: FixtureGroundTruth;
}
