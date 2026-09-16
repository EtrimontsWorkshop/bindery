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
 * Builder CIF (KROK-9 Z3/Z4/Z5): `SemanticBlock[]` calego dokumentu + zakladki
 * (opcjonalne) + sfinalizowane obrazy -> `CIFDocument`. Spina Z4 (hierarchia
 * journali) i Z5 (bloki -> HTML) w jeden przebieg, mirror wzorca innych
 * orkiestratorow tego projektu (`buildPageLayout.ts`, `buildImageExtraction.ts`).
 *
 * Zwraca ROWNIEZ `imageBytesById` — bajty juz zakodowanych obrazow OSOBNO od
 * `CIFDocument` (ktory jest czysto danymi/JSON-serializowalny, MDD §5.3).
 * Warstwa Foundry (`packages/module`) wgrywa te bajty i podmienia
 * `CIFImage.assetRef` (tutaj placeholder = wlasne `id`) na prawdziwa sciezke.
 */

export interface BuildCIFDocumentInput {
  fileName: string;
  fileHash: string;
  pageCount: number;
  detectedProfileId?: string | null;
  detectedLanguage?: string | null;
  /** Whole document, juz strona-rosnaco + kolejnosc czytania wewnatrz strony (`buildPageLayouts`). */
  blocks: readonly SemanticBlock[];
  /** [] gdy PDF nie ma zakladek — fallback po naglowkach (Z4b) wlacza sie automatycznie. */
  outline: readonly ResolvedOutlineNode[];
  /** [KROK-11 Z4] `content` i `undecided` sa embedowane do CIF (ekran przegladu decyduje, `decoration`/`mask` odrzucone tutaj) — patrz `buildCIFImages`. */
  images: readonly FinalizedImage<EncodedImage>[];
  diagnostics: readonly Diagnostic[];
  /** [KROK-20 Z2] Statbloki juz zbudowane przez `buildActorsForDocument` (wolane WCZESNIEJ przez `buildCIFFromDocument`, gdy profil jest znany) — puste/`undefined`, gdy zaden profil nie zostal dopasowany (degraduj, nie failuj — A7). */
  actors?: readonly CIFActor[];
}

export interface BuildCIFDocumentResult {
  document: CIFDocument;
  /** `CIFImage.id` -> bajty juz zakodowane (webp/png) + format — do wgrania przez warstwe Foundry. */
  imageBytesById: Map<string, { bytes: Uint8Array; format: string }>;
}

function buildCIFImages(images: readonly FinalizedImage<EncodedImage>[]): { cifImages: CIFImage[]; imageBytesById: Map<string, { bytes: Uint8Array; format: string }> } {
  const cifImages: CIFImage[] = [];
  const imageBytesById = new Map<string, { bytes: Uint8Array; format: string }>();
  let autoIndex = 0;
  for (const img of images) {
    // [KROK-11 Z4] `undecided` teraz TEZ wchodzi do CIF (wczesniej tylko
    // `content`) — ekran przegladu (faza 9) musi je pokazac uzytkownikowi,
    // domyslnie odznaczone, zamiast cicho je gubic PRZED faza przegladu (patrz
    // KROK-11-przeglad.md Z4). `decoration`/`mask` nadal odrzucane — to sa juz
    // ZDECYDOWANE negatywy, nie ma czego pokazywac do przegladu.
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
      // Placeholder — warstwa Foundry podmienia na prawdziwa sciezke PO wgraniu (patrz naglowek pliku).
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
  // A3: rawText obejmuje WSZYSTKIE bloki tej strony, WLACZNIE z header/footer
  // (pomijane w `html`, ale NIGDY nie znikaja calkowicie).
  const rawText = page.blocks.map((b) => b.rawText).join('\n\n');
  const contentBlocks = page.blocks; // header/footer/marginalia obsluzone WEWNATRZ blocksToHtml
  // [KROK-9, odkrycie] `blocksToHtml` dokleja obrazy BEZ zadnego bloku na ich
  // stronie na KONIEC swojego wyniku (A3 — zeby nie zgubic ich calkowicie) —
  // bez tego filtra KAZDA strona journala (kazde osobne wywolanie) dostawala
  // WSZYSTKIE obrazy calego dokumentu (zmierzone na Wrath_&_Glory: 5/5 obrazow
  // na KAZDEJ z 13 stron journali). Filtr do fizycznych stron PDF-a faktycznie
  // objetych TA strona journala — jeden obraz trafia do DOKLADNIE JEDNEJ strony.
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
