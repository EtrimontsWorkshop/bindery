import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from './rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from './contentStream.js';
import { embedFont, asciiIdentityMap } from './fonts.js';

const FONT_PATH = join(import.meta.dirname, 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * Helper wspoldzielony przez fixture'y grupy C (KROK-6 Z7) — kazda linia na
 * WLASNYM Y (jeden Tj per linia, jak w grupie B) daje w pelni przewidywalna,
 * dokladnie kontrolowana geometrie: jeden TextItem = jedna linia, bez
 * fragmentacji i bez zaleznosci od progow scalania pdf.js.
 */
export interface TextLineSpec {
  text: string;
  x: number;
  y: number;
  size?: number;
}

export interface RectSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'fill' | 'stroke' | 'both' — domyslnie 'fill'. */
  mode?: 'fill' | 'stroke' | 'both';
}

export interface PageLayoutSpec {
  lines: TextLineSpec[];
  rects?: RectSpec[];
  mediaBox?: [number, number, number, number];
}

export function buildLayoutPage(spec: PageLayoutSpec): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const cs = new ContentStreamBuilder();
  for (const r of spec.rects ?? []) {
    cs.raw(`${r.x} ${r.y} ${r.w} ${r.h} re`);
    const mode = r.mode ?? 'fill';
    cs.raw(mode === 'both' ? 'B' : mode === 'stroke' ? 'S' : 'f');
  }

  cs.beginText();
  let lastSize: number | null = null;
  for (const line of spec.lines) {
    const size = line.size ?? 10;
    if (size !== lastSize) {
      cs.setFont('F1', size);
      lastSize = size;
    }
    cs.setTextMatrix(1, 0, 0, 1, line.x, line.y);
    cs.showTextHex(asciiCodes(line.text));
  }
  cs.endText();

  const contentRef = writer.addStreamObj('', cs.toBuffer());
  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: spec.mediaBox ?? [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/Font << /F1 ${fontRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

/** Buduje N stron z ta sama funkcja generujaca spec per numer strony (1-based) — dla fixture'ow wielostronicowych (np. layout-running-heads). */
export function buildMultiPageDocument(pageCount: number, specFor: (pageNumber: number) => PageLayoutSpec): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = Array.from({ length: pageCount }, () => writer.reserveObj());

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  for (let p = 0; p < pageCount; p++) {
    const spec = specFor(p + 1);
    const cs = new ContentStreamBuilder();
    for (const r of spec.rects ?? []) {
      cs.raw(`${r.x} ${r.y} ${r.w} ${r.h} re`);
      const mode = r.mode ?? 'fill';
      cs.raw(mode === 'both' ? 'B' : mode === 'stroke' ? 'S' : 'f');
    }
    cs.beginText();
    let lastSize: number | null = null;
    for (const line of spec.lines) {
      const size = line.size ?? 10;
      if (size !== lastSize) {
        cs.setFont('F1', size);
        lastSize = size;
      }
      cs.setTextMatrix(1, 0, 0, 1, line.x, line.y);
      cs.showTextHex(asciiCodes(line.text));
    }
    cs.endText();
    const contentRef = writer.addStreamObj('', cs.toBuffer());
    writer.writeObj(
      pageRefs[p]!,
      pageDict({
        parentRef: pagesRef,
        mediaBox: spec.mediaBox ?? [0, 0, 612, 792],
        contentsRef: contentRef,
        resourcesInner: `/Font << /F1 ${fontRef} 0 R >>`,
      }),
    );
  }

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}
