import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * Tekst poziomy (strumien podstawowy) + pionowy pasek na marginesie (~50%
 * itemow pod 90°). Testuje kubelkowanie po kacie PRZED czymkolwiek innym
 * (MDD F0, §5.1) — bez tego tekst pionowy rozwala histogram kolumn.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const mainLines = ['Chapter One', 'The journey begins', 'in a quiet village', 'near the old forest', 'where shadows linger'];
  const sidebarLines = ['Sidebar note', 'See page twelve', 'for more detail', 'on this creature', 'and its habits'];

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 12);
  // strumien podstawowy — poziomy, 0°
  let y = 750;
  for (const line of mainLines) {
    cs.setTextMatrix(1, 0, 0, 1, 72, y);
    cs.showTextHex(asciiCodes(line));
    y -= 20;
  }
  // pasek boczny — pionowy, 90° (macierz "0 1 -1 0 x y Tm" z szpargalki)
  let sy = 200;
  for (const line of sidebarLines) {
    cs.setTextMatrix(0, 1, -1, 0, 560, sy);
    cs.showTextHex(asciiCodes(line));
    sy += 100;
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
