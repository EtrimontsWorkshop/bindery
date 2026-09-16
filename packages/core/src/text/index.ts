export type { CleanItem, Diagnostic, FontFingerprint, HygieneMetrics, HygieneResult, PdfTextItemLike, StreamAngle, WordBoundary } from './types.js';
export { hasBoundaryBetween, runHygiene } from './hygiene.js';
export {
  buildFontGapProfiles,
  buildHierarchicalGapProfiles,
  collectGapSamples,
  computeReliableGlyphCoverage,
  effectiveGapProfileForPage,
} from './gapStatistics.js';
export type { FontGapProfile, GapAwareItem, GapSample, HierarchicalGapProfile } from './gapStatistics.js';
export { buildTextLayout } from './buildTextLayout.js';
export type {
  BuildTextLayoutOptions,
  BuildTextLayoutResult,
  PageTextResult,
  PdfDocumentLike as TextPdfDocumentLike,
  PdfPageLike as TextPdfPageLike,
  TextStream,
} from './buildTextLayout.js';
