import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder, asciiCodes } from '../contentStream.js';
import { embedFont, asciiIdentityMap } from '../fonts.js';
import { imageXObject } from '../images.js';

const FONT_PATH = join(import.meta.dirname, '..', 'assets', 'fonts', 'Lato-Regular.ttf');
/** The line of text under the chapter picture of every page: 12pt at (72, 400). */
export const TEXT_LINE = { text: 'Chapter text', size: 12, x: 72, y: 400 };

export const PAGE_COUNT = 5;
const WIDTH = 64;
const HEIGHT = 48;

/** Which of the 16 blocks are light, per variant: any two layouts differ in at least 8 blocks. */
const LAYOUTS = [0x0f0f, 0x3c3c, 0xa5a5, 0xf00f, 0x6996, 0xcc33];

/** A picture whose content depends on `variant`: a 4×4 board of light and dark blocks, laid out differently for each variant. */
function patternRgb(variant: number): Buffer {
  const buf = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const block = Math.floor(y / (HEIGHT / 4)) * 4 + Math.floor(x / (WIDTH / 4));
      const on = ((LAYOUTS[variant]! >> block) & 1) === 1;
      const i = (y * WIDTH + x) * 3;
      buf[i] = on ? 235 : 15;
      buf[i + 1] = on ? 220 : 25;
      buf[i + 2] = on ? 200 : 40;
    }
  }
  return buf;
}

/**
 * Five pages of one layout template, each embedding its OWN image objects (so pdf.js gives them different objIds) in
 * two slots of the same size and place on every page:
 * - the top slot holds a DIFFERENT picture on every page (a chapter illustration in the slot of a chapter opening);
 * - the bottom slot holds the SAME picture on every page, embedded again each time (a running ornament).
 * Only the bottom ones are one resource; the top ones must not be linked by their common position. Every page also
 * has one line of text (`TEXT_LINE`) between the two slots.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = Array.from({ length: PAGE_COUNT }, () => writer.reserveObj());
  const fontRef = embedFont(writer, { baseFont: 'TestSans', ttfBytes: readFileSync(FONT_PATH), toUnicode: asciiIdentityMap() });

  for (let p = 0; p < PAGE_COUNT; p++) {
    const chapterRef = imageXObject(writer, { width: WIDTH, height: HEIGHT, rgb: patternRgb(p) });
    const ornamentRef = imageXObject(writer, { width: WIDTH, height: HEIGHT, rgb: patternRgb(PAGE_COUNT) });

    const cs = new ContentStreamBuilder();
    cs.save().cm(560, 0, 0, 280, 26, 490).doXObject('Chapter').restore();
    cs.save().cm(120, 0, 0, 40, 246, 30).doXObject('Ornament').restore();
    cs.beginText().setFont('F1', TEXT_LINE.size).setTextMatrix(1, 0, 0, 1, TEXT_LINE.x, TEXT_LINE.y).showTextHex(asciiCodes(TEXT_LINE.text)).endText();
    const contentRef = writer.addStreamObj('', cs.toBuffer());

    writer.writeObj(
      pageRefs[p]!,
      pageDict({
        parentRef: pagesRef,
        mediaBox: [0, 0, 612, 792],
        contentsRef: contentRef,
        resourcesInner: `/Font << /F1 ${fontRef} 0 R >> /XObject << /Chapter ${chapterRef} 0 R /Ornament ${ornamentRef} 0 R >>`,
      }),
    );
  }

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}
