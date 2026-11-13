import type { Rect } from '../geometry.js';
import type { ImageEntry } from '../inventory/imageRegistry.js';
import type { VectorRegion, VectorShape } from '../inventory/vectorRegistry.js';
import type { Diagnostic } from '../text/types.js';
import type { ImageClassification } from './classify.js';
import type { DirectedText } from './readingTurn.js';
import type { EncodedImage, OutputFormat } from './encodeImage.js';
import type { PdfPageForExtract } from './extract.js';
import type { FinalizedImage, PreparedEntryForFinalize } from './finalize.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * The shapes the image extraction passes around: its inputs, its options, its result, and the unit of work (one
 * picture to take from one page). Part of `buildImageExtraction.ts`, kept apart so the rules below can share them.
 */

export interface InventoryForImages {
  images: readonly ImageEntry[];
  vectors: readonly VectorRegion[];
  /** The filled paths that are not rectangles (see `VectorShape`); without them no vector drawing is looked for. */
  shapes?: readonly VectorShape[];
  /** The stroked paths that are not rectangles (the lines of drawings); without them no line drawing on the pictures is looked for (see `findLineDrawings`). */
  lines?: readonly VectorShape[];
  perPage: readonly { pageNumber: number; box: Rect; rotation: number }[];
}

export interface PdfDocumentLikeForImages {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageForExtract & { cleanup(): void }>;
}

export interface BuildImageExtractionOptions {
  /**
   * Used AS A STARTING POINT, NOT as the sole region-render resolution — see
   * `renderResolution.ts`. Still the only resolution for purely vector regions (no image, so the
   * "value from settings" applies).
   */
  targetLongEdgePx?: number;
  /** Hard ceiling on region-render resolution — guards against an absurd file size from a spread with very high native resource resolution. */
  maxLongEdgePx?: number;
  outputFormat?: OutputFormat;
  outputQuality?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** `objId` of images adjacent to a `statblock`/`heading` block — `portrait` signal. */
  nearStatblockOrHeadingObjIds?: ReadonlySet<string>;
  /** Bboxes of `body` blocks (text flow) per page — see `classify.ts`. Links the text flow to the image flow, EXPLICITLY via this parameter. */
  bodyBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /**
   * Bboxes of ALL text blocks (headings, sidebars and the rest, not only `body`/`caption`) per page. Used to
   * tell a picture that text lies ON (a paper note, a newspaper handout — the text is part of what the page
   * shows) from one that has text only beside it. Falls back to `bodyBlockBoxesByPage` when absent.
   */
  textBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /** Bboxes of the `heading` blocks per page: a plate whose only text is headings (a banner with the title of a chapter) is told from a box of text with them. */
  headingBlockBoxesByPage?: ReadonlyMap<number, readonly Rect[]>;
  /** Boxes of the words of the page's text per page (`groupWordBoxesByPage`): tell text that lies on a picture from text that only wraps around it. */
  wordBoxesByPage?: ReadonlyMap<number, readonly DirectedText[]>;
  /** Bypasses `Z1-full-bleed-background`/`Z9-high-body-text-coverage` for full-bleed images, treating them as content instead of background. Off by default. */
  treatFullBleedAsContent?: boolean;
  /** [at the user's request, EXPERIMENTAL] See `cropUniformMargins.ts`. No effect when `treatFullBleedAsContent` is off. Off by default. */
  autoCropUniformMargins?: boolean;
  /** [User request] Hide single-color and smooth-background images from the auto-detected list (see `UNIFORM_COLOR_MIN_FRACTION` and `SMOOTH_BACKGROUND_COARSE_MAX` in `finalize.ts`). On by default; only geometry-focused tests with flat-color stand-in images turn it off. */
  hideBackgroundImages?: boolean;
  /** [at the user's request] See `brightenImage.ts`. No effect when a given image wasn't actually cropped by `autoCropUniformMargins`. Off by default. */
  brightenAutoCroppedImages?: boolean;
  /**
   * How long, per page, to wait for resources that the planning of a unit needs (the picture and the
   * masks that cut it) to show up in `page.objs` after `getOperatorList()`. In a browser they arrive
   * asynchronously. The time is spent only while a needed resource is missing, and once a page's budget
   * is used up its remaining units do not wait again. Defaults to 1500 ms; 0 disables waiting. Only used when
   * the page's dependencies did not all arrive (see `waitForDependencies`): a wait measured on the clock makes
   * the result depend on how busy the machine is.
   */
  objectSettleTimeoutMs?: number;
  /**
   * Also look for drawings made of vector paths (a cartoon figure, a diagram, a logo) and offer them as undecided pictures (see `vectorFigures.ts`).
   * Needs the inventory's `shapes`. Off by default: without it only rasters and the big rectangular fills of maps are offered.
   */
  includeVectorFigures?: boolean;
  /**
   * Paint over the numbered markers of a map (black discs with a white number in them) in every extracted picture that has at least three of
   * them (see `numberMarkers.ts`). Off by default.
   */
  removeNumberMarkers?: boolean;
  /** Every image that has transparent pixels is put on a white background before it is encoded (see `flattenOnWhite`). Off by default. */
  whiteBackground?: boolean;
}

export interface BuildImageExtractionResult {
  images: FinalizedImage<EncodedImage>[];
  correlationClosedByBBox: number;
  correlationClosedByHash: number;
  duplicatesRemoved: number;
  diagnostics: Diagnostic[];
}

export interface ExtractionUnit {
  /** `null` = a purely vector region (a drawn map), no image to extract. */
  representativeEntry: ImageEntry | null;
  memberEntries: readonly ImageEntry[];
  page: number;
  bbox: Rect;
  clusterMemberCount: number;
  classification: ImageClassification;
  /** See `ClassifiedImage.confidence` — the cluster representative's confidence, possibly lowered when `undecided` is forced (see `IMAGE_CLUSTER_AREA_OVERREACH` below). */
  confidence: number;
  /** The representative's `reason` — used EXCLUSIVELY to detect `Z1-full-bleed-forced-content` (the decision to try `autoCropUniformMargins`), for nothing else. */
  reason: string;
  /** For a drawing of vector paths: the boxes of the shapes it is made of (see `vectorFigures.ts`). */
  shapeBoxes?: readonly Rect[];
}

/** The left half of a picture across a spread, kept until its right half is extracted on the next page. */
export interface PendingLeftHalf {
  item: PreparedEntryForFinalize<EncodedImage>;
  image: DecodedImage;
  page: number;
  isPanel: boolean;
  box: Rect;
  companion?: boolean;
  raw?: DecodedImage | null;
}

/** What changes as the pages of a document go by. One object, so that the stages working on a page share it. */
export interface RunTally {
  pendingLeftHalf: PendingLeftHalf | null;
  /** Props tossed over the page's edge found so far (see `BOOK_OF_PROPS_MIN_COUNT`). */
  tossedPropCount: number;
  /** Units done and units in all, for the progress callback; `total` grows when a unit is split. */
  done: number;
  total: number;
}

/** What changes while the units of ONE page are extracted. */
export interface PageState {
  /**
   * Time left on this page for waiting on resources that are not registered yet (see `objectSettleTimeoutMs`). Once every
   * dependency has arrived, a resource still missing is not one this page paints, and waiting for it would only lose time.
   */
  settleBudgetMs: number;
  /** Luminance spread of what the last extracted unit shows (only measured for `EDGE_FIGURE_REASON` units). */
  edgeFigureStdDev: number | undefined;
  /** The picture of the last extracted unit when it is a drawing on a big panel (a map): kept so that the two halves of a map across a spread can be joined. */
  lastPanelImage: DecodedImage | null;
  /** What a unit is judged against: the page's units without the sheets looked at once more at the page's edge. Set when the page's units are planned. */
  neighbourUnits: ExtractionUnit[];
}
