import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');

// Konwencja subsettingu PDF: 6 wielkich liter + "+" + nazwa rodziny (MDD F0, Q1).
const BASE_FONT_NAMES = ['AAAAAH+Bookmania-Bold', 'BKQRXG+MinionPro-It', 'ZZZZZZ+QuadratSerial-PL'];

/**
 * Fonty z prefiksem subsetu w /BaseFont — dokladnie konwencja zaobserwowana w
 * fazie 0 (spike) na realnych PDF-ach. Testuje: silnik fazy 2 musi zdejmowac
 * pierwsze 6 znakow + "+" przy budowie klucza fontu, inaczej ten sam font uzyty
 * w dwoch dokumentach (z roznym losowym prefiksem) wyglada jak dwa rozne fonty.
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
