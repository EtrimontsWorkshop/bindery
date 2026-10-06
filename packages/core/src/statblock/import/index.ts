export {
  type ExtractedValue,
  type ExtractedCollectionEntry,
  type ExtractedActorInstance,
  type BuiltItemData,
  type BuiltActorData,
  type DuplicatePolicy,
  type DuplicateAction,
  type ImportInstanceReport,
  type ImportReport,
  type ImportProgress,
} from './types.js';
export { setPath } from './setPath.js';
export { descriptorToConstraints, flattenLeafDescriptors } from './descriptorLookup.js';
export { resolveTransformChain } from './resolveTransformChain.js';
export { splitCollectionEntries } from './splitCollectionEntries.js';
export { extractStatblockInstance } from './extractInstance.js';
export { buildActorData, type SchemaContext, type BuildActorDataOptions, type BuildActorDataResult } from './buildActorData.js';
export { findNearestImage, type ImageCandidate } from './nearestImage.js';
export { resolveDuplicateAction } from './resolveDuplicateAction.js';
