import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * ~90% itemow obroconych — skrajnosc z Q6 fazy 0 (do 94% na jednej ze stron
 * realnych PDF-ow). Testuje, ze kubelkowanie po kacie nie zaklada milczaco
 * wiekszosciowego strumienia 0°.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const mainLines = ['Title Page', 'Subtitle here'];
  const verticalLines = Array.from({ length: 18 }, (_, i) => `Vertical note ${i}`);

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 10);
  let y = 750;
  for (const line of mainLines) {
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(line));
    y -= 20;
  }
  let x = 40;
  for (const line of verticalLines) {
    cs.setTextMatrix(0, 1, -1, 0, x, 60);
    cs.showTextHex(asciiCodes(line));
    x += 30;
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
