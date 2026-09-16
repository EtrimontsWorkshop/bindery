export { HANDLED_OPCODES, walkOperators } from './walkOperators.js';
export type { WalkEvent, GroupContext, OperatorListLike } from './walkOperators.js';

export { buildFontKey, parseDisplaySuffix, rankFontRoles, resolveFontKey, stripSubsetPrefix } from './fontRegistry.js';
export type { FontEntry, FontRole } from './fontRegistry.js';

export { buildImageEntries, correlateImagesByBBox } from './imageRegistry.js';
export type { ImageEntry, ImageOccurrence, MaskEvidence, PageImageEvents } from './imageRegistry.js';

export { buildVectorRegions } from './vectorRegistry.js';
export type { VectorRegion } from './vectorRegistry.js';

export { buildInventory } from './inventory.js';
export type { BuildInventoryOptions, InventoryResult, PdfDocumentLike, PdfPageLike } from './inventory.js';
