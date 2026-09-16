import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * /ToUnicode mapujacy litery na Private Use Area (+) zamiast prawdziwych
 * znakow — symuluje uszkodzone ToUnicode czesto spotykane w realnych PDF-ach
 * (MDD §6.2, detektor jakosci). Testuje unicodeConfidence z src/quality.ts.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Kazda litera A-Z (0x41-0x5A) mapowana na PUA zamiast na siebie sama —
  // cale slowa napisane "poprawnym" kodem stana sie ciagiem znakow z E000+.
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
