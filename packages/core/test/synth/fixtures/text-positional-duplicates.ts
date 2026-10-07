import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * An identical str+transform repeated 2x (an exact positional duplicate) and a duplicate shifted
 * by 0.3pt (a candidate for synthetic bold — syntheticBold). Tests deduplication.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 14);

  // Row 1: an exact duplicate — an identical str + an identical transform matrix.
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex(asciiCodes('Goblin'));
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex(asciiCodes('Goblin'));

  // Row 2: a duplicate shifted by 0.3pt — synthetic bold (double printing with a minimal shift, a common trick without a real bold).
  cs.setTextMatrix(1, 0, 0, 1, 72, 670);
  cs.showTextHex(asciiCodes('Orc'));
  cs.setTextMatrix(1, 0, 0, 1, 72.3, 670);
  cs.showTextHex(asciiCodes('Orc'));

  // Row 3: a control, unique text without a duplicate.
  cs.setTextMatrix(1, 0, 0, 1, 72, 640);
  cs.showTextHex(asciiCodes('Kobold'));

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
