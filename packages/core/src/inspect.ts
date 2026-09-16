import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { classifyQuality, mergeSignals, pickSamplePages, tallySignals } from './quality.js';

export interface DocumentSummary {
  pageCount: number;
  title: string | null;
  producer: string | null;
  hasOutline: boolean;
  quality: {
    hasTextLayer: boolean;
    unicodeConfidence: number;
    suspectedScan: boolean;
  };
}

export interface InspectOptions {
  /**
   * Katalog bazowy assetów pdf.js, z koncowym ukosnikiem.
   * W Foundry: 'modules/bindery/lib/'. W testach Node: sciezka do node_modules/pdfjs-dist.
   */
  assetBaseUrl: string;
}

/**
 * Jedyna prawdziwa funkcja fazy 1 (walking skeleton).
 * Otwiera dokument, pobiera metadane/outline, i liczy ocene jakosci warstwy
 * tekstowej na probce stron (metodyka ze spike'u fazy 0, patrz quality.ts).
 *
 * Rzuca PDFException/PasswordException z pdf.js bez lapania — R4 wymaga
 * czytelnego komunikatu przy PDF zaszyfrowanym, ale to odpowiedzialnosc
 * warstwy UI (packages/module), nie core. Core nigdy nie ukrywa bledow po cichu.
 */
export async function inspectDocument(
  data: ArrayBuffer,
  opts: InspectOptions,
): Promise<DocumentSummary> {
  // Konfiguracja pdf.js (nie Foundry) — jeden punkt prawdy, dziala tak samo
  // w Node (testy) jak w przegladarce (ryzyko I1). W Node pdf.js uzywa fake
  // workera automatycznie, wiec ta linia jest no-opem poza przegladarka.
  pdfjs.GlobalWorkerOptions.workerSrc = `${opts.assetBaseUrl}pdf.worker.mjs`;

  // `data.slice(0)` — kopia NIEZALEZNA od `data`, NIE widok nad nim (KROK-8,
  // odkrycie: w prawdziwej przegladarce pdf.js TRANSFERUJE bufor do watku
  // Workera przy `getDocument()`, co ODLACZA oryginalny ArrayBuffer w watku
  // glownym). Bez tej kopii wolajacy (np. `ImportWizard`, ktory trzyma jeden
  // `ArrayBuffer` per wybrany plik) nie moglby ponownie uzyc tego samego
  // bufora do INNEGO wywolania (np. `extractImagesFromDocument` po
  // `inspectDocument` na tym samym pliku) — druga proba rzucalaby
  // `TypeError: Cannot perform Construct on a detached ArrayBuffer`.
  // Patrz pelny opis w `extractImagesFromDocument.ts`.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    wasmUrl: `${opts.assetBaseUrl}wasm/`,
    standardFontDataUrl: `${opts.assetBaseUrl}standard_fonts/`,
  }).promise;

  const pageCount = doc.numPages;

  let title: string | null = null;
  let producer: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, unknown> | undefined;
    title = typeof info?.['Title'] === 'string' && info['Title'] ? (info['Title'] as string) : null;
    producer =
      typeof info?.['Producer'] === 'string' && info['Producer'] ? (info['Producer'] as string) : null;
  } catch {
    // metadane opcjonalne — brak nie jest bledem krytycznym
  }

  let hasOutline = false;
  try {
    const outline = await doc.getOutline();
    hasOutline = Array.isArray(outline) && outline.length > 0;
  } catch {
    // outline opcjonalny
  }

  const samplePages = pickSamplePages(pageCount);
  const perPageSignals = [];
  let glyphCount = 0;

  for (const pageNum of samplePages) {
    const page = await doc.getPage(pageNum);
    try {
      const textContent = await page.getTextContent();
      let pageText = '';
      for (const item of textContent.items) {
        if ('str' in item) pageText += item.str;
      }
      glyphCount += pageText.length;
      perPageSignals.push(tallySignals(pageText));
    } finally {
      page.cleanup();
    }
  }

  const quality = classifyQuality(glyphCount, mergeSignals(perPageSignals));

  return {
    pageCount,
    title,
    producer,
    hasOutline,
    quality,
  };
}
