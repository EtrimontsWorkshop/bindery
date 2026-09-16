import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tallySignals, mergeSignals, computeUnicodeConfidence, type QualitySignals } from '../../src/quality.js';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ComputedMetrics {
  pageCount: number;
  fragmentationRatio: number;
  rotatedItemRatio: number;
  emptyItemCount: number;
  /** Itemy niepuste, ale zlozone wylacznie z bialych znakow (np. pojedyncza spacja). */
  whitespaceOnlyItemCount: number;
  totalItemCount: number;
  nonEmptyItemCount: number;
  imageCount: number;
  imageCountPerPage: number[];
  signals: QualitySignals;
  unicodeConfidence: number;
  distinctFontKeys: string[];
  hasLuminosityGroup: boolean;
  zeroGlyphPageCount: number;
  /** Czy jakikolwiek obraz na jakiejkolwiek stronie wychodzi poza MediaBox (spad drukarski). */
  hasBleedingImage: boolean;
  /** Czy na jakiejkolwiek stronie dwa RoZNE obrazy maja pokrywajace sie bboxy. */
  hasOverlappingImages: boolean;
  /** Pary itemow o identycznym str I identycznej macierzy transform (dokladny duplikat pozycyjny). */
  exactPositionalDuplicateCount: number;
  /** Pary itemow o identycznym str i macierzy przesunietej o < 1pt (kandydat na syntetyczne pogrubienie). */
  nearPositionalDuplicateCount: number;
}

const IMAGE_OPS = new Set<number>();

function initImageOps(pdfjsMod: typeof pdfjs) {
  IMAGE_OPS.add(pdfjsMod.OPS.paintImageXObject);
  IMAGE_OPS.add(pdfjsMod.OPS.paintImageXObjectRepeat);
  IMAGE_OPS.add(pdfjsMod.OPS.paintInlineImageXObject);
  // Dodane w KROK-4: maski stencilowe TEZ sa operacjami obrazowymi — pominiete
  // przypadkiem w kroku 3, ujawnione przez fixture images-mask-opcode.
  IMAGE_OPS.add(pdfjsMod.OPS.paintImageMaskXObject);
}

/**
 * Sledzi CTM (save/restore/transform) i liczy bbox obrazu jednostkowego przez CTM —
 * dokladnie metodyka z fazy 0 (spike probe-images.ts). Narzedzie WYLACZNIE do
 * samokontroli fixture'ow w tym pliku, NIE produkcyjna logika fazy 2/3.
 */
function computeImageBBoxes(fnArray: number[], argsArray: unknown[][], OPS: any, Util: any): Rect[] {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const bboxes: Rect[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    if (op === OPS.save) {
      stack.push([...ctm]);
    } else if (op === OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (op === OPS.transform) {
      ctm = Util.transform(ctm, argsArray[i]);
    } else if (IMAGE_OPS.has(op)) {
      const pts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => [ctm[0]! * x! + ctm[2]! * y! + ctm[4]!, ctm[1]! * x! + ctm[3]! * y! + ctm[5]!]);
      const xs = pts.map((p) => p[0]!);
      const ys = pts.map((p) => p[1]!);
      bboxes.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
    }
  }
  return bboxes;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/**
 * Przechodzi caly dokument i liczy metryki uzywane przez warstwe 1 (claims).
 * Uzywa disableNormalization:true — dokladnie jak w metodyce fazy 0 — zeby
 * ligatury/znaki laczace/PUA byly widoczne w surowej formie, nie ukryte przez
 * domyslna normalizacje pdf.js.
 */
export async function computeMetrics(pdfData: Buffer | Uint8Array): Promise<ComputedMetrics> {
  initImageOps(pdfjs);

  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfData) }).promise;
  const pageCount = doc.numPages;

  let totalItems = 0;
  let nonEmptyItems = 0;
  let fragmentedItems = 0;
  let rotatedItems = 0;
  let emptyItemCount = 0;
  let imageCount = 0;
  const imageCountPerPage: number[] = [];
  let hasLuminosityGroup = false;
  let zeroGlyphPageCount = 0;
  let hasBleedingImage = false;
  let hasOverlappingImages = false;
  let exactPositionalDuplicateCount = 0;
  let nearPositionalDuplicateCount = 0;
  let whitespaceOnlyItemCount = 0;
  const fontKeys = new Set<string>();
  const perPageSignals: QualitySignals[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);

    const tc = await page.getTextContent({ disableNormalization: true } as any);
    let pageGlyphCount = 0;
    const fontNamesOnPage = new Set<string>();
    for (const item of tc.items as any[]) {
      if (!('str' in item)) continue;
      totalItems++;
      const t = item.transform as number[];
      const rotated = t[1] !== 0 || t[2] !== 0;
      if (rotated) rotatedItems++;
      if (item.str.length === 0) {
        emptyItemCount++;
      } else {
        nonEmptyItems++;
        pageGlyphCount += item.str.length;
        if (item.str.length < 3) fragmentedItems++;
        if (item.str.trim().length === 0) whitespaceOnlyItemCount++;
      }
      if (item.fontName) fontNamesOnPage.add(item.fontName);
    }
    if (pageGlyphCount === 0) zeroGlyphPageCount++;

    const textItems = (tc.items as any[]).filter((i) => 'str' in i && i.str.length > 0);
    for (let i = 0; i < textItems.length; i++) {
      for (let j = i + 1; j < textItems.length; j++) {
        const a = textItems[i]!;
        const b = textItems[j]!;
        if (a.str !== b.str) continue;
        const dx = Math.abs(a.transform[4] - b.transform[4]);
        const dy = Math.abs(a.transform[5] - b.transform[5]);
        const sameScale = a.transform[0] === b.transform[0] && a.transform[3] === b.transform[3];
        if (!sameScale) continue;
        if (dx === 0 && dy === 0) {
          exactPositionalDuplicateCount++;
        } else if (dx < 1 && dy < 1) {
          nearPositionalDuplicateCount++;
        }
      }
    }

    const pageText = (tc.items as any[])
      .filter((i) => 'str' in i)
      .map((i) => i.str)
      .join('');
    perPageSignals.push(tallySignals(pageText));

    const { fnArray, argsArray } = await page.getOperatorList();
    const OPS = pdfjs.OPS as any;
    let pageImageCount = 0;
    for (let i = 0; i < fnArray.length; i++) {
      if (IMAGE_OPS.has(fnArray[i])) {
        imageCount++;
        pageImageCount++;
      }
      if (fnArray[i] === OPS.beginGroup) {
        const groupArgs = argsArray[i]?.[0];
        if (groupArgs?.smask?.subtype === 'Luminosity') hasLuminosityGroup = true;
      }
    }
    imageCountPerPage.push(pageImageCount);

    const bboxes = computeImageBBoxes(fnArray, argsArray, OPS, (pdfjs as any).Util);
    const [mbX0, mbY0, mbX1, mbY1] = page.view as [number, number, number, number];
    for (const b of bboxes) {
      if (b.minX < mbX0 || b.minY < mbY0 || b.maxX > mbX1 || b.maxY > mbY1) hasBleedingImage = true;
    }
    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        if (rectsOverlap(bboxes[i]!, bboxes[j]!)) hasOverlappingImages = true;
      }
    }

    for (const fontName of fontNamesOnPage) {
      if (page.commonObjs.has(fontName)) {
        const font: any = page.commonObjs.get(fontName);
        if (font?.name) fontKeys.add(font.name);
      }
    }

    page.cleanup();
  }

  const signals = mergeSignals(perPageSignals);
  return {
    pageCount,
    fragmentationRatio: nonEmptyItems > 0 ? fragmentedItems / nonEmptyItems : 0,
    rotatedItemRatio: totalItems > 0 ? rotatedItems / totalItems : 0,
    emptyItemCount,
    whitespaceOnlyItemCount,
    totalItemCount: totalItems,
    nonEmptyItemCount: nonEmptyItems,
    imageCount,
    imageCountPerPage,
    signals,
    unicodeConfidence: computeUnicodeConfidence(signals),
    distinctFontKeys: [...fontKeys].sort(),
    hasLuminosityGroup,
    zeroGlyphPageCount,
    hasBleedingImage,
    hasOverlappingImages,
    exactPositionalDuplicateCount,
    nearPositionalDuplicateCount,
  };
}
