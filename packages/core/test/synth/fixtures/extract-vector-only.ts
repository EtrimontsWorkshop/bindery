import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';

/**
 * Mapa "rysowana wektorowo" — duzy prostokat wypelniony (>=40% strony), ZERO
 * obrazow na calej stronie. Testuje fallback renderu regionu (Z2/Z3): jedyny
 * sposob na wyciagniecie czegokolwiek, gdy nie ma obrazu do ekstrakcji
 * bezposredniej (brief: "region wektorowy bez obrazu -> render regionu").
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const content = new ContentStreamBuilder().raw('56 96 500 600 re').raw('f').toBuffer();
  const contentRef = writer.addStreamObj('', content);

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
