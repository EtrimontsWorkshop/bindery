import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { embedFont } from '../fonts.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

const CODE_DECOMPOSED_L = 0x10; // -> "l" + U+0335 (combining short stroke overlay) — namiastka "ł" nie-NFC
const CODE_PRECOMPOSED_L = 0x11; // -> U+0142 "ł" wprost (NFC)

/**
 * "Siła" jako l + znak laczacy (namiastka nie-NFC — MDD F0/KROK-3), obok wersji
 * juz znormalizowanej NFC. Testuje normalizacje NFC (faza 2, krok 1) i detektor
 * jakosci (combiningCharCount z src/quality.ts).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const toUnicode = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) toUnicode.set(c, String.fromCharCode(c));
  toUnicode.set(CODE_DECOMPOSED_L, `l̵`);
  toUnicode.set(CODE_PRECOMPOSED_L, `ł`);

  const ttfBytes = readFileSync(FONT_PATH);
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes, toUnicode });

  const cs = new ContentStreamBuilder().beginText().setFont('F1', 14);
  // "Si" + [decomposed l] + "a" -> "Sil̵a", odczytywane jako "Siła" nie w NFC
  cs.setTextMatrix(1, 0, 0, 1, 72, 700);
  cs.showTextHex([0x53, 0x69, CODE_DECOMPOSED_L, 0x61]);
  // "Si" + [precomposed l] + "a" -> "Siła", "Siła" juz w NFC
  cs.setTextMatrix(1, 0, 0, 1, 72, 670);
  cs.showTextHex([0x53, 0x69, CODE_PRECOMPOSED_L, 0x61]);
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
