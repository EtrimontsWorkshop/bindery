import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { solidRgb } from '../images.js';

/**
 * Obraz inline (BI/ID/EI) — jedyny fixture przechodzacy `paintInlineImageXObject`
 * przez PRAWDZIWY pdf.js (KROK-6 Z1c). Brak referencji do obiektu PDF (dane
 * wprost w strumieniu tresci), stad KROK-4 ustalilo empirycznie: ten opcode
 * NIGDY nie ma objId — `extractImageObjId` zwraca dla niego zawsze null.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const cs = new ContentStreamBuilder()
    .save()
    .cm(100, 0, 0, 100, 50, 600)
    .inlineImage('/W 2 /H 2 /BPC 8 /CS /RGB', solidRgb(2, 2, 200, 30, 30))
    .restore();
  const contentRef = writer.addStreamObj('', cs.toBuffer());

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: '',
    }),
  );

  return writer.finish(catalogRef);
}
