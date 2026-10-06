export type { DetectionCandidate, DetectionProgress, DetectionRegion, PageForDetection } from './types.js';
export { buildStatblockReadingOrder, isSameColumn, type ColumnLocator, type ReadingOrderEntry } from './readingOrder.js';
export { lineMatchesAnchor, matchesTextPattern } from './matchAnchor.js';
export { findCandidateEnd } from './findCandidateEnd.js';
export { computeCandidateConfidence, type ConfidenceResult } from './computeCandidateConfidence.js';
export { detectStatblocks } from './detectStatblocks.js';
export { buildPagesForDetection, type BuildPagesForDetectionOptions } from './buildPagesForDetection.js';
