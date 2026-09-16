import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const CODE_FI = 0x12; // -> U+FB01 ligatura "fi"
const CODE_FL = 0x13; // -> U+FB02 ligatura "fl"

/**
 * Ligatury U+FB01/U+FB02 (nierozwiniete — widoczne tylko z disableNormalization:true,
 * dokladnie jak w metodyce fazy 0) oraz wyraz przeniesiony lacznikiem na koncu
 * linii. Testuje rozwijanie ligatur i sklejanie przeniesien (faza 2, krok 1).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const toUnicode = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) toUnicode.set(c, String.fromCharCode(c));
  toUnicode.set(CODE_FI, 'ﬁ');
  toUnicode.set(CODE_FL, 'ﬂ');

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 14);
  // "of" + fi + "ce" -> "office" z ligatura fi
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex([0x6f, 0x66, CODE_FI, 0x63, 0x65]);
  // fl + "ame" -> "flame" z ligatura fl
  cs.setTextMatrix(1, 0, 0, 1, 72, 670);
  cs.showTextHex([CODE_FL, ...asciiCodes('ame')]);
  // wyraz przeniesiony lacznikiem na koncu linii: "encyclo-" / "pedia"
  cs.setTextMatrix(1, 0, 0, 1, 72, 640);
  cs.showTextHex(asciiCodes('encyclo-'));
  cs.setTextMatrix(1, 0, 0, 1, 72, 620);
  cs.showTextHex(asciiCodes('pedia'));
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
