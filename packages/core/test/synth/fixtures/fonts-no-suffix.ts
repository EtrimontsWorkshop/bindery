import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const BASE_FONT_NAMES = ['Autobahn', 'DwarvenAxeBB', 'Bookmania'];

/**
 * 3 embedded fonts with names WITHOUT weight suffixes (weight suffixes differ between foundries
 * and are an unbounded set — the layout engine must build a role ranking from frequency/size
 * alone, not by parsing the name). All three use the same TTF bytes (Lato-Regular) — we don't test
 * the real glyph shapes here, only what pdf.js returns as the font name.
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
    cs.showTextHex(asciiCodes(`Sample text in ${BASE_FONT_NAMES[i]}`));
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
