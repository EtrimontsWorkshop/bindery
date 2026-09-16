import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');
const GAP = 30; // >= ok. 20pt przy 12pt foncie wymusza syntetyczny item spacji (patrz ponizej)

/**
 * Itemy nietrescowe (str.length <= 1, tu: pojedyncza spacja) przeplecione z
 * realnym tekstem. Testuje filtrowanie takich itemow PRZED liczeniem statystyk
 * (faza 2, krok 5).
 *
 * WAZNE ODKRYCIE (patrz RAPORT-KROK-3.md): oryginalny plan tego fixture'a
 * zakladal itemy o str DOKLADNIE "" (jak w realnych PDF-ach ze spike'u fazy 0).
 * Nie udalo sie tego zbudowac syntetycznie: pdf.js resolvuje kazdy znak przez
 * `this.toUnicode.get(charcode) || charcode` (pdf.worker.mjs, Font#_charToGlyph)
 * — pusty string "" jest falsy w JS, wiec mapowanie ToUnicode na "" jest
 * ignorowane i pdf.js cicho wraca do surowego kodu znaku zamiast pustego stringa.
 * Sprawdzono rowniez calkowicie pusty operator Tj (`<> Tj`) — pdf.js nie tworzy
 * dla niego zadnego itemu (ani pustego, ani zadnego innego).
 *
 * Zamiast tego fixture testuje NAJBLIZSZY realnie osiagalny odpowiednik: itemy
 * spacji, ktore pdf.js SAM wstawia miedzy tokenami o duzym odstepie na tej
 * samej linii. To ten sam wymog inzynierski (filtrowanie przed statystykami
 * fragmentacji), inna dokladna wartosc str.
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
