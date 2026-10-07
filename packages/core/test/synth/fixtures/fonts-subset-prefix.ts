import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');

// The PDF subsetting convention: 6 capital letters + "+" + the family name.
const BASE_FONT_NAMES = ['AAAAAH+Bookmania-Bold', 'BKQRXG+MinionPro-It', 'ZZZZZZ+QuadratSerial-PL'];

/**
 * Fonts with a subset prefix in /BaseFont — exactly the convention observed in an initial spike on
 * real PDFs. Tests that the layout engine must strip the first 6 characters + "+" when building
 * the font key, otherwise the same font used in two documents (with a different random prefix)
 * looks like two different fonts.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRefs = BASE_FONT_NAMES.map((name) =>
    embedFont(writer, { baseFont: name, ttfBytes, toUnicode: asciiIdentityMap() }),
  );

  const cs = new ContentStreamBuilder().beginText();
  let y = 700;
  for (let i = 0; i < BASE_FONT_NAMES.length; i++) {
    cs.setFont(`F${i}`, 18);
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(`Sample text ${i}`));
    y -= 30;
  }
  cs.endText();
  const contentRef = writer.addStreamObj('', cs.toBuffer());

  const fontEntries = fontRefs.map((r, i) => `/F${i} ${r} 0 R`).join(' ');

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/Font << ${fontEntries} >>`,
    }),
  );

  return writer.finish(catalogRef);
}
