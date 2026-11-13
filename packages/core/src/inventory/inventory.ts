import type { Rect } from '../geometry.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { buildFontKey, rankFontRoles, stripSubsetPrefix, type FontEntry, type FontRole } from './fontRegistry.js';
import { fingerprintDecodedImage, type ContentFingerprint } from './contentFingerprint.js';
import { buildImageEntries, type ImageEntry, type PageImageEvents } from './imageRegistry.js';
import { buildVectorLines, buildVectorRegions, buildVectorShapes, type VectorRegion, type VectorShape } from './vectorRegistry.js';
import { walkOperators } from './walkOperators.js';
import type { Diagnostic } from '../text/types.js';

/**
 * Orchestration of the inventory pass. Page by
 * page, sequentially — NEVER Promise.all across all pages (a performance
 * rule). Zero `render()`; `objs.get()` only for images pdf.js decodes for the operator list (waiting for them to arrive), to take
 * their content fingerprint (`collectFingerprints`).
 */

export interface InventoryResult {
  pageCount: number;
  fonts: FontEntry[];
  fontRoles: Map<string, FontRole>;
  images: ImageEntry[];
  vectors: VectorRegion[];
  /** Filled paths that are not rectangles (parts of drawings), per page; a page with more than `MAX_SHAPES_PER_PAGE` of them (text drawn as outlines) has none. */
  shapes: VectorShape[];
  /** Stroked paths that are not rectangles (the lines of drawings), per page; a page with more than `MAX_SHAPES_PER_PAGE` of them has none. */
  lines: VectorShape[];
  perPage: { pageNumber: number; box: Rect; rotation: number }[];
  /**
   * Boxes of the page's text as pdf.js shows it (one per text item: a word or a piece of a line), per page — before
   * the layout groups it into lines and blocks. Tells text that lies ON a picture from text that only wraps around it
   * (see `TEXT_WRAPS_AROUND_MAX_WORD_COVERAGE` in `classify.ts`). Only pages with images have an entry.
   */
  wordBoxesByPage: Map<number, TextItemBox[]>;
  /** What the inventory left out on purpose (a page with more vector shapes than it keeps), for the review's diagnostics. */
  diagnostics: Diagnostic[];
}

/** The box of a text item (see `textItemBox`), with the direction of its text and its length. */
export interface TextItemBox extends Rect {
  /** The direction the text runs in, in degrees counterclockwise from the page's x axis (0 = upright, 90 = running up the page). */
  angle: number;
  /** Number of characters, to weigh the item by. */
  chars: number;
}

/** Share of a text item's height below its baseline (the descenders); the rest is above it. */
const TEXT_ITEM_DESCENT = 0.25;

/** The box of a pdf.js text item: its run along the text direction, from a little below the baseline to the font's height above it; `null` for an item without size. */
export function textItemBox(transform: readonly number[], width: number, height: number): Rect | null {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = transform;
  const along = Math.hypot(a, b);
  const across = Math.hypot(c, d);
  if (!(width > 0) || !(height > 0) || along === 0 || across === 0) return null;
  const ux = a / along;
  const uy = b / along;
  const vx = c / across;
  const vy = d / across;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of [0, width]) {
    for (const t of [-TEXT_ITEM_DESCENT * height, (1 - TEXT_ITEM_DESCENT) * height]) {
      xs.push(e + s * ux + t * vx);
      ys.push(f + s * uy + t * vy);
    }
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** A page with more shapes than this is a page of text drawn as outlines or of a hatched pattern, not of illustrations: its shapes are not kept. */
const MAX_SHAPES_PER_PAGE = 20000;

export interface BuildInventoryOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called with every page's text items (what `getTextContent()` returned) and its font registry, right after the
   * inventory has read them. The inventory fetches a page's operator list and then its text, which is exactly what the
   * text layout needs: fed from here (`createTextLayoutCollector`), it does not have to open and walk the PDF again.
   */
  onPageText?: (pageNumber: number, items: readonly unknown[], commonObjs: PdfPageLike['commonObjs']) => void;
}

/**
 * Duck-typed subset of `PDFPageProxy` actually used here — lets us test the
 * orchestration without a real pdf.js document.
 */
export interface PdfPageLike {
  view: readonly number[];
  rotate: number;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { has(id: string): boolean; get(id: string, callback?: (data: unknown) => void): unknown };
  /** The page's decoded images, filled by `getOperatorList()` — read for content fingerprints only (optional, so fakes without it fall back to position). */
  objs?: { has(id: string): boolean; get(id: string, callback?: (data: unknown) => void): unknown };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

function viewToRect(view: readonly number[]): Rect {
  const [x0, y0, x1, y1] = view;
  return { minX: x0 ?? 0, minY: y0 ?? 0, maxX: x1 ?? 0, maxY: y1 ?? 0 };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('buildInventory aborted by AbortSignal', 'AbortError');
  }
}

interface FontAccumulator {
  baseFont: string;
  size: number;
  glyphCount: number;
  itemCount: number;
  pages: Set<number>;
}

/**
 * Images covering at least this share of the page are not fingerprinted in the pass over the pages: reading their decoded pixels there changed which
 * images pdf.js caches across pages, and so the ids of the images of later pages. The few that are needed are fingerprinted after that pass (see
 * `fingerprintPagePapers`).
 */
const FINGERPRINT_MAX_PAGE_AREA = 0.97;

/**
 * How long the inventory waits, per page, for the images of its operator list to arrive decoded. In a browser
 * pdf.js sends a page's decoded images to the main thread after `getOperatorList()` has resolved (as `VideoFrame`s or
 * bitmaps a moment later); read at once, none of them was there and no image of the browser had a fingerprint, so the
 * tiles of one picture were never joined across a seam (a cover cut into six tiles came as three pairs). Node too gets
 * them a moment late on a busy machine. The limit only guards against an image that never comes: with two seconds, a
 * book run beside two others lost a fingerprint, and with it a picture across a spread; the pages wait in the background
 * (see `MAX_PAGES_FINGERPRINTING`), so a long limit does not slow the inventory down.
 */
const FINGERPRINT_WAIT_MS = 10000;

/**
 * How many pages may wait for their images to be fingerprinted while the inventory goes on with the next ones. Waiting for each page in turn
 * made the inventory of a book of 36 pages in a browser take 43 s instead of 24 s: the images arrive while the worker reads the next page.
 */
const MAX_PAGES_FINGERPRINTING = 4;

type ObjStore = { has(id: string): boolean; get(id: string, callback?: (data: unknown) => void): unknown };

/** The decoded image `objId` of `store`, once pdf.js holds it, or `undefined` when it does not arrive by `deadline`. */
async function decodedImage(store: ObjStore, objId: string, deadline: number): Promise<unknown> {
  try {
    if (store.has(objId)) return store.get(objId);
  } catch {
    return undefined;
  }
  const wait = deadline - Date.now();
  if (wait <= 0) return undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), wait);
    try {
      store.get(objId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/**
 * Fingerprints the content of this page's images (see `contentFingerprint.ts`) while pdf.js still holds them decoded
 * — `page.cleanup()` drops them. Once per `objId`; an image that does not arrive decoded (see `FINGERPRINT_WAIT_MS`),
 * or is not readable, gets none.
 */
async function collectFingerprints(page: PdfPageLike, events: readonly ReturnType<typeof walkOperators>[number][], pageBox: Rect, into: Map<string, ContentFingerprint>): Promise<void> {
  const pageArea = Math.max(0, pageBox.maxX - pageBox.minX) * Math.max(0, pageBox.maxY - pageBox.minY);
  const deadline = Date.now() + FINGERPRINT_WAIT_MS;
  for (const event of events) {
    if (event.type !== 'image' || event.objId === null || into.has(event.objId)) continue;
    const area = Math.max(0, event.bbox.maxX - event.bbox.minX) * Math.max(0, event.bbox.maxY - event.bbox.minY);
    if (pageArea > 0 && area / pageArea >= FINGERPRINT_MAX_PAGE_AREA) continue;
    const store = event.objId.startsWith('g_') ? page.commonObjs : page.objs;
    if (!store) continue;
    const raw = await decodedImage(store, event.objId, deadline);
    if (raw === undefined || raw === null) continue;
    const fingerprint = fingerprintDecodedImage(raw);
    if (fingerprint) into.set(event.objId, fingerprint);
  }
}

/**
 * Fingerprints, after the pass over the pages, the page-filling images that may be the book's paper embedded once more: those of the
 * resolution of a page-filling image the book repeats on two pages or more, and that one too (see `FINGERPRINT_MAX_PAGE_AREA` for why not
 * during the pass). Each page is read again; the id of an image there is taken from its operator, whose index is the same.
 */
async function fingerprintPagePapers(doc: PdfDocumentLike, images: ImageEntry[], signal: AbortSignal | undefined): Promise<void> {
  const sizeKey = (e: ImageEntry): string => `${e.intrinsicWidth}x${e.intrinsicHeight}`;
  const fullPage = images.filter((e) => e.objId !== null && e.maxRelativeArea >= FINGERPRINT_MAX_PAGE_AREA && e.intrinsicWidth !== null && e.intrinsicHeight !== null && e.occurrences.length > 0);
  const repeatedSizes = new Set(fullPage.filter((e) => new Set(e.occurrences.map((o) => o.page)).size >= 2).map(sizeKey));
  const wanted = fullPage.filter((e) => e.contentFingerprint === undefined && repeatedSizes.has(sizeKey(e)));
  if (wanted.length < 2) return;
  const byPage = new Map<number, ImageEntry[]>();
  for (const e of wanted) {
    const page = e.occurrences[0]!.page;
    byPage.set(page, [...(byPage.get(page) ?? []), e]);
  }
  for (const [pageNumber, entries] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    checkAborted(signal);
    const page = await doc.getPage(pageNumber);
    try {
      const ops = await page.getOperatorList();
      const deadline = Date.now() + FINGERPRINT_WAIT_MS;
      for (const e of entries) {
        const index = e.occurrences[0]!.index;
        const args = index === undefined ? undefined : (ops.argsArray[index] as unknown[] | undefined);
        const id = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : e.objId!;
        const store = id.startsWith('g_') ? page.commonObjs : page.objs;
        if (!store) continue;
        const raw = await decodedImage(store, id, deadline);
        const fingerprint = raw === undefined || raw === null ? null : fingerprintDecodedImage(raw);
        if (fingerprint) e.contentFingerprint = fingerprint;
      }
    } finally {
      page.cleanup();
    }
  }
}

export async function buildInventory(
  doc: PdfDocumentLike,
  opts: BuildInventoryOptions = {},
): Promise<InventoryResult> {
  const { signal, onProgress, onPageText } = opts;
  const pageCount = doc.numPages;

  const perPage: { pageNumber: number; box: Rect; rotation: number }[] = [];
  const perPageImageEvents: PageImageEvents[] = [];
  const fingerprintByObjId = new Map<string, ContentFingerprint>();
  const wordBoxesByPage = new Map<number, TextItemBox[]>();
  const allVectors: VectorRegion[] = [];
  const allShapes: VectorShape[] = [];
  const allLines: VectorShape[] = [];
  const fontAccByKey = new Map<string, FontAccumulator>();
  const diagnostics: Diagnostic[] = [];

  // Pages whose images are still on their way to be fingerprinted (see `MAX_PAGES_FINGERPRINTING`): each is cleaned up once they are read.
  const fingerprinting: Promise<void>[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    checkAborted(signal);

    const page = await doc.getPage(pageNumber);
    let pageFingerprints: Promise<void> = Promise.resolve();
    try {
      const pageBox = viewToRect(page.view);
      perPage.push({ pageNumber, box: pageBox, rotation: page.rotate ?? 0 });

      // ONE pass over this page's operator list — images, vectors, groups.
      const ops = await page.getOperatorList();
      checkAborted(signal);
      const events = walkOperators(ops, pageBox);
      pageFingerprints = collectFingerprints(page, events, pageBox, fingerprintByObjId);

      perPageImageEvents.push({ page: pageNumber, pageBox, events });
      allVectors.push(...buildVectorRegions(events, pageNumber, pageBox));
      const pageShapes = buildVectorShapes(events, pageNumber, pageBox);
      if (pageShapes.length <= MAX_SHAPES_PER_PAGE) allShapes.push(...pageShapes);
      const pageLines = buildVectorLines(events, pageNumber, pageBox);
      if (pageLines.length <= MAX_SHAPES_PER_PAGE) allLines.push(...pageLines);
      // Said, not done in silence: drawings made of vector paths on this page (a diagram, a line drawing) are not looked for.
      const skipped = (pageShapes.length > MAX_SHAPES_PER_PAGE ? pageShapes.length : 0) + (pageLines.length > MAX_SHAPES_PER_PAGE ? pageLines.length : 0);
      if (skipped > 0) diagnostics.push({ severity: 'info', code: 'VECTOR_SHAPES_SKIPPED', params: { count: skipped, limit: MAX_SHAPES_PER_PAGE }, pageNumber });

      // Font fingerprinting: getTextContent() is a SEPARATE pdf.js call (not a
      // second pass over the operator list's fnArray) — needed for real
      // per-font glyph counts, which the operator list alone doesn't provide
      // in a form convenient to count without duplicating pdf.js's logic.
      // commonObjs is already populated thanks to getOperatorList() above (F0-Q1) —
      // no render required.
      const textContent = await page.getTextContent();
      checkAborted(signal);
      // Kept only for pages with images: the words are read against pictures, and a long book has hundreds of them per page.
      onPageText?.(pageNumber, textContent.items, page.commonObjs);
      const wordBoxes: TextItemBox[] | null = events.some((e) => e.type === 'image') ? [] : null;
      if (wordBoxes) wordBoxesByPage.set(pageNumber, wordBoxes);
      for (const item of textContent.items as Array<Record<string, unknown>>) {
        if (typeof item['str'] !== 'string' || item['str'].length === 0) continue;
        if (wordBoxes && item['str'].trim().length > 0 && Array.isArray(item['transform'])) {
          const transform = item['transform'] as number[];
          const box = textItemBox(transform, Number(item['width']), Number(item['height']));
          if (box) wordBoxes.push({ ...box, angle: (Math.atan2(transform[1] ?? 0, transform[0] ?? 1) * 180) / Math.PI, chars: item['str'].trim().length });
        }
        const fontName = item['fontName'] as string | undefined;
        if (!fontName || !page.commonObjs.has(fontName)) continue;
        const fontObj = page.commonObjs.get(fontName) as { name?: string } | undefined;
        const baseFont = fontObj?.name;
        if (!baseFont) continue;

        // MUST be EXACTLY the same formula as
        // `fontSizeFromTransform` (layout/textGeometry.ts, used by the entire
        // downstream text/layout layer to build `TextLine.dominantFont.key`) —
        // before this fix, this file computed size from transform[2]/[3] (the
        // Y axis), while `fontSizeFromTransform` computes it from
        // transform[0]/[1] (the X axis). For text with horizontal scaling
        // (`Tz`, condensed/expanded fonts) these two values DIFFER, so
        // `buildFontKey` produced a DIFFERENT key than the one that actually
        // ended up in `TextLine` — lines using such a font never found their
        // role in `fontRoles` (the key was missing from the registry), which
        // was measured as 284/369 `unknown` blocks on
        // a real rulebook, whose dominant key was
        // `BodyFont@7.5`, which was NOT in `inv.fonts` (the real
        // registry had `BodyFont@8` and `@8.5`, built with the same
        // formula as here now).
        const transform = item['transform'] as number[] | undefined;
        const size = transform ? fontSizeFromTransform(transform) : 0;
        const key = buildFontKey(baseFont, size);

        let acc = fontAccByKey.get(key);
        if (!acc) {
          acc = { baseFont, size: Math.round(size * 2) / 2, glyphCount: 0, itemCount: 0, pages: new Set() };
          fontAccByKey.set(key, acc);
        }
        acc.glyphCount += (item['str'] as string).length;
        acc.itemCount += 1;
        acc.pages.add(pageNumber);
      }
    } finally {
      // Measured in phase 0: saves 33% memory at zero time cost. Once the page's images are fingerprinted: cleaning up drops them.
      fingerprinting.push(pageFingerprints.catch(() => undefined).finally(() => page.cleanup()));
    }
    if (fingerprinting.length >= MAX_PAGES_FINGERPRINTING) await fingerprinting.shift();

    onProgress?.(pageNumber, pageCount);
  }

  await Promise.all(fingerprinting);
  const images = buildImageEntries(perPageImageEvents, fingerprintByObjId);
  await fingerprintPagePapers(doc, images, signal);

  const fonts: FontEntry[] = [...fontAccByKey.entries()]
    .map(([key, acc]) => {
      const { prefix } = stripSubsetPrefix(acc.baseFont);
      const entry: FontEntry = {
        key,
        baseFont: stripSubsetPrefix(acc.baseFont).name,
        subsetPrefix: prefix,
        size: acc.size,
        glyphCount: acc.glyphCount,
        itemCount: acc.itemCount,
        pages: acc.pages,
      };
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const fontRoles = rankFontRoles(fonts);

  // Determinism: order fixed by a stable key, not by Map/Set iteration order
  // (vectors sorted by page, then by bbox).
  allVectors.sort((a, b) => a.page - b.page || a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY);

  return {
    pageCount,
    fonts,
    fontRoles,
    images,
    vectors: allVectors,
    shapes: allShapes,
    lines: allLines,
    perPage,
    wordBoxesByPage,
    diagnostics,
  };
}
