import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const WHOLE_WORDS = ['the', 'and', 'run', 'big', 'red', 'sky', 'day', 'old', 'new', 'sun'];
const FRAGMENTED_CHARS = 'dogcatbathatjampotsittopwetzip'.split(''); // 30 characters

/**
 * ~75% of items shorter than 3 characters — the upper end of the range from the initial spike
 * (20-76%). Every token gets its OWN row (a separate Y) — pdf.js inserts synthetic space items
 * ONLY between tokens on the same line; one token per row gives a fully predictable, precisely
 * controlled number of items.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 10);
  let y = 780;
  const allTokens = [...WHOLE_WORDS, ...FRAGMENTED_CHARS];
  for (const token of allTokens) {
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(token));
    y -= 12;
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
