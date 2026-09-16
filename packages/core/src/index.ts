export type { LocalizableMessage } from './localizableMessage.js';
export { inspectDocument } from './inspect.js';
export type { DocumentSummary, InspectOptions } from './inspect.js';
export { extractImagesFromDocument } from './extractImagesFromDocument.js';
export type { ExtractImagesFromDocumentOptions } from './extractImagesFromDocument.js';
export { buildCIFFromDocument } from './buildCIFFromDocument.js';
export type { BuildCIFFromDocumentOptions } from './buildCIFFromDocument.js';
export { analyzeProfileDocument, getFontRoleAwareTokensForPage } from './analyzeProfileDocument.js';
export type { AnalyzeProfileDocumentOptions, GetFontRoleAwareTokensOptions } from './analyzeProfileDocument.js';
export { measureAttachGeometryForDocument } from './measureAttachGeometryForDocument.js';
export type { MeasureAttachGeometryForDocumentOptions } from './measureAttachGeometryForDocument.js';
export { getPageTextTokens } from './getPageTextTokens.js';
export type { PageTextToken, GetPageTextTokensOptions } from './getPageTextTokens.js';
export { CANONICAL_STATS, CANONICAL_STAT_KEYS } from './canon/statKeys.js';
export type { CanonicalStatDefinition, CanonicalStatKey } from './canon/statKeys.js';
export {
  classifyQuality,
  computeUnicodeConfidence,
  emptySignals,
  mergeSignals,
  pickSamplePages,
  tallySignals,
} from './quality.js';
export type { QualitySignals, QualityVerdict } from './quality.js';
export { normalizeDecodedImage } from './images/normalizeDecodedImage.js';
export type { DecodedImage } from './images/normalizeDecodedImage.js';
export { classifyImages, confidenceForReason } from './images/classify.js';
export type { ClassifiedImage, ImageClassification } from './images/classify.js';
export { computeClusterMemberCounts, computeMaskedObjIds, decideExtractionStrategy } from './images/strategy.js';
export type { ExtractionStrategy, StrategyDecision, StrategyInput } from './images/strategy.js';
export { browserRegionRenderer, computeRenderPlan, renderRegionShared, transformPoint, MAX_OUTPUT_EDGE_PX } from './images/regionRenderer.js';
export type { CanvasContextLike, PdfPageForRender, RegionRenderer, RenderPlan, RenderRegionOptions } from './images/regionRenderer.js';
export { rotateAndCropImage } from './images/rotateCrop.js';
export type { RotateAndCropOptions } from './images/rotateCrop.js';
export { featherAlpha } from './images/featherAlpha.js';
export { removeBackground, DEFAULT_REMOVE_BACKGROUND } from './images/removeBackground.js';
export type { RemoveBackgroundOptions, RemoveBackgroundResult } from './images/removeBackground.js';
export { isInsideShape, applyTokenMask } from './images/tokenMask.js';
export type { TokenMaskShape } from './images/tokenMask.js';
export { applyBuiltInFrame, compositeCustomFrame } from './images/tokenFrame.js';
export type { BuiltInFrameOptions } from './images/tokenFrame.js';
export { sharpenImage, DEFAULT_SHARPEN } from './images/sharpenImage.js';
export type { SharpenOptions } from './images/sharpenImage.js';
export { renderRotatedRegion } from './images/renderRotatedRegion.js';
export type { RotatedPdfRegion } from './images/renderRotatedRegion.js';
export { renderPagePreview } from './images/buildPagePreview.js';
export type { RenderPagePreviewOptions } from './images/buildPagePreview.js';
export { openPreviewDocument } from './openPreviewDocument.js';
export type { OpenPreviewDocumentOptions, PreviewDocument, PreviewPageHandle, RegionCrop } from './openPreviewDocument.js';
export { extractDirect } from './images/extract.js';
export type { ExtractDirectResult, ExtractSource, PdfObjectsLike, PdfPageForExtract } from './images/extract.js';
export { classifyTargetKind, closeCorrelationByHash, computeContentHash, finalizeImages } from './images/finalize.js';
export type {
  CorrelationClosureResult,
  FinalizedImage,
  FinalizeResult,
  ImageTargetKind,
  PreparedEntryForFinalize,
  TargetKindInput,
} from './images/finalize.js';
export { browserImageEncoder, DEFAULT_OUTPUT_FORMAT, DEFAULT_WEBP_QUALITY } from './images/encodeImage.js';
export type { EncodedImage, EncodeOptions, ImageEncoder, OutputFormat } from './images/encodeImage.js';
export { buildImageExtraction } from './images/buildImageExtraction.js';
export type {
  BuildImageExtractionOptions,
  BuildImageExtractionResult,
  InventoryForImages,
  PdfDocumentLikeForImages,
} from './images/buildImageExtraction.js';
export { inscribedRotatedRectScale } from './geometry.js';
export type { Matrix, Rect } from './geometry.js';
export { pdfPointToScreen, pdfRectToScreen, screenPointToPdf, screenRectToPdf, screenRotatedRectToPdf, rotatedRectBounds } from './pageOverlayGeometry.js';
export type { PageRotation, RenderedPageGeometry, RotatedRect } from './pageOverlayGeometry.js';
export { groupByQuantizedPosition } from './collections.js';
export * from './inventory/index.js';
export * from './text/index.js';
export * from './layout/index.js';
export * from './semantic/index.js';
export * from './cif/index.js';
export * from './profiles/index.js';
export * from './referenceInvariants.js';
