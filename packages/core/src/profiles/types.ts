import type { Rect } from '../geometry.js';
import type { FontRole } from '../inventory/fontRegistry.js';

/**
 * [Step 18 Z2] Input token of the pattern engine — DELIBERATELY flat and independent of
 * `MergedToken`/`LineToken`/`TextLine` (layout/*, semantic/*). MDD §5.5:
 * the engine operates on "the raw pdf.js token stream plus geometry from
 * inventory" — NEVER on `SemanticBlock[]` (step 12 showed that
 * `buildSemanticBlocks` breaks a statblock into 20-30 fragments and merges data
 * from different entities, S1). The caller builds `ProfileToken[]` from any source
 * (raw `TextItem`, `MergedToken` after hygiene/word-merging) — the engine does not
 * assume WHICH pipeline stage supplied them, only that they are ordered in the
 * sequence of the PDF's text stream (not reading order — S3: entities
 * appear in batches, geometric pairing happens separately, outside this file).
 */
export interface ProfileToken {
  text: string;
  bbox: Rect;
  /** [Step 18 Z3] Font role from inventory (`buildInventory().fontRoles`) — input to `fontRoleCandidate` (candidates for entity name). Optional: `labelledPairs`/`sectionList` (Z2) don't need it. */
  fontRole?: FontRole;
  /** [Step 29 Z3] Carrier font key (`buildFontKey` — BaseFont with the subset prefix stripped + size), INDEPENDENT of `fontRole` (which is a ranking of FREQUENCY/size per document, not an identifier of a specific typeface). Input to `fontRoleCandidate.requireFontKeys` — clicking a name candidate in Profile Studio learns THIS key, narrowing the fatal imprecision of the font role alone (step 12's H2: 2401 candidates for 15 entities) down to the typeface actually in use. Optional for the same reason as `fontRole`. */
  fontKey?: string;
  /** [Step 18 Z3] Page number of the token — needed by `excludeRepeatedAcrossPages` (H2: headers/footers repeating identical text across multiple pages are NOT name candidates). Optional for the same reason as `fontRole`. */
  page?: number;
}
