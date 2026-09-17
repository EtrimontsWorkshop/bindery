import { unionRect } from '../geometry.js';
import type { Rect } from '../geometry.js';
import type { EncodedImage } from '../images/encodeImage.js';
import type { FinalizedImage } from '../images/finalize.js';
import type { SemanticBlock } from '../semantic/blockBuilder.js';
import type { Diagnostic } from '../text/types.js';
import { blocksToHtml, type EmbeddedImageForHtml } from './blocksToHtml.js';
import { assignHeadingLevels, buildJournalDrafts, headingsToMarkers, outlineToMarkers, type JournalPageDraft } from './buildJournalHierarchy.js';
import type { ResolvedOutlineNode } from './outline.js';
import type { CIFActor, CIFDocument, CIFImage, CIFJournal, CIFJournalPage, Provenance } from './types.js';

/**
 * CIF builder (Step 9 Z3/Z4/Z5): `SemanticBlock[]` of the whole document +
 * bookmarks (optional) + finalized images -> `CIFDocument`. Ties Z4
 * (journal hierarchy) and Z5 (blocks -> HTML) together into one pass,
 * mirroring the pattern of the project's other orchestrators
 * (`buildPageLayout.ts`, `buildImageExtraction.ts`).
 *
 * ALSO returns `imageBytesById` — the bytes of already-encoded images,
 * SEPARATELY from `CIFDocument` (which is pure data/JSON-serializable, MDD
 * §5.3). The Foundry layer (`packages/module`) uploads these bytes and
 * replaces `CIFImage.assetRef` (a placeholder here = its own `id`) with the
 * real path.
 */

export interface BuildCIFDocumentInput {
  fileName: string;
  fileHash: string;
  pageCount: number;
  detectedProfileId?: string | null;
  detectedLanguage?: string | null;
  /** Whole document, already page-ascending + reading order within a page (`buildPageLayouts`). */
  blocks: readonly SemanticBlock[];
  /** [] when the PDF has no bookmarks — the heading-based fallback (Z4b) kicks in automatically. */
  outline: readonly ResolvedOutlineNode[];
  /** [Step 11 Z4] `content` and `undecided` are embedded into the CIF (the review screen decides; `decoration`/`mask` are rejected here) — see `buildCIFImages`. */
  images: readonly FinalizedImage<EncodedImage>[];
  diagnostics: readonly Diagnostic[];
  /** [Step 20 Z2] Statblocks already built by `buildActorsForDocument` (called EARLIER by `buildCIFFromDocument`, when the profile is known) — empty/`undefined` when no profile was matched (degrade, don't fail — A7). */
  actors?: readonly CIFActor[];
}

export interface BuildCIFDocumentResult {
  document: CIFDocument;
  /** `CIFImage.id` -> already-encoded bytes (webp/png) + format — to be uploaded by the Foundry layer. */
  imageBytesById: Map<string, { bytes: Uint8Array; format: string }>;
}

function buildCIFImages(images: readonly FinalizedImage<EncodedImage>[]): { cifImages: CIFImage[]; imageBytesById: Map<string, { bytes: Uint8Array; format: string }> } {
  const cifImages: CIFImage[] = [];
  const imageBytesById = new Map<string, { bytes: Uint8Array; format: string }>();
  let autoIndex = 0;
  for (const img of images) {
    // [Step 11 Z4] `undecided` now ALSO enters the CIF (previously only
    // `content` did) — the review screen (phase 9) must show it to the
    // user, unchecked by default, instead of silently dropping it BEFORE
    // the review phase (see KROK-11-przeglad.md Z4). `decoration`/`mask`
    // are still rejected — those are already DECIDED negatives, there's
    // nothing to show for review.
    if (img.classification !== 'content' && img.classification !== 'undecided') continue;
    const occ = img.entry.occurrences[0];
    if (!occ) continue;
    const id = img.entry.objId ?? `cif-image-${autoIndex++}`;
    cifImages.push({
      id,
      targetKind: img.targetKind,
      width: img.width,
      height: img.height,
      format: img.payload.format,
      // Placeholder — the Foundry layer replaces it with the real path AFTER upload (see file header).
      assetRef: id,
      classification: img.classification,
      confidence: img.confidence,
      suggestedGrid: img.suggestedGrid,
      rawText: '',
      provenance: { pageNumber: occ.page, bbox: occ.bbox, blockIds: [] },
    });
    imageBytesById.set(id, { bytes: img.payload.bytes, format: img.payload.format });
  }
  return { cifImages, imageBytesById };
}

function buildJournalPage(page: JournalPageDraft, allImages: readonly EmbeddedImageForHtml[], journalIndex: number, pageIndex: number): CIFJournalPage {
  // A3: rawText covers ALL blocks of this page, INCLUDING header/footer
  // (skipped in `html`, but they NEVER disappear entirely).
  const rawText = page.blocks.map((b) => b.rawText).join('\n\n');
  const contentBlocks = page.blocks; // header/footer/marginalia handled INSIDE blocksToHtml
  // [Step 9, discovery] `blocksToHtml` appends images WITHOUT any block on
  // their page to the END of its result (A3 — so as not to lose them
  // entirely) — without this filter, EVERY journal page (each separate
  // call) received ALL images of the entire document (measured on
  // Wrath_&_Glory: 5/5 images on EACH of the 13 journal pages). Filtered
  // down to the physical PDF pages actually covered by THIS journal page —
  // one image lands on EXACTLY ONE page.
  const pagesCovered = new Set(page.blocks.map((b) => b.pageNumber));
  const images = allImages.filter((img) => pagesCovered.has(img.pageNumber));
  const { html, imageRefs } = blocksToHtml(contentBlocks, images);
  const first = page.blocks[0];
  const bbox = page.blocks.reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b.bbox) : b.bbox), null) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const provenance: Provenance = { pageNumber: first?.pageNumber ?? 1, bbox, blockIds: page.blocks.map((b) => b.id) };
  return {
    id: `journal${journalIndex}-page${pageIndex}`,
    name: page.title,
    headingLevel: page.headingLevel,
    html,
    imageRefs,
    rawText,
    provenance,
  };
}

export function buildCIFDocument(input: BuildCIFDocumentInput): BuildCIFDocumentResult {
  const levelByBlockId = assignHeadingLevels(input.blocks);
  const blocksWithLevels: SemanticBlock[] = input.blocks.map((b) =>
    b.kind === 'heading' ? { ...b, headingLevel: levelByBlockId.get(b.id) ?? 6 } : b,
  );

  const markers = input.outline.length > 0 ? outlineToMarkers(input.outline, blocksWithLevels) : headingsToMarkers(blocksWithLevels);
  const journalDrafts = buildJournalDrafts(blocksWithLevels, markers, input.fileName);

  const { cifImages, imageBytesById } = buildCIFImages(input.images);
  const imagesForHtml: EmbeddedImageForHtml[] = cifImages.map((img) => ({
    id: img.id,
    assetRef: img.assetRef,
    pageNumber: img.provenance.pageNumber,
    bbox: img.provenance.bbox,
  }));

  const journals: CIFJournal[] = journalDrafts.map((draft, journalIndex) => {
    const pages = draft.pages.map((page, pageIndex) => buildJournalPage(page, imagesForHtml, journalIndex, pageIndex));
    const rawText = pages.map((p) => p.rawText).join('\n\n');
    const blockIds = pages.flatMap((p) => p.provenance.blockIds);
    const provenance: Provenance = pages[0]?.provenance ?? { pageNumber: 1, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, blockIds: [] };
    return {
      id: `journal${journalIndex}`,
      name: draft.title,
      pages,
      rawText,
      provenance: { ...provenance, blockIds },
    };
  });

  const document: CIFDocument = {
    schemaVersion: 1,
    source: {
      fileName: input.fileName,
      fileHash: input.fileHash,
      pageCount: input.pageCount,
      detectedProfileId: input.detectedProfileId ?? null,
      detectedLanguage: input.detectedLanguage ?? null,
      extractedAt: new Date().toISOString(),
    },
    journals,
    scenes: [],
    images: cifImages,
    diagnostics: [...input.diagnostics],
    actors: input.actors && input.actors.length > 0 ? [...input.actors] : undefined,
  };

  return { document, imageBytesById };
}
