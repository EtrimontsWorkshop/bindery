import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/**
 * Identyczny str+transform powtorzony 2x (dokladny duplikat pozycyjny) oraz
 * duplikat przesuniety o 0.3pt (kandydat na syntetyczne pogrubienie — MDD F0,
 * §5.1 syntheticBold). Testuje deduplikacje w fazie 2, krok 5.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode: asciiIdentityMap() });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 14);

  // Wiersz 1: dokladny duplikat — identyczny str + identyczna macierz transform.
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex(asciiCodes('Goblin'));
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex(asciiCodes('Goblin'));

  // Wiersz 2: duplikat przesuniety o 0.3pt — syntetyczne pogrubienie (podwojny
  // druk z minimalnym przesunieciem, powszechna sztuczka bez prawdziwego bold).
  cs.setTextMatrix(1, 0, 0, 1, 72, 670);
  cs.showTextHex(asciiCodes('Orc'));
  cs.setTextMatrix(1, 0, 0, 1, 72.3, 670);
  cs.showTextHex(asciiCodes('Orc'));

  // Wiersz 3: kontrolny, unikalny tekst bez duplikatu.
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
