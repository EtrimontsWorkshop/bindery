import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');
const GAP = 30; // >= about 20pt at a 12pt font forces a synthetic space item (see below)

/**
 * Non-content items (str.length <= 1, here: a single space) interleaved with real text. Tests
 * filtering such items BEFORE computing statistics.
 *
 * IMPORTANT DISCOVERY: the original plan for this fixture assumed items with str EXACTLY "" (like
 * in real PDFs from the initial spike). It could not be built synthetically: pdf.js resolves every
 * character through `this.toUnicode.get(charcode) || charcode` (pdf.worker.mjs, Font#_charToGlyph)
 * — an empty string "" is falsy in JS, so a ToUnicode mapping to "" is ignored and pdf.js
 * silently falls back to the raw character code instead of an empty string. A completely empty Tj
 * operator (`<> Tj`) was also checked — pdf.js creates no item for it (neither an empty one nor any
 * other).
 *
 * Instead the fixture tests the CLOSEST realistically reachable equivalent: space items that
 * pdf.js ITSELF inserts between tokens with a large gap on the same line. It is the same
 * engineering requirement (filtering before the fragmentation statistics), a different exact str
 * value.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  const cs = new ContentStreamBuilder().beginText().setFont('F1', 12);
  let x = 72;
  const y = 700;
  for (const word of words) {
    cs.setTextMatrix(1, 0, 0, 1, x, y);
    cs.showTextHex(asciiCodes(word));
    x += word.length * 7 + GAP;
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
