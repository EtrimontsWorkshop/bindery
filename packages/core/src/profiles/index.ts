export type { ProfileToken } from './types.js';
export {
  profileV2Schema,
  validateProfile,
  type ProfileV2,
  type PatternSet,
  type LabelledPairsPattern,
  type SectionListPattern,
  type FontRoleCandidatePattern,
  type ProseBlockPattern,
  type PatternDef,
  type ProfileValidationOk,
  type ProfileValidationFailed,
} from './schema.js';
export { matchLabelledPairs, matchSectionList, type LabelledPairMatchEntry, type LabelledPairsMatch, type SectionListItemMatch, type SectionListMatch } from './patterns.js';
export { countPlayerCharacterKeywordHits, classifyPageRoute, DEFAULT_PLAYER_CHARACTER_KEYWORDS, PLAYER_CHARACTER_KEYWORD_HIT_THRESHOLD, type PageRoute, type PageRouteOptions } from './pageRoute.js';
export { matchFontRoleCandidate, type FontRoleCandidateMatch } from './entityName.js';
export {
  attachAndMergeLabelledPairs,
  attachNearest,
  attachNearestWithDiagnostics,
  classifyRelativeDirection,
  directionalDistance,
  resolveEntityNames,
  type AttachCandidate,
  type AttachDiagnostics,
  type AttachStrategy,
  type GeometricAnchor,
  type MergedLabelledPairsAttachment,
  type NameCandidate,
  type NameResolution,
  type OutOfRangeCandidate,
  type PreferEarlierSiblingConfig,
  type RelativeDirection,
  type ResolveEntityNamesConfig,
} from './entityAssembly.js';
export { measureAttachGeometry, type AttachGeometryMeasurement } from './measureAttachGeometry.js';
export {
  inferLabelledPairsFromTokens,
  inferSectionListFromTokens,
  classifyValue,
  estimateTypicalRowGapPt,
  findValueCandidatesNearLabel,
  findTerminateTokenAtY,
  mergeTouchingTokens,
  splitMergedLabelValueTokens,
  stripStrayLeadingColonTokens,
  type LabelledPairConfidence,
  type LabelledPairSuggestion,
  type SectionListSuggestion,
  type SelectionToken,
  type IndexedSelectionToken,
  type ValueCandidate,
  type TerminateTokenCandidate,
} from './inferPatternFromSelection.js';
export { inferItemPatternFromExamples, collectRowText, type ItemShapeCode, type ItemPatternInference, type RowTextToken } from './inferItemPatternFromExamples.js';
export { findColumnBand, isWithinColumnBand, type ColumnBand, type ColumnBandToken } from './columnBand.js';
export {
  checkRelation,
  checkRelations,
  evaluateExpression,
  extractCanonicalValues,
  parseRelation,
  type EntityCanonicalValues,
  type ParsedRelation,
  type RelationCheckError,
  type RelationCheckOk,
  type RelationCheckResult,
  type RelationMismatch,
  type RelationOperator,
} from './mechanicalCheck.js';
export { assembleStatblocksOnPage, resolvePatternSetForRoute, toAttachCandidates, sectionListToAttachCandidates, type AssembledStatblock } from './assembleStatblocks.js';
export { findAttackDescriptionsBelow, findAttackDescriptionClaimedRanges, joinRejoiningLineBreakHyphens } from './attackDescriptionCrossReference.js';
export { matchProseBlock, lastClaimedTokenBbox, lastClaimedTokenIndex, type ProseBlockMatch, type MatchProseBlockOptions, type EntityClaimedExtent } from './proseBlock.js';
export {
  buildActorsForDocument,
  type PdfDocumentLike as ActorsPdfDocumentLike,
  type PdfPageLike as ActorsPdfPageLike,
  type BuildActorsForDocumentOptions,
  type BuildActorsForDocumentResult,
} from './buildActorsForDocument.js';
export { tokenizePage, type TokenizePagePdfPageLike, type TextContentItemLike } from './tokenizePage.js';
export {
  analyzeProfilePage,
  aggregateDocumentAnalysis,
  buildDiagnosticsExport,
  type AttachDiagnosticResult,
  type StudioRegionKind,
  type StudioRegion,
  type EntityAnalysis,
  type OverlapWarning,
  type NameCandidateStatus,
  type NameCandidateDiagnostic,
  type PatternMatchCount,
  type PageAnalysis,
  type DocumentPageSummary,
  type DocumentAnalysis,
  type DiagnosticsExport,
  type DiagnosticsExportPage,
  type DiagnosticsExportEntity,
  type DiagnosticsExportOverlap,
} from './studioAnalysis.js';
