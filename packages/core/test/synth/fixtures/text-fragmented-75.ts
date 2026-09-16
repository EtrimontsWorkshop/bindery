import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const WHOLE_WORDS = ['the', 'and', 'run', 'big', 'red', 'sky', 'day', 'old', 'new', 'sun'];
const FRAGMENTED_CHARS = 'dogcatbathatjampotsittopwetzip'.split(''); // 30 znakow

/**
 * ~75% itemow krotszych niz 3 znaki — gorny kraniec zakresu ze spike'u fazy 0
 * (Q6: 20-76%). Kazdy token dostaje WLASNY wiersz (osobne Y) — pdf.js wstawia
 * syntetyczne itemy spacji TYLKO miedzy tokenami na tej samej linii (patrz
 * RAPORT-KROK-3.md, "Napotkane pulapki"); jeden token per wiersz daje w pelni
 * przewidywalna, dokladnie kontrolowana liczbe itemow.
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
