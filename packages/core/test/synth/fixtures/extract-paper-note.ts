import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';
import { imageXObject, solidRgb } from '../images.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');

/** The note's paper on the page: flush with the left edge (1.5pt over it), 451.5pt wide, 150pt high. */
export const NOTE_BOX = { minX: -1.5, minY: 600, maxX: 450, maxY: 750 };
/** The text the page writes on the note, per page: two lines along its top edge and one along its foot, its middle left blank. */
export const NOTE_TEXT = [
  ['First note, first line of text along the top edge of the paper card.', 'First note, second line of text, still near the top edge of the card.', 'First note, last line of text, written along the foot of the card.'],
  ['Second note, a different first line along the top edge of the same paper.', 'Second note, another second line, also near the top edge of the card.', 'Second note, its own last line, written along the foot of the card.'],
];

/** The colour of the note's paper. */
export const PAPER_RGB = [238, 222, 200] as const;

/**
 * Two pages, each with a note: the SAME plain paper raster (one PDF object, as a book reuses its note paper) placed
 * flush with the left edge, and lines of text that the page writes along its edges — different on each page. The raster is
 * blank paper; the notes are the paper with their text. Each page also has a paragraph of text away from the note.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = NOTE_TEXT.map(() => writer.reserveObj());
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes: readFileSync(FONT_PATH), toUnicode: asciiIdentityMap() });
  const paperRef = imageXObject(writer, { width: 150, height: 50, rgb: solidRgb(150, 50, ...PAPER_RGB) });

  NOTE_TEXT.forEach((lines, p) => {
    const cs = new ContentStreamBuilder();
    const w = NOTE_BOX.maxX - NOTE_BOX.minX;
    const h = NOTE_BOX.maxY - NOTE_BOX.minY;
    cs.save().cm(w, 0, 0, h, NOTE_BOX.minX, NOTE_BOX.minY).doXObject('Paper').restore();
    const baselines = [NOTE_BOX.maxY - 10, NOTE_BOX.maxY - 22, NOTE_BOX.minY + 3];
    lines.forEach((line, i) => {
      cs.beginText().setFont('F1', 10).setTextMatrix(1, 0, 0, 1, 8, baselines[i]!).showTextHex(asciiCodes(line)).endText();
    });
    for (let i = 0; i < 12; i++) {
      cs.beginText().setFont('F1', 10).setTextMatrix(1, 0, 0, 1, 72, 420 - i * 14).showTextHex(asciiCodes('A paragraph of the page, away from the note.')).endText();
    }
    const contentRef = writer.addStreamObj('', cs.toBuffer());
    writer.writeObj(
      pageRefs[p]!,
      pageDict({
        parentRef: pagesRef,
        mediaBox: [0, 0, 612, 792],
        contentsRef: contentRef,
        resourcesInner: `/Font << /F1 ${fontRef} 0 R >> /XObject << /Paper ${paperRef} 0 R >>`,
      }),
    );
  });

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));
  return writer.finish(catalogRef);
}
