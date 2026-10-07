import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * A /ToUnicode mapping letters to the Private Use Area (+) instead of real characters — simulates
 * the broken ToUnicode often found in real PDFs (the text-layer quality detector). Tests
 * unicodeConfidence from src/quality.ts.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Every letter A-Z (0x41-0x5A) mapped to the PUA instead of itself — whole words written in
  // "correct" code become a sequence of characters from E000+.
  const toUnicode = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) toUnicode.set(c, String.fromCharCode(c));
  for (let c = 0x41; c <= 0x5a; c++) toUnicode.set(c, String.fromCharCode(0xe000 + (c - 0x41)));
  for (let c = 0x61; c <= 0x7a; c++) toUnicode.set(c, String.fromCharCode(0xe020 + (c - 0x61)));

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 12);
  const lines = ['Broken Encoding Sample', 'Every Letter Maps To PUA', 'Quality Detector Must Flag This'];
  let y = 700;
  for (const line of lines) {
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(line));
    y -= 20;
  }
  cs.endText();
  const contentRef = writer.addStreamObj('', cs.toBuffer());

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/Font << /F1 ${fontRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}
