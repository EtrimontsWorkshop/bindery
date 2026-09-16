import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const WHOLE_WORDS = Array.from({ length: 40 }, (_, i) => `word${i}`);
const SINGLE_CHARS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']; // 10 znakow

/**
 * ~20% itemow krotszych niz 3 znaki — dolny kraniec zakresu ze spike'u fazy 0
 * (Q6: 20-76%). Kazdy token dostaje wlasny wiersz (patrz text-fragmented-75.ts —
 * unika syntetycznych itemow spacji miedzy tokenami na tej samej linii).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 8);
  let y = 780;
  const allTokens: string[] = [...WHOLE_WORDS];
  for (let i = 0; i < SINGLE_CHARS.length; i++) {
    allTokens.splice((i + 1) * 4 + i, 0, SINGLE_CHARS[i]!);
  }
  for (const token of allTokens) {
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(token));
    y -= 9;
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
